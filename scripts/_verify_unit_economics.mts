/**
 * Phase 15 — 单位经济性与任务积压取证（只读）。
 *
 * ## 为什么查这个
 *
 * 前面的审计全是"能不能跑"，没有一项回答"跑起来划不划算"。
 * 这两件事决定一门生意能不能成立：
 *
 *   1. **单位经济性**：一次对话调用上游模型多少次、每次多少 token。
 *      如果单次对话成本高于客单价能覆盖的水平，产品越成功亏得越多。
 *   2. **任务积压**：`agent_tasks` 此前实测有 10 行 `active`。
 *      如果任务只进不出，说明 worker 没有真正消费队列 —— 那是"看着在跑、
 *      实际不干活"，属于本项目最忌讳的假实现。
 *
 * ## 本脚本只读
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const sel = (t: string, c: string) =>
    (client as unknown as {
      from(x: string): { select(cc: string): { limit(n: number): Promise<Res> } };
    }).from(t).select(c).limit(5000);

  console.log('='.repeat(80));
  console.log('Phase 15 — 单位经济性与任务积压（只读）');
  console.log('='.repeat(80));

  // ---- 1. AI 用量账本 -----------------------------------------------------
  const { data: usage, error: ue } = await sel(
    'ai_usage_ledger',
    'id, status, model, provider, input_tokens, output_tokens, latency_ms, created_at, agent',
  );
  if (ue) { console.log(`ai_usage_ledger 读取失败: ${ue.message}`); return 2; }
  const rows = usage ?? [];

  console.log('');
  console.log(`[1] ai_usage_ledger 共 ${rows.length} 行`);
  if (rows.length > 0) {
    console.log(`    列: ${Object.keys(rows[0]).join(', ')}`);

    const withTokens = rows.filter((r) => r.input_tokens !== null || r.output_tokens !== null);
    console.log(`    含 token 计数的行: ${withTokens.length}/${rows.length}`);
    if (withTokens.length > 0) {
      const sumIn = withTokens.reduce((a, r) => a + Number(r.input_tokens ?? 0), 0);
      const sumOut = withTokens.reduce((a, r) => a + Number(r.output_tokens ?? 0), 0);
      console.log(`    token 合计: input=${sumIn} output=${sumOut}（仅统计 ${withTokens.length} 行）`);
      console.log(`    平均每次: input=${Math.round(sumIn / withTokens.length)} output=${Math.round(sumOut / withTokens.length)}`);
    } else {
      console.log('    ** 没有任何一行带 token 计数 —— 单位成本无法从账本算出 **');
    }

    // 按 agent / provider 分组
    const by = (key: string) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = String(r[key] ?? '(null)');
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    console.log(`    按 agent 分组: ${JSON.stringify(by('agent'))}`);
    console.log(`    按 provider 分组: ${JSON.stringify(by('provider'))}`);
    console.log(`    按 status 分组: ${JSON.stringify(by('status'))}`);

    const withLatency = rows.filter((r) => r.latency_ms !== null);
    if (withLatency.length > 0) {
      const lats = withLatency.map((r) => Number(r.latency_ms)).sort((a, b) => a - b);
      const p = (q: number) => lats[Math.min(lats.length - 1, Math.floor(lats.length * q))];
      console.log(`    延迟分位: p50=${p(0.5)}ms p90=${p(0.9)}ms p99=${p(0.99)}ms max=${lats[lats.length - 1]}ms`);
    }

    const times = rows.map((r) => String(r.created_at ?? '')).filter(Boolean).sort();
    if (times.length > 0) {
      console.log(`    时间跨度: ${times[0]} → ${times[times.length - 1]}`);
    }
  }

  // ---- 2. 一次对话 = 多少次模型调用 ---------------------------------------
  const { data: sessions } = await sel('chat_sessions', 'id, created_at');
  console.log('');
  console.log(`[2] chat_sessions 共 ${(sessions ?? []).length} 个会话`);
  if (rows.length > 0 && (sessions ?? []).length > 0) {
    console.log(`    账本行/会话 ≈ ${(rows.length / (sessions ?? []).length).toFixed(1)}（每次对话的模型调用次数量级）`);
  }

  // ---- 3. 任务积压 --------------------------------------------------------
  const { data: tasks, error: te } = await sel(
    'agent_tasks', 'id, status, name, created_at, updated_at, next_run_at, attempts',
  );
  console.log('');
  if (te) { console.log(`agent_tasks 读取失败: ${te.message}`); return 2; }
  const taskRows = tasks ?? [];
  console.log(`[3] agent_tasks 共 ${taskRows.length} 行`);
  const byStatus = new Map<string, Row[]>();
  for (const r of taskRows) {
    const k = String(r.status ?? '(null)');
    if (!byStatus.has(k)) byStatus.set(k, []);
    byStatus.get(k)!.push(r);
  }
  for (const [status, list] of [...byStatus.entries()].sort()) {
    console.log(`    status=${status}: ${list.length} 行`);
  }
  console.log('');
  console.log('    明细（最多 12 行）:');
  for (const r of taskRows.slice(0, 12)) {
    console.log(`      ${String(r.status).padEnd(10)} name=${String(r.name).slice(0, 28).padEnd(28)} attempts=${String(r.attempts ?? '-').padEnd(4)} created=${String(r.created_at).slice(0, 19)} next_run=${String(r.next_run_at ?? '-').slice(0, 19)}`);
  }

  // 判断"只进不出"：看 created 与 updated 是否几乎相同、attempts 是否为 0
  const neverTouched = taskRows.filter((r) => Number(r.attempts ?? 0) === 0);
  console.log('');
  console.log(`    attempts=0 的行: ${neverTouched.length}/${taskRows.length}`);

  console.log('');
  console.log('='.repeat(80));
  console.log('判读:');
  console.log('  · 账本无 token 列有值 ⇒ 单位成本**当前无法测量**（不是"便宜"）');
  console.log('  · agent_tasks 里 attempts=0 且长期停在 active ⇒ worker 未真正消费队列');
  console.log('='.repeat(80));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
