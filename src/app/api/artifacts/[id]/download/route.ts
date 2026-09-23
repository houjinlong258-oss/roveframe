import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { errorResponse, jsonError } from '@/lib/api-helpers';
import { signArtifact } from '@/lib/artifacts/store';

/**
 * `GET /api/artifacts/[id]/download` —— 302 到 1 小时有效的签名 URL。
 *
 * 为什么不直接返回文件流：产物最大 20MB，走应用进程转发会长期占用 Node
 * 内存与连接；签名 URL 由 Supabase 边缘节点直出，且过期即失效。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const url = await signArtifact(
      { tenantId: context.tenantId, businessId: context.businessId },
      id,
    );
    if (!url) return jsonError('artifact not found', 404);
    return NextResponse.redirect(url, 302);
  } catch (error) {
    return errorResponse(error);
  }
}

export const dynamic = 'force-dynamic';
