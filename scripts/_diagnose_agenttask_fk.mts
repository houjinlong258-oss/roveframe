/**
 * Phase 15 — 诊断：清理残留时 `agent_tasks_business_id_fkey` 拒绝删除的原因（只读）。
 *
 * 现象：删了 `agent_task_runs`（business 维度）与 `agent_tasks`（business 维度）之后，
 * 删除该 business 仍报：
 *   update or delete on table "businesses" violates foreign key constraint
 *   "agent_tasks_business_id_fkey" on table "agent_tasks"
 *
 * 只读探测：这些表里到底还剩哪些行、它们的 business_id 是什么、
 * 以及 `agent_tasks` 是否真的按 business_id 删得掉。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null; status?: number };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const SUSPECT_BUSINESS = process.argv[2] ?? '946dffbb';

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const sel = (t: string, c: string) =>
    (client as unknown as {
      from(x: string): { select(cc: string): { limit(n: number): Promise<Res> } };
    }).from(t).select(c).limit(5000);

  console.log('='.repeat(78));
  console.log('Phase 15 — agent_tasks FK 诊断（只读）');
  console.log('='.repeat(78));
  console.log(`目标 business 前缀: ${SUSPECT_BUSINESS}`);
  console.log('');

  for (const [table, cols] of [
    ['agent_tasks', 'id, tenant_id, business_id, name, status'],
    ['agent_task_runs', 'id, tenant_id, business_id, task_id, status'],
    ['businesses', 'id, tenant_id, name'],
  ] as const) {
    const { data, error } = await sel(table, cols);
    if (error) { console.log(`[${table}] ERR ${error.message}`); continue; }
    const rows = (data ?? []).filter((r) =>
      String(r.business_id ?? r.id ?? '').startsWith(SUSPECT_BUSINESS)
      || String(r.tenant_id ?? '').startsWith(SUSPECT_BUSINESS));
    console.log(`[${table}] 共 ${(data ?? []).length} 行，其中与本目标相关 ${rows.length} 行:`);
    for (const r of rows) {
      console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log('判读：若 agent_tasks 仍有该 business 的行，说明按 business_id 的删除没生效');
  console.log('      （列名不同 / 行属于该 tenant 但 business_id 为 NULL）。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
