/**
 * Phase 15 — 真实库表结构核验（修正版，只读）。
 *
 * ## 取代 `_verify_real_database.mts` 的表存在性检查
 *
 * 旧脚本的表存在性探针形态为 `select('*', {count:'exact', head:true})`。
 * `_verify_probe_validity.mts` 的对照实验证明该形态**无法区分**"表存在"与
 * "表不存在"：
 *
 *     table                              status   count
 *     tenants                            200      3        <- 存在
 *     zzz_definitely_not_a_table_9f3a    204      null     <- 不存在，却也不报错
 *
 * 即 `head:true` 让 PostgREST 对不存在的表返回 204 而非 404，`error` 恒为空，
 * Phase 14 的 "33/33 存在" 因此不成立。
 *
 * ## 可用探针
 *
 * `select('id')`（带列投影、非 head）能区分三态：
 *
 *     200 -> 表存在（`count` 是真实行数）
 *     404 -> 表不存在（PGRST205）
 *
 * 本脚本即用此形态，核验 `schema.ts` 声明的**全部** 51 张表（旧脚本只查 33 个
 * 名字，其中 4 个在 schema.ts 里根本不存在，另有 22 张真实表从未被覆盖）。
 *
 * ## 只读
 *
 * 仅 `select`。无 insert / update / delete / ddl。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: () => unknown;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => unknown } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

type Res = { error?: { message?: string; code?: string } | null; status?: number; count?: number | null };

/** 从 schema.ts 原文抽取 pgTable 的表名 —— 独立于任何手写清单的真相来源。 */
function schemaTableNames(): string[] {
  const file = join(process.cwd(), 'src', 'storage', 'database', 'shared', 'schema.ts');
  const txt = readFileSync(file, 'utf8');
  const re = /pgTable\(\s*(?:"([a-z_]+)"|'([a-z_]+)'|`([a-z_]+)`)/g;
  const out = new Set<string>();
  for (const m of txt.matchAll(re)) out.add(m[1] || m[2] || m[3]);
  return [...out].sort();
}

/** 关键表的期望行数下限（种子数据）。0 表示"允许为空"。 */
const SEED_EXPECTATION: Record<string, number> = {
  tenants: 1, businesses: 1, users: 1, products: 1, customers: 1, orders: 1,
  doc_chunks: 1, knowledge_docs: 1, model_configs: 1,
};

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const probeWith = (t: string, cols: string, opts?: unknown) =>
    (client as { from(x: string): { select(c: string, o?: unknown): Promise<Res> } })
      .from(t).select(cols, opts);

  const declared = schemaTableNames();

  console.log('='.repeat(78));
  console.log('Phase 15 — 真实库表结构核验（修正版探针）');
  console.log('='.repeat(78));
  console.log(`schema.ts 声明 ${declared.length} 张表`);
  console.log('');

  // ---- 阴性对照：探针必须能败 --------------------------------------------
  console.log('[0] 阴性对照（必须 404）:');
  let controlOk = true;
  for (const s of ['zzz_definitely_not_a_table_9f3a', 'public.also_not_real_7b1c']) {
    const r = await probeWith(s, 'id');
    const is404 = r.status === 404;
    if (!is404) controlOk = false;
    console.log(`    ${s.padEnd(34)} status=${r.status}  ${is404 ? '✓ 按预期失败' : '✗ 未失败'}`);
  }
  const pos = await probeWith('tenants', 'id');
  if (pos.status !== 200) controlOk = false;
  console.log(`    ${'tenants'.padEnd(34)} status=${pos.status}  ${pos.status === 200 ? '✓ 阳性对照通过' : '✗ 阳性对照失败'}`);
  console.log(`    探针可信: ${controlOk ? '是' : '否 —— 以下结果作废'}`);
  if (!controlOk) return 2;
  console.log('');

  // ---- 逐表核验 ----------------------------------------------------------
  const present: Array<{ table: string; count: number; note: string }> = [];
  const missing: string[] = [];
  for (const t of declared) {
    // 先按 id 投影。少数表（cron_state / user_roles）是复合主键、没有 id 列，
    // 报 42703；这类表本身存在，改投影 * 再取一次即可 —— 404 才是"表不在"。
    let r = await probeWith(t, 'id', { count: 'exact' });
    let note = '';
    if (r.status === 400 && r.error?.code === '42703') {
      r = await probeWith(t, '*', { count: 'exact' });
      note = 'no id column';
    }
    if (r.status === 200) present.push({ table: t, count: r.count ?? 0, note });
    else missing.push(`${t}  status=${r.status}  ${(r.error?.code ?? '')} ${r.error?.message ?? ''}`);
  }

  console.log(`[1] 存在 ${present.length}/${declared.length}，缺失 ${missing.length}`);
  console.log('');
  console.log(`${'table'.padEnd(30)} ${'rows'.padStart(8)}   seed/note`);
  console.log('-'.repeat(60));
  for (const p of present) {
    const need = SEED_EXPECTATION[p.table];
    let seed = p.note;
    if (need !== undefined) seed = p.count >= need ? 'ok' : `LOW(want>=${need})`;
    console.log(`${p.table.padEnd(30)} ${String(p.count).padStart(8)}   ${seed}`);
  }
  console.log('');
  if (missing.length > 0) {
    console.log(`[2] 缺失的表（${missing.length}）:`);
    for (const m of missing) console.log(`    - ${m}`);
    console.log('');
  }

  const lowSeed = present.filter((p) => {
    const need = SEED_EXPECTATION[p.table];
    return need !== undefined && p.count < need;
  });
  console.log('='.repeat(78));
  console.log(`结论: schema.ts 声明 ${declared.length} 张表，真实库存在 ${present.length} 张，`
    + `缺失 ${missing.length} 张。`);
  console.log(`种子数据未达下限的表: ${lowSeed.length === 0 ? '无' : lowSeed.map((p) => p.table).join(', ')}`);
  console.log('（Phase 14 旧探针报 "33/33 存在"；该结论已被本脚本的对照实验推翻）');
  console.log('='.repeat(78));
  return missing.length === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('核验崩溃:', error); process.exitCode = 2; });
