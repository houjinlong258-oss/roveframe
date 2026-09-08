/**
 * 多租户上下文（P0-S2 完整版：JWT + RLS）
 *
 * 租户只从经 Supabase 验证的用户会话获得。不得信任客户端传入的
 * `x-tenant-id`，也不得仅解码 JWT payload 后使用其中的声明。
 */

import { resolveRequestUser } from '@/lib/auth-guard';
import { hasPermission, type RoleKey } from '@/lib/rbac';

export interface TenantContext {
  tenantId: string;
  businessId: string | null;
  userId: string;
  role: RoleKey;
}

export class AuthenticationError extends Error {
  readonly status = 401;
}

export class AuthorizationError extends Error {
  readonly status = 403;
}

export class BusinessScopeError extends Error {
  readonly status = 409;
}

/** Resolve a verified user identity into the only allowed tenant context. */
export async function getTenantContext(request: Request): Promise<TenantContext> {
  const resolved = await resolveRequestUser(request);
  if (!resolved.ok) throw new AuthenticationError(resolved.error);
  return {
    tenantId: resolved.user.tenantId,
    businessId: resolved.user.businessId,
    userId: resolved.user.userId,
    role: resolved.user.role,
  };
}

/** Fail closed when a signed-in role may not perform the requested operation. */
export function requirePermission(context: TenantContext, action: string): void {
  if (!hasPermission(context.role, action)) {
    throw new AuthorizationError(`missing permission: ${action}`);
  }
}

/**
 * Resolve a business-scoped context for code that reads or writes operating
 * data. Legacy users may still have a null business_id during the rollout;
 * those callers must opt into compatibility behavior explicitly instead of
 * silently guessing a business.
 */
export function requireBusinessContext(context: TenantContext): TenantContext & { businessId: string } {
  if (!context.businessId) {
    throw new BusinessScopeError('business scope is required for this operation');
  }
  return context as TenantContext & { businessId: string };
}

/** 供写入时注入 tenant_id。 */
export function withTenantId(tenantId: string): { tenant_id: string } {
  return { tenant_id: tenantId };
}
