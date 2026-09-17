/**
 * Phase 15 — 表存在性核验的**阳性/阴性对照**（只读）。
 *
 * 触发原因：`scripts/_verify_real_database.mts` 的 EXPECTED_TABLES 里有四个名字
 * （`documents` / `suppliers` / `purchase_orders` / `marketing_campaigns`）在
 * `src/storage/database/shared/schema.ts` 里**并不存在**（schema 里叫
 * `knowledge_docs` / `marketing_contents`），但那个脚本报 33/33 全部存在。
 *
 * "33/33 存在" 与 "schema 里没有这四个名字" 不能同时为真。因此本脚本做三件事：
 *
 *   1. **阴性对照**：查一个确定不存在的表名，确认探针真的会报错；
 *   2. **逐名复核**：把 33 个期望名字分成"schema.ts 里有定义"和"没有定义"两组分别实测；
 *   3. 打印完整错误文本，不做截断。
 *
 * 如果没有阴性对照，"某表存在"这个结论可能只说明**探针永远不报错**，而不是表真的在。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CountResult = { count: number | null; error: { message: string } | null };
type SupabaseLike = {
  from(table: string): { select(columns: string, opts: { count: 'exact'; head: true }): Promise<CountResult> };
};

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: () => SupabaseLike;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => SupabaseLike } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

/** `_verify_real_database.mts` 声明的 33 张表，原样照搬 */
const EXPECTED = [
  'tenants', 'businesses', 'users', 'settings', 'model_configs',
  'products', 'orders', 'customers', 'reservations', 'reviews',
  'email_accounts', 'emails', 'email_send_tasks', 'marketing_campaigns',
  'documents', 'doc_chunks', 'chat_sessions', 'chat_messages',
  'agent_approvals', 'agent_tasks', 'audit_events', 'health_check',
  'integration_configs', 'integration_events', 'store_qr_codes',
  'cron_state', 'ai_usage_ledger', 'business_memories', 'suppliers',
  'purchase_orders', 'inventory_items', 'staff', 'notifications',
];

/** 从 schema.ts 原文里抽取所有 pgTable 的表名，作为"独立真相来源"。 */
function schemaTableNames(): Set<string> {
  const file = join(process.cwd(), 'src', 'storage', 'database', 'shared', 'schema.ts');
  const txt = readFileSync(file, 'utf8');
  const re = /pgTable\(\s*(?:"([a-z_]+)"|'([a-z_]+)'|`([a-z_]+)`)/g;
  const out = new Set<string>();
  for (const m of txt.matchAll(re)) out.add(m[1] || m[2] || m[3]);
  return out;
}

async function probe(client: SupabaseLike, table: string): Promise<string> {
  try {
    const { error } = await client.from(table).select('*', { count: 'exact', head: true });
    return error ? `ERR ${error.message}` : 'OK';
  } catch (err) {
    return `THREW ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const inSchema = schemaTableNames();

  console.log('='.repeat(78));
  console.log('Phase 15 — 表存在性核验的对照实验');
  console.log('='.repeat(78));
  console.log(`schema.ts 声明的表: ${inSchema.size} 张`);
  console.log('');

  // ---- 1. 阴性对照 -------------------------------------------------------
  console.log('[1] 阴性对照 —— 必须报错，否则探针无效:');
  const sentinels = ['zzz_definitely_not_a_table_9f3a', 'public.also_not_real_7b1c'];
  let negativeControlPassed = true;
  for (const s of sentinels) {
    const r = await probe(client, s);
    const isErr = r.startsWith('ERR');
    if (!isErr) negativeControlPassed = false;
    console.log(`    ${s.padEnd(34)} ${r}`);
  }
  console.log(`    阴性对照${negativeControlPassed ? '通过（探针能败）' : '失败（探针永远不报错）'}`);
  console.log('');

  // ---- 2. 期望清单逐名实测，并按 schema 定义分组 --------------------------
  const groupA: string[] = [];  // schema 里有定义
  const groupB: string[] = [];  // schema 里没有定义
  for (const t of EXPECTED) (inSchema.has(t) ? groupA : groupB).push(t);

  console.log(`[2a] 期望清单中 **schema.ts 有定义** 的 (${groupA.length}):`);
  for (const t of groupA) console.log(`    ${t.padEnd(24)} ${await probe(client, t)}`);
  console.log('');

  console.log(`[2b] 期望清单中 **schema.ts 无定义** 的 (${groupB.length}):`);
  for (const t of groupB) console.log(`    ${t.padEnd(24)} ${await probe(client, t)}`);
  console.log('');

  // ---- 3. schema 有定义但不在期望清单里的 ---------------------------------
  const notProbed = [...inSchema].filter((t) => !EXPECTED.includes(t)).sort();
  console.log(`[3] schema.ts 有定义、但期望清单未覆盖的 (${notProbed.length}):`);
  for (const t of notProbed) console.log(`    ${t.padEnd(30)} ${await probe(client, t)}`);

  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('对照崩溃:', error); process.exitCode = 2; });
