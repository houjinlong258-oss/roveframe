import { NextRequest, NextResponse } from 'next/server';
import {
  getTenantContext,
  requireBusinessContext,
  requirePermission,
} from '@/lib/tenant';
import { errorResponse, jsonError } from '@/lib/api-helpers';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  deleteArtifact,
  formatFromName,
  getArtifactsByIds,
  listArtifacts,
  mimeForFormat,
  putArtifact,
  signArtifact,
  type ArtifactSource,
} from '@/lib/artifacts/store';

/**
 * Workspace Files —— 文件中心 API。
 *
 * - GET  `/api/artifacts`           列表（可 `?ids=` 批量取、`?session_id=`、`?source=`）
 * - POST `/api/artifacts`           multipart 上传（用户资料），进同一个私有桶
 * - DELETE `/api/artifacts?id=`     删除
 *
 * 安全边界：产物存在 **private** 桶，只有本 tenant+business 能列出；
 * 下载一律走 1 小时签名 URL，不产生永久公开链接。
 */

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const scope = { tenantId: context.tenantId, businessId: context.businessId };
    const params = request.nextUrl.searchParams;

    const ids = params.get('ids');
    if (ids) {
      const artifacts = await getArtifactsByIds(scope, ids.split(','), { sign: true });
      return NextResponse.json({ artifacts });
    }

    const rawSource = params.get('source');
    const source: ArtifactSource | null =
      rawSource === 'agent' || rawSource === 'user' ? rawSource : null;
    const rawLimit = Number(params.get('limit') ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 100;

    const artifacts = await listArtifacts(scope, {
      sessionId: params.get('session_id'),
      source,
      limit,
      sign: true,
    });
    return NextResponse.json({ artifacts });
  } catch (error) {
    return errorResponse(error);
  }
}

async function uploadArtifact(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'agent:use');

  const limit = checkFixedWindow(`artifact-upload:${context.tenantId}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.ok) return rateLimitResponse(limit);

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return jsonError('No file provided', 400);
  if (file.size === 0) return jsonError('Empty file', 400);
  if (file.size > MAX_UPLOAD_BYTES) return jsonError('File exceeds 20MB limit', 400);

  const format = formatFromName(file.name);
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(format)) {
    return jsonError(`Unsupported file type: .${format}`, 400);
  }

  const sessionId = form.get('session_id');
  const scope = { tenantId: context.tenantId, businessId: context.businessId };
  const record = await putArtifact(scope, {
    name: file.name,
    format,
    data: Buffer.from(await file.arrayBuffer()),
    mime: file.type || mimeForFormat(format),
    source: 'user',
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
  });
  return NextResponse.json({ artifact: { ...record, url: await signArtifact(scope, record.id) } });
}

async function removeArtifact(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'agent:use');
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return jsonError('id required', 400);
  const deleted = await deleteArtifact(
    { tenantId: context.tenantId, businessId: context.businessId },
    id,
  );
  if (!deleted) return jsonError('artifact not found', 404);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'agent:use', action: 'artifacts.upload', entity: 'artifact' },
  uploadArtifact,
);

export const DELETE = protectBusinessMutation(
  { permission: 'agent:use', action: 'artifacts.delete', entity: 'artifact' },
  removeArtifact,
);

export const dynamic = 'force-dynamic';
