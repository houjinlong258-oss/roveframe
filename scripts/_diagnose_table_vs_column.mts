/**
 * Phase 15 — 诊断：`select('business_id')` 的错误到底在说什么（只读）。
 *
 * ## 待解释的矛盾
 *
 * 同一批表名，两个脚本给出相反结论：
 *
 *   - `_verify_data_drift.mts` 对 `documents` / `suppliers` / `purchase_orders` /
 *     `marketing_campaigns` 报 "Could not find the table 'public.<name>' in the schema cache"
 *     —— 而且它**确实打印出了 error.message**，说明取错误值的写法没问题；
 *   - `_verify_real_database.mts` / `_verify_table_probe_control.mts` 对同名表报 OK。
 *
 * 两者的差别只有一处：前者带了 `.eq('business_id', …)` 过滤，后者没有。
 *
 * ## 假设与检验
 *
 * 假设：PostgREST 在**被过滤/投影的列不存在**时，也会报
 * "Could not find the table ... in the schema cache"，把"列缺失"说成了"表缺失"。
 * 若成立，则那四张表真实存在，只是**没有 `business_id` 列**。
 *
 * 检验：对每张表只用无过滤的 `select('business_id')`（投影一个具体列）。
 * 列存在 → 成功；列不存在 → 报错，且看错误文本是否与"表缺失"同形。
 * 同时用无过滤 `select('*', head)` 作对照：若同一张表在这里成功，则"表缺失"必为误报。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: () => unknown;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => unknown } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const TABLES = [
  'documents', 'suppliers', 'purchase_orders', 'marketing_campaigns',
  'knowledge_docs', 'marketing_contents', 'inventory_items', 'agent_tasks',
] as const;

function msg(err: unknown): string {
  if (!err) return '-';
  if (typeof err === 'string') return err;
  const e = err as { message?: string; code?: string; details?: string };
  return [e.code, e.message, e.details].filter(Boolean).join(' | ');
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const from = (t: string) => (client as { from(x: string): unknown }).from(t);
  const sel = (t: string, cols: string, opts?: unknown) =>
    (from(t) as { select(c: string, o?: unknown): Promise<{ error?: unknown; status?: number }> })
      .select(cols, opts);

  console.log('='.repeat(78));
  console.log('Phase 15 — 诊断: "Could not find the table" 是表缺失还是列缺失');
  console.log('='.repeat(78));
  console.log('');
  console.log(`${'table'.padEnd(22)} ${'select(*)'.padEnd(12)} ${'select(business_id)'}`);
  console.log('-'.repeat(78));

  for (const t of TABLES) {
    let starResult: string;
    try {
      const r = await sel(t, '*', { count: 'exact', head: true });
      starResult = r.error ? `ERR(${msg(r.error).slice(0, 30)})` : `OK(status=${r.status})`;
    } catch (e) { starResult = `THREW ${msg(e).slice(0, 30)}`; }

    let colResult: string;
    try {
      const r = await sel(t, 'business_id');
      colResult = r.error ? `ERR | ${msg(r.error)}` : 'OK 列存在';
    } catch (e) { colResult = `THREW | ${msg(e)}`; }

    console.log(`${t.padEnd(22)} ${starResult.padEnd(12)} ${colResult}`);
  }

  console.log('');
  console.log('判定规则：若 select(*) 为 OK 而 select(business_id) 报');
  console.log('"Could not find the table ... in the schema cache"，则该表存在、');
  console.log('缺的是 business_id 列，Phase 15 取证脚本 §4 的那几条 ERR 属误报。');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('诊断崩溃:', error); process.exitCode = 2; });
