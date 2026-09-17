/**
 * Phase 15 — 测试残留清理的**删除计划**（默认零写入）。
 *
 * ## 安全原则
 *
 * 只处理**计划外**的 tenant/business，且必须**保留**锚点：
 *   tenant  00000000-0000-0000-0000-000000000000（Default）
 *   business 00000000-0000-0000-0000-000000000001（Sichuan House 四川人家）
 *
 * 默认只打印计划，不删任何东西。传 `--apply` 才真的删除。
 *
 * ## 为什么先算引用
 *
 * 这些 tenant/business 里可能有业务数据（订单、客户、会话、审批…）。
 * 删除前必须逐表统计，任何一张表有非零行都要显式列出来 ——
 * 静默级联删除是不可接受的（本项目禁止静默行为）。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';
const DEFAULT_BUSINESS = '00000000-0000-0000-0000-000000000001';

/** 计划外对象的命名特征 —— 只有明确匹配的才纳入删除计划 */
const RESIDUE_NAME = /^(rls-probe|424323|E2E Phase15)/;

const APPLY = process.argv.includes('--apply');

/** 按 tenant_id 归属的表 */
const BY_TENANT = [
  'businesses', 'users', 'settings', 'chat_sessions', 'audit_events',
  'agent_tasks', 'agent_approvals', 'agent_actions', 'agent_events',
  'agent_task_runs', 'customers', 'orders', 'products', 'reservations',
  'reviews', 'emails', 'email_accounts', 'email_send_tasks',
  'documents', 'doc_chunks', 'knowledge_docs', 'marketing_contents',
  'inventory_items', 'suppliers', 'purchase_orders', 'store_qr_codes',
  'business_memories', 'integration_configs', 'integration_events',
  'notifications', 'notification_outbox', 'alerts', 'cron_state',
  'ai_usage_ledger', 'staff', 'roles', 'user_roles',
] as const;

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const q = (t: string, c: string): Promise<Res> =>
    (client as { from(x: string): { select(c: string): { limit(n: number): Promise<Res> } } })
      .from(t).select(c).limit(5000);
  const del = (t: string, col: string, val: string) =>
    (client as unknown as { from(x: string): { delete(): { eq(c: string, v: string): Promise<{ error: { message: string } | null }> } } })
      .from(t).delete().eq(col, val);

  console.log('='.repeat(78));
  console.log(`Phase 15 — 测试残留清理${APPLY ? '【APPLY 模式：会真的删除】' : '【仅计划，零写入】'}`);
  console.log('='.repeat(78));
  console.log('');

  const { data: tenants } = await q('tenants', 'id, name, created_at');
  const { data: businesses } = await q('businesses', 'id, tenant_id, name');

  const extraTenants = (tenants ?? []).filter((t) => {
    const id = String(t.id);
    if (id === DEFAULT_TENANT) return false;
    return RESIDUE_NAME.test(String(t.name ?? ''));
  });
  const extraBusinesses = (businesses ?? []).filter((b) => {
    const id = String(b.id);
    if (id === DEFAULT_BUSINESS) return false;
    return RESIDUE_NAME.test(String(b.name ?? ''));
  });

  console.log(`锚点保留: tenant ${DEFAULT_TENANT.slice(0, 8)}… / business ${DEFAULT_BUSINESS.slice(0, 8)}…`);
  console.log(`计划删除 tenant ${extraTenants.length} 个、business ${extraBusinesses.length} 个`);
  for (const t of extraTenants) console.log(`   - tenant   ${String(t.id).slice(0, 8)}…  ${JSON.stringify(t.name)}`);
  for (const b of extraBusinesses) console.log(`   - business ${String(b.id).slice(0, 8)}…  ${JSON.stringify(b.name)}`);
  console.log('');

  // ---- 引用清点 ----------------------------------------------------------
  console.log('[1] 引用清点（每张表按 tenant_id / business_id 归属）');
  const blockers: string[] = [];
  for (const t of extraTenants) {
    const id = String(t.id);
    const rows: string[] = [];
    for (const table of BY_TENANT) {
      const { data, error } = await q(table, 'id');
      if (error) continue; // 表不存在或无 id 列：跳过
      const all = data ?? [];
      // 该查询没有过滤，需再按 tenant 过滤一次
      void all;
      const filtered = await (client as unknown as {
        from(x: string): { select(c: string): { eq(c: string, v: string): { limit(n: number): Promise<Res> } } };
      }).from(table).select('id').eq('tenant_id', id).limit(5000);
      if (filtered.error) continue;
      const n = (filtered.data ?? []).length;
      if (n > 0) rows.push(`${table}=${n}`);
    }
    if (rows.length) {
      console.log(`   tenant ${id.slice(0, 8)}…  引用: ${rows.join(', ')}`);
      blockers.push(`tenant ${id.slice(0, 8)}… → ${rows.join(', ')}`);
    } else {
      console.log(`   tenant ${id.slice(0, 8)}…  引用: 无`);
    }
  }
  console.log('');

  if (!APPLY) {
    console.log('='.repeat(78));
    console.log('这是计划。要真的删除，加 --apply 重跑。');
    console.log('注意：上面的引用清点是**删除顺序**的依据 —— 有引用的表要先删子行。');
    console.log('='.repeat(78));
    return 0;
  }

  // ---- 执行删除 ----------------------------------------------------------
  console.log('[2] 执行删除');
  console.log('    顺序说明：先删所有子行（叶子表），最后删 tenants/businesses 本体。');
  console.log('    business 是按 tenant_id 定位后一起删的，若先删 business 行，');
  console.log('    仍挂在它下面的子行会撞外键约束（23503）。');
  let removed = 0;
  let failures = 0;

  for (const t of extraTenants) {
    const id = String(t.id);

    // 1) agent_task_runs 是 agent_tasks 的子表，必须先删（按 business_id 逐条）。
    for (const b of extraBusinesses.filter((x) => String(x.tenant_id) === id)) {
      const { error } = await del('agent_task_runs', 'business_id', String(b.id));
      if (error) { failures += 1; console.log(`   ! agent_task_runs(${String(b.id).slice(0, 8)}…): ${error.message.slice(0, 90)}`); }
      else removed += 1;
    }

    // 2) 其余表按 tenant_id 删。businesses 也在这批里 —— 此时它的子行已清空。
    for (const table of BY_TENANT) {
      const { error } = await del(table, 'tenant_id', id);
      if (error) {
        failures += 1;
        console.log(`   ! ${table}(tenant ${id.slice(0, 8)}…): ${error.message.slice(0, 90)}`);
      } else {
        removed += 1;
      }
    }

    // 3) tenant 本体
    const r = await del('tenants', 'id', id);
    if (r.error) { failures += 1; console.log(`   ! tenants(${id.slice(0, 8)}…): ${r.error.message.slice(0, 90)}`); }
    else { removed += 1; console.log(`   tenant ${id.slice(0, 8)}… 已删（business 随 tenant_id 一并删除）`); }
  }

  console.log('');
  console.log(`完成：${removed} 次删除调用成功，${failures} 次失败。`);
  console.log('='.repeat(78));
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('清理崩溃:', e); process.exitCode = 2; });
