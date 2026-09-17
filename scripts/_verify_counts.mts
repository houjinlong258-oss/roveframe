/**
 * Phase 15 —— 计数快照（只读）。供报告引用精确数字。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const TABLES = [
  'tenants', 'businesses', 'users', 'products', 'customers', 'orders',
  'doc_chunks', 'knowledge_docs', 'audit_events', 'agent_approvals',
  'chat_sessions', 'chat_messages', 'inventory_items', 'cron_state',
  'agent_tasks', 'ai_usage_ledger',
] as const;

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const q = (t: string, c: string): Promise<Res> =>
    (client as { from(x: string): { select(c: string): { limit(n: number): Promise<Res> } } })
      .from(t).select(c).limit(2000);

  console.log('='.repeat(60));
  console.log('Phase 15 — 计数快照');
  console.log('='.repeat(60));

  for (const t of TABLES) {
    const col = t === 'cron_state' ? 'key' : 'id';
    const { data, error } = await q(t, col);
    console.log(`${t.padEnd(22)} ${error ? 'ERR ' + error.message.slice(0, 30) : (data ?? []).length}`);
  }

  // 计划外 tenant / business 的清单
  const { data: tenants } = await q('tenants', 'id, name, created_at');
  const { data: businesses } = await q('businesses', 'id, tenant_id, name, created_at');

  const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';
  const DEFAULT_BUSINESS = '00000000-0000-0000-0000-000000000001';
  const extraT = (tenants ?? []).filter((t) => String(t.id) !== DEFAULT_TENANT);
  const extraB = (businesses ?? []).filter((b) => String(b.id) !== DEFAULT_BUSINESS);

  console.log('');
  console.log(`计划外 tenant: ${extraT.length}`);
  for (const t of extraT) console.log(`   ${String(t.id).slice(0, 8)}…  ${JSON.stringify(t.name)}  ${String(t.created_at)}`);
  console.log(`计划外 business: ${extraB.length}`);
  for (const b of extraB) console.log(`   ${String(b.id).slice(0, 8)}…  ${JSON.stringify(b.name)}  ${String(b.created_at)}`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
