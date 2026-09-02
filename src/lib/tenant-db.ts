import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 租户感知的数据访问层（P0-S2 完整版：Part E）
 *
 * 设计原则：把「读自动过滤 tenant、写自动注入 tenant」收口到一处，避免散写
 * `.from(table)` 时漏带 tenant_id 导致跨租户泄露。
 *
 * Scope 划分：
 *   - business 表：products / orders / customers / reviews / staff / ...
 *                读自动 .eq('tenant_id')，写自动注入 tenant_id
 *                → 用 tenantTable / insertWithTenant / updateWithTenant / deleteWithTenant
 *   - platform 表：tenants / users / roles / user_roles / audit_logs
 *                不按 tenant 过滤（它们本身就是租户元数据）
 *                → 用 plainTable / plainInsert / plainUpdate / plainDelete
 *
 * Part F 接线规则：业务表路由必须用 *_WithTenant 系列；平台表路由用 plain_* 系列。
 * service_role 模式下，平台表仍能写；用户 JWT 模式（完整版 P0-S3）由 RLS 兜底。
 */

/** Supabase PostgrestFilterBuilder 的结构化类型（足够覆盖路由中用到的 eq/neq/gte/lt/in/order/limit/single/maybeSingle） */
type FilterBuilder = {
  eq: (col: string, val: unknown) => FilterBuilder;
  neq: (col: string, val: unknown) => FilterBuilder;
  gt: (col: string, val: unknown) => FilterBuilder;
  gte: (col: string, val: unknown) => FilterBuilder;
  lt: (col: string, val: unknown) => FilterBuilder;
  lte: (col: string, val: unknown) => FilterBuilder;
  like: (col: string, pattern: string) => FilterBuilder;
  ilike: (col: string, pattern: string) => FilterBuilder;
  in: (col: string, vals: unknown[]) => FilterBuilder;
  is: (col: string, val: unknown) => FilterBuilder;
  match: (q: Record<string, unknown>) => FilterBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => FilterBuilder;
  limit: (n: number) => FilterBuilder;
  range: (from: number, to: number) => FilterBuilder;
  single: () => Promise<{ data: unknown; error: { message: string } | null }>;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  then: <T>(
    onfulfilled: (v: { data: unknown[] | null; error: { message: string } | null }) => T,
  ) => Promise<T>;
};

/** PostgrestQueryBuilder（仅含 select/insert/update/delete/upsert） */
type QueryBuilder = {
  select: (cols?: string) => FilterBuilder;
};

/** 显式结构化类型，避免泄漏 supabase 内部泛型导致路由侧类型噪音 */

/** 平台层表——不按 tenant 过滤（tenants/users/roles/user_roles/audit_logs） */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set([
  'tenants',
  'users',
  'roles',
  'user_roles',
  'audit_logs',
]);

/** 业务表名是否在白名单之外（粗略判定，正式判定请用 isPlatformTable） */
export function isPlatformTable(table: string): boolean {
  return PLATFORM_TABLES.has(table);
}

/* ====================================================================== */
/* 业务表（带 tenant 过滤）                                                */
/* ====================================================================== */

/** 读：返回「已 select(cols) + 已 eq('tenant_id', tenantId)」的链式 filter builder
 *  调用方继续链式：.eq('status', 'active').order('name').limit(10) */
export function tenantTable(tenantId: string, table: string, columns = '*'): FilterBuilder {
  const client = getSupabaseClient();
  // Supabase 类型链：from → select → eq → FilterBuilder
  // 这里用 unknown 跳过内部泛型，外层用结构化 FilterBuilder 兜底
  const builder = (client.from(table) as unknown as QueryBuilder)
    .select(columns) as unknown as FilterBuilder;
  return builder.eq('tenant_id', tenantId);
}

/** 写：insert 自动注入 tenant_id */
export function insertWithTenant(tenantId: string, table: string, row: Record<string, unknown>) {
  return getSupabaseClient().from(table).insert({ ...row, tenant_id: tenantId });
}

/** 写：按 id 更新单行（限定在当前租户内） */
export function updateWithTenant(
  tenantId: string,
  table: string,
  id: string,
  patch: Record<string, unknown>,
) {
  return getSupabaseClient()
    .from(table)
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId);
}

/** 写：按 id 删除单行（限定在当前租户内） */
export function deleteWithTenant(tenantId: string, table: string, id: string) {
  return getSupabaseClient()
    .from(table)
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId);
}

/* ====================================================================== */
/* 平台表（不带 tenant 过滤）                                              */
/* ====================================================================== */

/** 读：返回未过滤的查询构建器（仅用于平台表，需调用方自己 .select(cols)） */
export function plainTable(table: string): QueryBuilder {
  return getSupabaseClient().from(table) as unknown as QueryBuilder;
}

/** 写：insert（仅用于平台表，不注入 tenant_id） */
export function plainInsert(table: string, row: Record<string, unknown>) {
  return getSupabaseClient().from(table).insert(row);
}

/** 写：按 id 更新（仅用于平台表） */
export function plainUpdate(table: string, id: string, patch: Record<string, unknown>) {
  return getSupabaseClient().from(table).update(patch).eq('id', id);
}

/** 写：按 id 删除（仅用于平台表） */
export function plainDelete(table: string, id: string) {
  return getSupabaseClient().from(table).delete().eq('id', id);
}
