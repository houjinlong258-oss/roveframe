import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { errorResponse, jsonError } from '@/lib/api-helpers';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { deleteArtifact, getArtifact, signArtifact } from '@/lib/artifacts/store';

/**
 * 单个产物：`GET /api/artifacts/[id]`（含签名 URL）、`DELETE /api/artifacts/[id]`。
 * tenant+business 是隔离边界：别的企业的 id 只会得到 404。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const artifact = await getArtifact(
      { tenantId: context.tenantId, businessId: context.businessId },
      id,
    );
    if (!artifact) return jsonError('artifact not found', 404);
    return NextResponse.json({
      artifact: {
        ...artifact,
        url: await signArtifact(
          { tenantId: context.tenantId, businessId: context.businessId },
          artifact.id,
        ),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function removeArtifact(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'agent:use');
  const deleted = await deleteArtifact(
    { tenantId: context.tenantId, businessId: context.businessId },
    id,
  );
  if (!deleted) return jsonError('artifact not found', 404);
  return NextResponse.json({ ok: true });
}

export const DELETE = protectBusinessMutation(
  { permission: 'agent:use', action: 'artifacts.delete', entity: 'artifact' },
  removeArtifact,
);

export const dynamic = 'force-dynamic';
