import { NextResponse } from 'next/server';
import {
  PlatformAuthError,
  PlatformForbiddenError,
  requirePlatformAdmin,
  writePlatformAudit,
  type PlatformAdminContext,
  type PlatformAdminRole,
} from '@/lib/platform-admin';

/**
 * 平台后台路由包装器：
 * - 统一 requirePlatformAdmin 守卫（商户 token 无效）。
 * - 统一 401/403 映射与 request id。
 * - 每个 handler 自动写脱敏审计摘要。
 */
export async function adminHandler(
  request: Request,
  options: {
    action: string;
    roles?: PlatformAdminRole[];
    targetTenantId?: string | null;
  },
  handler: (ctx: PlatformAdminContext, requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const ctx = await requirePlatformAdmin(request, options.roles);
    const response = await handler(ctx, requestId);
    await writePlatformAudit({
      adminId: ctx.adminId,
      action: options.action,
      targetTenantId: options.targetTenantId ?? null,
      requestId,
      summary: { status: response.status },
    });
    response.headers.set('x-request-id', requestId);
    return response;
  } catch (err) {
    if (err instanceof PlatformAuthError) {
      return NextResponse.json({ error: err.message, requestId }, { status: 401 });
    }
    if (err instanceof PlatformForbiddenError) {
      return NextResponse.json({ error: err.message, requestId }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, requestId }, { status: 500 });
  }
}
