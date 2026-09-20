import { jsonError, subscriptionRequiredResponse } from '@/lib/api-helpers';
import { writeRequiredAudit } from '@/lib/audit';
import {
  AuthenticationError,
  AuthorizationError,
  BusinessScopeError,
  getTenantContext,
  requireBusinessContext,
  requirePermission,
  type TenantContext,
} from '@/lib/tenant';

export type BusinessMutationContext = TenantContext & { businessId: string };

export type MutationPolicy = {
  permission: string;
  action: string;
  entity: string;
};

type MutationOutcome = 'started' | 'succeeded' | 'rejected' | 'failed' | 'denied';

async function auditMutation(
  context: TenantContext,
  policy: MutationPolicy,
  outcome: MutationOutcome,
  responseStatus: number,
): Promise<void> {
  await writeRequiredAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: `${policy.action}.${outcome}`,
    entity: policy.entity,
    after: {
      business_id: context.businessId,
      permission: policy.permission,
      response_status: responseStatus,
      outcome,
    },
  });
}

function scopeErrorResponse(error: unknown): Response | null {
  if (error instanceof AuthenticationError) return jsonError('unauthorized', 401);
  if (error instanceof AuthorizationError) return jsonError('forbidden', 403);
  if (error instanceof BusinessScopeError) return jsonError('business scope required', 409);
  // Phase 16 任务 2：订阅门禁抛出的 402 必须原样保留。
  //
  // 实测（_verify_phase16_core.mts 第一次运行）：漏了这一条时，
  // 被停用的商户在门禁路径上拿到的是 **401 "authentication failed"** ——
  // 而它的凭据完全有效。商家会以为自己密码错了，去重置密码，
  // 真正的原因（订阅被停用）永远不会显示出来。
  // 这是"错误语义丢失"，比拒绝本身更糟。
  const subscriptionResponse = subscriptionRequiredResponse(error);
  if (subscriptionResponse) return subscriptionResponse;
  return null;
}

async function resolveContext(request: Request): Promise<TenantContext | Response> {
  try {
    return await getTenantContext(request);
  } catch (error) {
    return scopeErrorResponse(error) ?? jsonError('authentication failed', 401);
  }
}

async function authorize<TContext extends TenantContext>(
  context: TenantContext,
  policy: MutationPolicy,
  narrowScope: (value: TenantContext) => TContext,
): Promise<TContext | Response> {
  try {
    const scoped = narrowScope(context);
    requirePermission(scoped, policy.permission);
    return scoped;
  } catch (error) {
    const response = scopeErrorResponse(error);
    if (!response) throw error;
    try {
      await auditMutation(context, policy, 'denied', response.status);
    } catch {
      return jsonError('security audit unavailable', 503);
    }
    return response;
  }
}

async function executeAuditedMutation<TContext extends TenantContext>(
  context: TContext,
  policy: MutationPolicy,
  handler: (context: TContext) => Promise<Response>,
): Promise<Response> {
  try {
    await auditMutation(context, policy, 'started', 102);
  } catch {
    return jsonError('security audit unavailable', 503);
  }

  try {
    const response = await handler(context);
    await auditMutation(
      context,
      policy,
      response.ok ? 'succeeded' : 'rejected',
      response.status,
    );
    return response;
  } catch (error) {
    await auditMutation(context, policy, 'failed', 500);
    throw error;
  }
}

/** authenticate -> resolve scope -> permission -> durable intent -> validate/execute -> outcome audit */
export async function runBusinessMutation(
  request: Request,
  policy: MutationPolicy,
  handler: (context: BusinessMutationContext) => Promise<Response>,
): Promise<Response> {
  const resolved = await resolveContext(request);
  if (resolved instanceof Response) return resolved;
  const authorized = await authorize(resolved, policy, requireBusinessContext);
  if (authorized instanceof Response) return authorized;
  return executeAuditedMutation(authorized, policy, handler);
}

/** Tenant-level variant for identity/control-plane records that are not owned by one business. */
export async function runTenantMutation(
  request: Request,
  policy: MutationPolicy,
  handler: (context: TenantContext) => Promise<Response>,
): Promise<Response> {
  const resolved = await resolveContext(request);
  if (resolved instanceof Response) return resolved;
  const authorized = await authorize(resolved, policy, (context) => context);
  if (authorized instanceof Response) return authorized;
  return executeAuditedMutation(authorized, policy, handler);
}

export function protectBusinessMutation<TRequest extends Request, TArgs extends unknown[]>(
  policy: MutationPolicy,
  handler: (request: TRequest, ...args: TArgs) => Promise<Response>,
): (request: TRequest, ...args: TArgs) => Promise<Response> {
  return (request, ...args) => runBusinessMutation(
    request,
    policy,
    () => handler(request, ...args),
  );
}

export function protectTenantMutation<TRequest extends Request, TArgs extends unknown[]>(
  policy: MutationPolicy,
  handler: (request: TRequest, ...args: TArgs) => Promise<Response>,
): (request: TRequest, ...args: TArgs) => Promise<Response> {
  return (request, ...args) => runTenantMutation(
    request,
    policy,
    () => handler(request, ...args),
  );
}
