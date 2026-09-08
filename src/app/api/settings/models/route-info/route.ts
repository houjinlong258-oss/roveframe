import { NextRequest, NextResponse } from 'next/server';
import { peekAIRoute } from '@/lib/ai/router';
import type { Capability } from '@/lib/ai/providers';
import { getTenantContext, requirePermission } from '@/lib/tenant';

/**
 * GET /api/settings/models/route-info
 * 返回四个 capability 当前实际路由诊断（provider/model/fallback/requestId），
 * 让设置页能显示“这次请求真正会走哪个模型”，避免选择看似生效实际仍走平台模型。
 */
export async function GET(request: NextRequest) {
  const context = await getTenantContext(request);
  requirePermission(context, 'settings:read');
  const scope = { tenantId: context.tenantId, businessId: context.businessId, userId: context.userId };
  const capabilities: Capability[] = ['agent', 'content', 'rag', 'light'];
  const routes: Record<string, unknown> = {};
  for (const cap of capabilities) {
    try {
      routes[cap] = await peekAIRoute(cap, scope);
    } catch (err) {
      routes[cap] = {
        error: err instanceof Error ? err.message : String(err),
        kind: 'error',
      };
    }
  }
  return NextResponse.json({ routes });
}
