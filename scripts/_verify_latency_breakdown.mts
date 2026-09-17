/**
 * Phase 15 —— 延迟分解（A-6 实测 49.1 s 需要拆开看）。
 *
 * ## 为什么用 SSE 事件时间戳
 *
 * A-6 只记录了"一次请求 49.1 s"这一个总数，无法回答"时间花在谁身上"。
 * 但 `/api/agent/chat` 是 SSE：`agentSseResponse` 把每个阶段都作为事件推出来
 * （`status/thinking`、`status/calling_tool`、`status/tool_done`、`delta`、`done`）。
 * 因此只要给**每个事件的到达时刻**打点，就能把一次请求切成互不重叠的区间：
 *
 *   T0 请求发出
 *   ├─ T1 首个事件到达            → 建连 + 认证 + 会话/历史/上下文查询（前置开销）
 *   ├─ T2 status/thinking         → 进入模型往返
 *   ├─ T3 status/calling_tool X   → 模型决定调用工具（一次 LLM 往返 + 工具派发）
 *   ├─ T4 status/tool_done   X    → 工具真正执行（读真实库）
 *   ├─ T5 delta…done              → 终稿生成
 *
 * 这些区间相加 ≈ 总耗时，可以判断瓶颈在 LLM 往返还是在工具还是在序列化。
 *
 * ## 对照
 *
 * 同时测两种请求，因为它们的路径不同：
 *   - 纯对话（不要求用工具）→ 分类为 chat，可走 Fast Path（不起 planner）
 *   - 工具类（明确要求用工具）→ 分类为 tool_execution，走 planner + 工具循环
 *
 * 只读：不改库，只发两次 chat。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    const value = bag?.[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(`cannot resolve export '${name}'`);
}

void resolveExport<unknown>(supabaseModule, 'getSupabaseClient');

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;

/**
 * 直连容器端口时没有反向代理，`x-forwarded-for` 缺失会让
 * `getClientIp()` 回落到字面量 'unknown'，使所有请求共用一个限流桶。
 * 显式给一个稳定测试 IP，让限流按"一个客户端"计数。
 */
const CLIENT_IP = '203.0.113.16';

interface SseEvent { type?: string; phase?: string; tool?: string; text?: string; [k: string]: unknown }

interface Span { at: number; label: string }

async function timedChat(email: string, password: string, message: string): Promise<{
  spans: Span[]; total: number; text: string; status: number;
}> {
  // 每次跑都用独立会话，通过登录拿 cookie，避免复用上一轮状态
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (login.status !== 200) {
    return { spans: [{ at: 0, label: `LOGIN_FAILED HTTP ${login.status}` }], total: 0, text: '', status: login.status };
  }

  const t0 = Date.now();
  const spans: Span[] = [];
  const res = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({ message, locale: 'en' }),
  });
  if (res.status !== 200 || !res.body) {
    return { spans: [{ at: Date.now() - t0, label: `HTTP ${res.status}` }], total: Date.now() - t0, text: '', status: res.status };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now() - t0;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev: SseEvent;
      try { ev = JSON.parse(payload) as SseEvent; } catch { continue; }
      if (ev.type === 'delta') { text += String(ev.text ?? ''); continue; }
      if (ev.type === 'status') {
        spans.push({ at: now, label: `status/${ev.phase}${ev.tool ? `:${ev.tool}` : ''}` });
      } else if (ev.type === 'runtime_status') {
        spans.push({ at: now, label: `runtime_status(${String(ev.mode)})` });
      } else if (ev.type === 'done') {
        spans.push({ at: now, label: 'done' });
      } else if (ev.type === 'error') {
        spans.push({ at: now, label: `ERROR ${String(ev.error).slice(0, 60)}` });
      }
    }
  }
  return { spans, total: Date.now() - t0, text, status: res.status };
}

function report(title: string, r: Awaited<ReturnType<typeof timedChat>>): void {
  console.log(`--- ${title} ---`);
  console.log(`  HTTP ${r.status}  总耗时 ${r.total} ms  正文 ${r.text.length} 字符`);
  console.log(`  事件时间线（相对 t0）:`);
  let prev = 0;
  for (const s of r.spans) {
    const delta = s.at - prev;
    const bar = delta > 2000 ? '  <== 主要耗时' : '';
    console.log(`    +${String(s.at).padStart(6)} ms  (Δ ${String(delta).padStart(6)} ms)  ${s.label}${bar}`);
    prev = s.at;
  }
  const tail = r.total - prev;
  console.log(`    尾部收尾（流关闭/落库）  Δ ${tail} ms`);
  console.log('');
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — 延迟分解（SSE 事件时间戳）');
  console.log('='.repeat(78));
  console.log(`目标 ${BASE}`);
  console.log('');

  // 复用 Phase 15 e2e 建的账号：用 owner 种子账号（已知可用且挂在 Default tenant，
  // 所以 read_orders 能读到真实种子数据）。
  const email = process.env.E2E_EMAIL ?? 'houjinlong258@gmail.com';
  const password = process.env.E2E_PASSWORD ?? 'Rove@2026';

  const chat = await timedChat(email, password, 'Give me a one-paragraph summary of how the business is doing.');
  report('对照 A：纯对话（分类为 chat，可走 Fast Path）', chat);

  const tool = await timedChat(email, password, 'How many orders are there? Use your tools to check the real data.');
  report('对照 B：工具类（分类为 tool_execution，走 planner + 工具循环）', tool);

  console.log('='.repeat(78));
  console.log('判读要点:');
  console.log('  · Δ 最大的区间就是瓶颈。若大块时间落在两个 calling_tool 之间，');
  console.log('    那是 LLM 往返；若落在 calling_tool → tool_done 之间，那是工具执行。');
  console.log('  · 纯对话与工具类的总耗时差 = 规划器 + 工具循环的净成本。');
  console.log(`  · 本次: 纯对话 ${chat.total} ms / 工具类 ${tool.total} ms`);
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('延迟分解崩溃:', error); process.exitCode = 2; });
