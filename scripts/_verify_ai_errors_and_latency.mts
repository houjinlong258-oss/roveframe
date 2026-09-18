/**
 * Phase 15 — AI 错误构成与延迟尾部取证（只读）。
 *
 * `_verify_unit_economics.mts` 报：170 次账本记录里 31 次 status=error（18%），
 * 且延迟 p99=60974ms、max=89036ms。这两个数字都有可能被误读：
 *
 *   · 错误率高可能是**一次性的账户问题**（DeepSeek 余额不足 → 402）
 *     被重复计数，而不是"系统不稳定"；
 *   · 尾部延迟可能集中在**特定 agent**（如 tool-planning 的多次往返），
 *     而不是普遍现象。
 *
 * 因此本脚本把两者都按维度拆开，再决定要不要当成问题。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const { data, error } = await (client as unknown as {
    from(t: string): { select(c: string): { limit(n: number): Promise<Res> } };
  }).from('ai_usage_ledger').select('status, agent, provider, model, latency_ms, input_tokens, output_tokens, created_at').limit(5000);
  if (error) { console.log(`读取失败: ${error.message}`); return 2; }
  const rows = data ?? [];

  console.log('='.repeat(84));
  console.log('Phase 15 — AI 错误构成与延迟尾部');
  console.log('='.repeat(84));

  // ---- 1. 错误按 agent / provider / 时间分组 ------------------------------
  const errs = rows.filter((r) => String(r.status) === 'error');
  console.log('');
  console.log(`[1] status=error 共 ${errs.length}/${rows.length} 行`);

  const group = (list: Row[], key: string) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(String(r[key] ?? '(null)'), (m.get(String(r[key] ?? '(null)')) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log(`    按 agent:    ${JSON.stringify(group(errs, 'agent'))}`);
  console.log(`    按 provider: ${JSON.stringify(group(errs, 'provider'))}`);

  // 错误的时间分布：按小时看是"持续失败"还是"一段时间集中失败"
  const byHour = new Map<string, number>();
  for (const r of errs) {
    const h = String(r.created_at ?? '').slice(0, 13); // YYYY-MM-DDTHH
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }
  const hours = [...byHour.entries()].sort();
  console.log(`    错误时间分布（${hours.length} 个不同小时）:`);
  for (const [h, n] of hours) console.log(`      ${h}h  ${'#'.repeat(Math.min(n, 40))} ${n}`);

  // ---- 2. 成功行的延迟分布 ------------------------------------------------
  const okRows = rows.filter((r) => String(r.status) === 'ok' && r.latency_ms !== null);
  console.log('');
  console.log(`[2] status=ok 且有延迟的行 ${okRows.length} 行`);

  const quantiles = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
  };

  console.log(`    全体: ${JSON.stringify(quantiles(okRows.map((r) => Number(r.latency_ms))))}`);

  // 按 agent 分开看 —— 尾部是否集中在某类调用
  const byAgent = new Map<string, number[]>();
  for (const r of okRows) {
    const k = String(r.agent ?? '(null)');
    if (!byAgent.has(k)) byAgent.set(k, []);
    byAgent.get(k)!.push(Number(r.latency_ms));
  }
  console.log('');
  console.log(`    ${'agent'.padEnd(26)} ${'n'.padStart(5)}  ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`);
  console.log('    ' + '-'.repeat(70));
  for (const [k, v] of [...byAgent.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const q = quantiles(v);
    console.log(`    ${k.padEnd(26)} ${String(v.length).padStart(5)}  ${String(q.p50).padStart(8)} ${String(q.p90).padStart(8)} ${String(q.p99).padStart(8)} ${String(q.max).padStart(8)}`);
  }

  // ---- 3. 单次对话的真实成本量级 ------------------------------------------
  const withTokens = rows.filter((r) => r.input_tokens !== null);
  if (withTokens.length > 0) {
    const sumIn = withTokens.reduce((a, r) => a + Number(r.input_tokens ?? 0), 0);
    const sumOut = withTokens.reduce((a, r) => a + Number(r.output_tokens ?? 0), 0);
    const { data: sessions } = await (client as unknown as {
      from(t: string): { select(c: string): { limit(n: number): Promise<Res> } };
    }).from('chat_sessions').select('id').limit(5000);
    const nSessions = (sessions ?? []).length || 1;
    console.log('');
    console.log('[3] 单位成本量级');
    console.log(`    总 token: in=${sumIn} out=${sumOut}`);
    console.log(`    会话数: ${nSessions}`);
    console.log(`    每个会话约: in=${Math.round(sumIn / nSessions)} out=${Math.round(sumOut / nSessions)}`);
    // 粗算：以 $0.15/M in + $0.60/M out 的常见低价档为参照（仅量级参考，不是报价）
    const perSession = (sumIn / nSessions / 1e6) * 0.15 + (sumOut / nSessions / 1e6) * 0.60;
    console.log(`    按 \$0.15/M in + \$0.60/M out 粗算: 约 $${perSession.toFixed(4)}/会话（量级参考）`);
    console.log(`    若一个商家每月 300 次对话: 约 $${(perSession * 300).toFixed(2)}/月`);
  }

  console.log('');
  console.log('='.repeat(84));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
