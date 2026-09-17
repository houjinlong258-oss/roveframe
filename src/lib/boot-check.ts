import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface BootCheckResult {
  table: string;
  missing: boolean;
  message: string;
}

const REQUIRED_TABLES = [
  'cron_state',
  'staff',
  'business_memories',
  'agent_actions',
  'agent_approvals',
  'payments',
  'payment_events',
  'ai_usage_ledger',
  'platform_admins',
  'tenant_subscriptions',
  'platform_admin_audit_logs',
];

/** 供回归测试断言"每张表都有探针列"，避免新增表时漏配而退回 fail-open。 */
export const BOOT_CHECK_REQUIRED_TABLES: readonly string[] = REQUIRED_TABLES;

/**
 * 每张表用于存在性探测的列。
 *
 * 为什么需要显式列：Phase 15 实测发现，存在性探测若用
 * `select('*', { count:'exact', head: true })`，PostgREST 对**不存在的表**
 * 返回 204 且 `error === null`（`head:true` 让 404 被吞掉），于是
 * `Boolean(error)` 恒为 false —— 自检会把"表不在"判成"表在"。
 * 对照实验：同一形态对 `zzz_definitely_not_a_table_9f3a` 也报"不缺失"。
 *
 * 改用列投影后三态可区分：200 = 表在（`count` 正确），404 = 表不在。
 * 这些列已在真实库上逐表实测存在（`scripts/_verify_probe_column_choice.mts`）：
 * `cron_state` 是纯复合主键表、没有 id，只有 key。
 *
 * 若将来某张表换了主键列名，报错会是 42703（列不存在）而不是 404，
 * 提示文本会区分两者，不会静默误报。
 */
const PROBE_COLUMN: Record<string, string> = {
  cron_state: 'key',
  staff: 'id',
  business_memories: 'id',
  agent_actions: 'id',
  agent_approvals: 'id',
  payments: 'id',
  payment_events: 'id',
  ai_usage_ledger: 'id',
  platform_admins: 'id',
  tenant_subscriptions: 'id',
  platform_admin_audit_logs: 'id',
};

/** 同上，只读暴露给回归测试。 */
export const BOOT_CHECK_PROBE_COLUMN: Readonly<Record<string, string>> = PROBE_COLUMN;

/** 启动自检：探测新增的表/列是否已建，缺了返回清晰的提示（供 server 启动时打印） */
export async function runBootChecks(): Promise<BootCheckResult[]> {
  const client = getSupabaseClient();
  const results: BootCheckResult[] = [];

  for (const table of REQUIRED_TABLES) {
    const column = PROBE_COLUMN[table] ?? 'id';
    const { error } = await client.from(table).select(column, { count: 'exact' });
    results.push({ table, missing: Boolean(error), message: error?.message ?? '' });
  }

  const { error: colErr } = await client.from('orders').select('tip, tip_percent, tip_staff_id').limit(1);
  results.push({ table: 'orders(tip/tip_percent/tip_staff_id)', missing: Boolean(colErr), message: colErr?.message ?? '' });

  return results;
}