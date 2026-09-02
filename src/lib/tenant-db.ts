import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 租户感知的数据访问层（Part E）。
 * 目标：把「读自动过滤 tenant、写自动注入 tenant」收口到一处，避免散写漏带 tenant_id。
 * 注意：真正接线到各 route 属 Part F，需等 S1 DDL（tenant_id 列）部署后再做；
 *       在此之前本模块是「已就位、未启用」的基础设施。
 */

/** Supabase 对 `.from(string 变量)` 的读查询 builder 类型收窄不完整，用结构类型承接 .eq 等链式方法 */
type TenantReadBuilder = {
  eq: (column: string, value: unknown) => TenantReadBuilder;
  select: (columns?: string) => TenantReadBuilder;
  order: (column: string, opts?: { ascending?: boolean }) => TenantReadBuilder;
  limit: (count: number) => TenantReadBuilder;
  single: () => Promise<unknown>;
  maybeSingle: () => Promise<unknown>;
};

/** 读：返回已按 tenant_id 过滤的查询构建器（可继续链式 .select/.eq/.order） */
export function tenantTable(tenantId: string, table: string): TenantReadBuilder {
  const builder = getSupabaseClient().from(table) as unknown as TenantReadBuilder;
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
  return getSupabaseClient().from(table).update(patch).eq('id', id).eq('tenant_id', tenantId);
}

/** 写：按 id 删除单行（限定在当前租户内） */
export function deleteWithTenant(tenantId: string, table: string, id: string) {
  return getSupabaseClient().from(table).delete().eq('id', id).eq('tenant_id', tenantId);
}