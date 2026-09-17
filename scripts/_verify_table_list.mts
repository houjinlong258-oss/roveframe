/**
 * Phase 15 — 表存在性复核（只读）。
 *
 * 触发原因：`_verify_data_drift.mts` 在对若干业务表做 `eq('business_id', …)`
 * 过滤时报 "Could not find the table 'public.<name>'"，而同一仓库的
 * `_verify_real_database.mts` 对**同一批表名**报告 33/33 存在。
 * 两个结论不能同时为真，本脚本用同一个调用形态逐个复核，并打印完整错误文本。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type CountResult = { count: number | null; error: { message: string } | null; status?: number };
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
const EXPECTED_TABLES = [
  'tenants', 'businesses', 'users', 'settings', 'model_configs',
  'products', 'orders', 'customers', 'reservations', 'reviews',
  'email_accounts', 'emails', 'email_send_tasks', 'marketing_campaigns',
  'documents', 'doc_chunks', 'chat_sessions', 'chat_messages',
  'agent_approvals', 'agent_tasks', 'audit_events', 'health_check',
  'integration_configs', 'integration_events', 'store_qr_codes',
  'cron_state', 'ai_usage_ledger', 'business_memories', 'suppliers',
  'purchase_orders', 'inventory_items', 'staff', 'notifications',
] as const;

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const present: string[] = [];
  const missing: Array<{ table: string; message: string }> = [];

  for (const table of EXPECTED_TABLES) {
    const { error } = await client.from(table).select('*', { count: 'exact', head: true });
    if (error) missing.push({ table, message: error.message });
    else present.push(table);
  }

  console.log('='.repeat(78));
  console.log('Phase 15 — 表存在性复核');
  console.log('='.repeat(78));
  console.log(`存在 ${present.length}/${EXPECTED_TABLES.length}`);
  console.log('');
  if (missing.length > 0) {
    console.log(`缺失 ${missing.length} 张（完整错误文本）:`);
    for (const m of missing) console.log(`  ${m.table}\n      ${m.message}`);
  } else {
    console.log('无缺失。');
  }
  console.log('');
  console.log(`存在清单: ${present.join(', ')}`);
  return missing.length === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('复核崩溃:', error); process.exitCode = 2; });
