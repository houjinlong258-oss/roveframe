import { NextResponse } from 'next/server';
import { adminHandler } from '@/lib/admin-api';
import { createSupportGrant, getActiveSupportGrant, writePlatformAudit } from '@/lib/platform-admin';

/**
 * GET /api/admin/support-access?tenantId= — 查看当前管理员对指定租户的授权状态（tenantId 必填）。
 * POST /api/admin/support-access — 创建限时只读排障授权（必须填原因）。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.support_access.read' }, async (ctx) => {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    // P0-4：tenantId 必填；仅返回当前管理员自身的授权记录，
    // 禁止无过滤列出其它管理员的授权记录。
    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId required' }, { status: 400 });
    }
    const grant = await getActiveSupportGrant(tenantId, ctx.adminId);
    return NextResponse.json({ active: grant });
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : '';
  return adminHandler(request, { action: 'admin.support_access.create', roles: ['super_admin', 'admin'], targetTenantId: tenantId || null }, async (ctx, requestId) => {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!tenantId || !reason) {
      return NextResponse.json({ error: 'tenantId and reason required' }, { status: 400 });
    }
    const grant = await createSupportGrant({
      tenantId,
      adminId: ctx.adminId,
      reason,
      readOnly: body.readOnly !== false,
      ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : 60,
    });
    await writePlatformAudit({
      adminId: ctx.adminId,
      action: 'admin.support_access.granted',
      targetTenantId: tenantId,
      requestId,
      summary: { reason, readOnly: grant.readOnly, endsAt: grant.endsAt },
    });
    return NextResponse.json({ ok: true, grant }, { status: 201 });
  });
}
