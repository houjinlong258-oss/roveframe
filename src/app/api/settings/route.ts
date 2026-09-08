import { NextRequest, NextResponse } from 'next/server';
import { getSettings, updateSettings } from '@/lib/settings';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 业务信息 / 语言与地区 / AI 偏好 / 模型分配（单行 jsonb）
export async function GET(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  const settings = await getSettings(context.tenantId, context.businessId);
  return NextResponse.json(settings);
}

async function updateSettingsRoute(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const key of ['business', 'locale', 'ai_prefs', 'model_assign'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }
  await updateSettings(context.tenantId, context.businessId, patch);
  return NextResponse.json({ ok: true });
}

export const PUT = protectBusinessMutation(
  { permission: 'settings:write', action: 'settings.update', entity: 'settings' },
  updateSettingsRoute,
);
