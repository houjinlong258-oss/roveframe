/**
 * Phase 15 — 最终判定：`select('*', {count:'exact', head:true})` 是否为有效探针。
 *
 * ## 已知事实
 *
 * `_diagnose_table_vs_column.mts` 实测：
 *
 *   - 真实列存在的表（`knowledge_docs` 等）→ `status=200`
 *   - `documents` / `suppliers` / `purchase_orders` / `marketing_campaigns`
 *     → `status=204`，且对同名表做 `select('business_id')` 报 PGRST205
 *       "Could not find the table ... in the schema cache"
 *
 * 204 与 200 的区别说明这两组的响应不是一回事，但还不能断言 204 == "表不存在"：
 * 也可能 204 只是"HEAD 请求无 body"的正常表现。
 *
 * ## 判定方法（阳性/阴性对照）
 *
 * 用**同一个调用形态**跑三个确定性样本：
 *
 *   - 阴性样本：两个绝不可能存在的表名 → 若也是 204，则 204 不携带"存在"信息；
 *   - 阳性样本：`tenants`（确定存在、确定非空）→ 若也是 204，则 204 与存在性无关。
 *
 * 同时打印**原始响应头**（`content-range`），看 count 到底有没有算出来。
 * 如果两个对照与真实表无法区分，那么"某表存在"这个结论在形态上就不可能成立。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: () => unknown;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => unknown } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

type Res = {
  error?: { message?: string; code?: string } | null;
  status?: number;
  statusText?: string;
  count?: number | null;
  data?: unknown;
};

const SAMPLES: Array<{ table: string; expectation: string }> = [
  { table: 'tenants', expectation: '阳性对照：确定存在且非空' },
  { table: 'orders', expectation: '阳性对照：确定存在且非空' },
  { table: 'documents', expectation: '争议样本：schema.ts 无定义' },
  { table: 'knowledge_docs', expectation: '争议样本：schema.ts 有定义' },
  { table: 'zzz_definitely_not_a_table_9f3a', expectation: '阴性对照：绝不存在' },
  { table: 'public.also_not_real_7b1c', expectation: '阴性对照：绝不存在' },
];

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const from = (t: string) => (client as { from(x: string): unknown }).from(t);
  const sel = (t: string, cols: string, opts?: unknown) =>
    (from(t) as { select(c: string, o?: unknown): Promise<Res> }).select(cols, opts);

  console.log('='.repeat(78));
  console.log('Phase 15 — 探针有效性最终判定');
  console.log('='.repeat(78));
  console.log('');

  // ---- A. 主探针形态（Phase 14 用的那个） ---------------------------------
  console.log('[A] 形态 = select("*", {count:"exact", head:true})  ← Phase 14 主探针');
  console.log(`${'table'.padEnd(34)} ${'status'.padEnd(8)} ${'count'.padEnd(8)} ${'error'}`);
  console.log('-'.repeat(78));
  for (const s of SAMPLES) {
    const r = await sel(s.table, '*', { count: 'exact', head: true });
    console.log(
      `${s.table.padEnd(34)} ${String(r.status ?? '-').padEnd(8)} `
      + `${String(r.count ?? 'null').padEnd(8)} ${r.error ? (r.error.message ?? '').slice(0, 24) : '-'}`,
    );
  }

  // ---- B. 带投影的形态 ---------------------------------------------------
  console.log('');
  console.log('[B] 形态 = select("id")（带列投影，取真实行）');
  console.log(`${'table'.padEnd(34)} ${'status'.padEnd(8)} ${'rows'.padEnd(8)} ${'error'}`);
  console.log('-'.repeat(78));
  for (const s of SAMPLES) {
    const r = await sel(s.table, 'id');
    const rows = Array.isArray(r.data) ? r.data.length : '-';
    console.log(
      `${s.table.padEnd(34)} ${String(r.status ?? '-').padEnd(8)} `
      + `${String(rows).padEnd(8)} ${r.error ? (r.error.message ?? '').slice(0, 40) : '-'}`,
    );
  }

  // ---- C. 带投影 + 计数 --------------------------------------------------
  console.log('');
  console.log('[C] 形态 = select("id", {count:"exact"})（投影 + 计数，非 head）');
  console.log(`${'table'.padEnd(34)} ${'status'.padEnd(8)} ${'count'.padEnd(8)} ${'error'}`);
  console.log('-'.repeat(78));
  for (const s of SAMPLES) {
    const r = await sel(s.table, 'id', { count: 'exact' });
    console.log(
      `${s.table.padEnd(34)} ${String(r.status ?? '-').padEnd(8)} `
      + `${String(r.count ?? 'null').padEnd(8)} ${r.error ? (r.error.message ?? '').slice(0, 40) : '-'}`,
    );
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('判读：若 [A] 中阴性对照与阳性对照的 status/count 无法区分，');
  console.log('则 [A] 这一形态不能证明表存在，Phase 14 的 "33/33 存在" 不成立。');
  console.log('若 [C] 能区分，则 [C] 是可用探针。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('判定崩溃:', error); process.exitCode = 2; });
