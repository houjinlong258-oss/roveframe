/**
 * 多租户上下文（P0-S2 完整版：JWT + RLS）
 *
 * 租户只从经 Supabase 验证的用户会话获得。不得信任客户端传入的
 * `x-tenant-id`，也不得仅解码 JWT payload 后使用其中的声明。
 */

import { resolveRequestUser } from '@/lib/auth-guard';
import { hasPermission, type RoleKey } from '@/lib/rbac';
import { assertWriteEntitlement, type EntitlementDecision } from '@/lib/entitlements';

export interface TenantContext {
  tenantId: string;
  businessId: string | null;
  userId: string;
  role: RoleKey;
  /**
   * 该租户的订阅判定（Phase 16）。挂在上下文上而不是让每个路由自己查：
   * 门禁必须在**唯一一处**生效，否则"哪些路由受管"就成了一份会腐烂的清单。
   */
  entitlement?: EntitlementDecision;
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

/**
 * Resolve a verified user identity into the only allowed tenant context.
 *
 * Phase 16：这里同时是**订阅门禁的唯一插入点**。
 * 全部 96 处 `getTenantContext(request)` 调用、59 个路由文件都经过它，
 * 因此不必逐个路由加检查（那种清单必然漏项）。
 *
 * 语义：
 *   - 读方法（GET/HEAD）永远放行 —— 商家必须能读到自己的经营数据；
 *   - 写方法**只在 `ENTITLEMENT_GATED_PREFIXES` 覆盖的路径上**受门禁约束
 *     （对外可见 / 要花钱的动作）；其余写操作不受订阅状态影响；
 *   - 判定**不抛错**：查不到订阅行或查库失败都降级为只读并把原因写进 reason。
 *
 * @param options.skipEntitlement 仅供平台自营路径使用（见下方调用点），
 *   普通业务路由不要传。
 */
export async function getTenantContext(
  request: Request,
  options: { skipEntitlement?: boolean } = {},
): Promise<TenantContext> {
  const resolved = await resolveRequestUser(request);
  if (!resolved.ok) throw new AuthenticationError(resolved.error);
  const entitlement = options.skipEntitlement
    ? undefined
    : await assertWriteEntitlement(
        resolved.user.tenantId,
        request.method,
        safePathname(request),
      );
  return {
    tenantId: resolved.user.tenantId,
    businessId: resolved.user.businessId,
    userId: resolved.user.userId,
    role: resolved.user.role,
    entitlement,
  };
}

/**
 * 取请求路径，取不到时返回 undefined。
 *
 * `undefined` 会让门禁按"在范围内"处理（fail-closed），因此这里**不能**
 * 用空字符串兜底 —— 空字符串会让所有路径都不匹配清单，等于默认放行。
 */
function safePathname(request: Request): string | undefined {
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
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
