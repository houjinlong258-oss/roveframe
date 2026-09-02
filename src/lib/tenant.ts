/** 多租户上下文与默认常量（P0 地基） */

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_BUSINESS_ID = '00000000-0000-0000-0000-000000000001';

export interface TenantContext {
  tenantId: string;
  businessId?: string | null;
}

/**
 * 解析当前租户上下文。
 * 多租户真正落地前：从 x-tenant-id 头或环境变量取，缺省回退默认租户（兼容现有单租户数据）。
 * 后续接入 Supabase Auth 后，改为从 JWT claim 解析。
 */
export function getTenantContext(request?: Request): TenantContext {
  const header = request?.headers?.get('x-tenant-id');
  const tenantId = header || process.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
  return { tenantId, businessId: null };
}

/** 供写入时注入 tenant_id */
export function withTenantId(tenantId: string): { tenant_id: string } {
  return { tenant_id: tenantId };
}