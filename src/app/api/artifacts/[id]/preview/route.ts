import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { errorResponse, jsonError } from '@/lib/api-helpers';
import { getArtifact, readArtifactBytes, signArtifact } from '@/lib/artifacts/store';
import { canExtract, extractText } from '@/lib/artifacts/extract';

/**
 * `GET /api/artifacts/[id]/preview` —— 聊天内预览。
 *
 * 为什么放在服务端：xlsx / docx / pptx / pdf 都是二进制或 ZIP，
 * 前端要么引一堆解析库，要么只能给「下载」按钮。
 * 复用服务端已有的零依赖抽取器，一次请求就能给出可读内容。
 *
 * 返回形态：
 * - image/*  → { kind:'image', url } 前端直接显示
 * - html     → { kind:'html',  url } 沙箱 iframe 打开（不注入应用 DOM）
 * - 其余     → { kind:'text',  text, meta } 抽取后的纯文本
 */
const MAX_PREVIEW_CHARS = 24_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const scope = { tenantId: context.tenantId, businessId: context.businessId };

    const artifact = await getArtifact(scope, id);
    if (!artifact) return jsonError('artifact not found', 404);

    const format = artifact.format.toLowerCase();
    const url = await signArtifact(scope, artifact.id);

    if (artifact.mime.startsWith('image/')) {
      return NextResponse.json({ artifact, kind: 'image', url });
    }
    if (format === 'html') {
      return NextResponse.json({ artifact, kind: 'html', url });
    }
    if (!canExtract(format)) {
      return NextResponse.json({
        artifact,
        kind: 'unsupported',
        message: `${format.toUpperCase()} 暂不支持在线预览，请下载后查看。`,
        url,
      });
    }

    const bytes = await readArtifactBytes(scope, artifact.id);
    if (!bytes.ok) {
      return NextResponse.json({
        artifact,
        kind: 'unsupported',
        message: `无法读取文件（${bytes.reason}）。`,
        url,
      });
    }

    const extracted = extractText(format, bytes.data, { maxChars: MAX_PREVIEW_CHARS });
    return NextResponse.json({
      artifact,
      kind: 'text',
      text: extracted.text,
      strategy: extracted.strategy,
      warning: extracted.warning,
      meta: extracted.meta,
      url,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const dynamic = 'force-dynamic';
