/**
 * Phase 15 —— 请求前置开销分解（只读）。
 *
 * ## 待解释的观测
 *
 * `_verify_latency_breakdown.mts` 实测：从请求发出到**第一个 SSE 事件**
 * 之间有 5.5 s（工具类）到 10.2 s（纯对话）的空白，而
 * `/api/health` 报 `runtime.latencyMs = 4`。两者不能同时说明"运行时很慢"。
 *
 * 这段空白由三部分组成，必须分开测：
 *
 *   a) 直连运行时 `/api/health` 的往返（**已热的进程**）
 *   b) 连续两次请求的"首事件耗时"对比 —— 若第二次显著变快，说明含**冷启动**
 *   c) 运行时侧的 agent 构造 / 工具解析开销（容器内直接量）
 *
 * 本脚本分别量 a、b、c，不做推测。
 */
import { execFileSync } from 'node:child_process';

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.17';
const EMAIL = process.env.E2E_EMAIL ?? 'houjinlong258@gmail.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Rove@2026';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login HTTP ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** 返回「请求发出 → 首个 SSE 事件」的毫秒数与首个事件名 */
async function firstEventMs(cookie: string, message: string): Promise<{ ms: number; label: string; status: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({ message, locale: 'en' }),
  });
  if (res.status !== 200 || !res.body) return { ms: Date.now() - t0, label: `HTTP ${res.status}`, status: res.status };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const ms = Date.now() - t0;
      void reader.cancel();
      try {
        const ev = JSON.parse(payload) as { type?: string; phase?: string };
        return { ms, label: `${ev.type}${ev.phase ? '/' + ev.phase : ''}`, status: 200 };
      } catch {
        return { ms, label: '(unparsed)', status: 200 };
      }
    }
  }
  return { ms: Date.now() - t0, label: '(stream ended)', status: 200 };
}

function runtimeHealthDetailMs(): { ms: number; body: string } {
  const script = `
import os, time, json, urllib.request
key = os.environ.get('ROVEAGENT_API_KEY','')
t0 = time.time()
req = urllib.request.Request('http://127.0.0.1:8788/api/health', headers={'X-RoveAgent-Key': key})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode()
    print(json.dumps({'ms': round((time.time()-t0)*1000, 1), 'body': body[:200]}))
except Exception as e:
    print(json.dumps({'ms': round((time.time()-t0)*1000, 1), 'body': 'ERR %s' % e}))
`;
  const t0 = Date.now();
  const out = execFileSync('docker', ['exec', 'roveframe-roveagent-1', 'python3', '-c', script], {
    encoding: 'utf8', timeout: 120_000,
  });
  return { ms: Date.now() - t0, body: out.trim() };
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — 请求前置开销分解');
  console.log('='.repeat(78));
  console.log('');

  // ---- a) 容器内直连运行时 /api/health（进程内往返） ----------------------
  console.log('[a] 运行时 /api/health（容器内 python 直连 127.0.0.1:8788）:');
  for (let i = 1; i <= 3; i += 1) {
    const r = runtimeHealthDetailMs();
    console.log(`    第 ${i} 次: 进程内测量 ${r.ms} ms（含 docker exec 启动开销）  ${r.body}`);
  }
  console.log('');

  // ---- b) 连续两次请求的首事件耗时 ---------------------------------------
  console.log('[b] 首事件耗时：连续两次同构请求（看是否有冷/热差异）');
  const cookie = await login();
  const A1 = await firstEventMs(cookie, 'Say hello in one short sentence.');
  console.log(`    第 1 次: ${A1.ms} ms → 首事件 ${A1.label}`);
  const A2 = await firstEventMs(cookie, 'Say hello again in one short sentence.');
  console.log(`    第 2 次: ${A2.ms} ms → 首事件 ${A2.label}`);
  console.log(`    差值: ${A2.ms - A1.ms} ms ${A2.ms < A1.ms * 0.7 ? '（第二次显著更快 ⇒ 含冷启动/缓存效应）' : '（无明显冷热差异）'}`);
  console.log('');

  // ---- c) 容器内 agent 构造与工具解析耗时 --------------------------------
  console.log('[c] 容器内 agent 构造 / 工具解析开销:');
  const probe = `
import sys, time, json
sys.path.insert(0, '/app')
out = {}
t0 = time.time()
try:
    from roveagent.toolsets import resolve_toolsets_for_request
    out['import_toolsets_ms'] = round((time.time()-t0)*1000, 1)
    t1 = time.time()
    tools = resolve_toolsets_for_request('ceo')
    out['resolve_toolsets_ms'] = round((time.time()-t1)*1000, 1)
    out['tool_count'] = len(tools) if hasattr(tools, '__len__') else 'n/a'
except Exception as e:
    out['toolsets_error'] = '%s: %s' % (type(e).__name__, e)
print(json.dumps(out, ensure_ascii=False))
`;
  try {
    const out = execFileSync('docker', ['exec', 'roveframe-roveagent-1', 'python3', '-c', probe], {
      encoding: 'utf8', timeout: 180_000,
    });
    console.log(`    ${out.trim()}`);
  } catch (err) {
    console.log(`    探测失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');

  console.log('='.repeat(78));
  console.log('判读:');
  console.log('  · [a] 若进程内往返是毫秒级，则 "运行时慢" 不能解释 [b] 的首事件延迟；');
  console.log('  · [b] 两次之差是冷启动成本，绝对值减去它才是真正的"模型首 token"时间；');
  console.log('  · [c] 给出 agent 构造与工具解析的量级，判断它是否值得优化。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('分解崩溃:', error); process.exitCode = 2; });
