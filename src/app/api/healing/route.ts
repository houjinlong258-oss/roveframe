/**
 * Sprint 5 — Error Self-Healing MVP
 * /api/healing — REST endpoint
 *
 * POST /api/healing         — Report a new error; returns analysis + patch proposal
 *                             (any authenticated user; identity taken from session)
 * GET  /api/healing         — List recent errors with analysis (owner/manager only)
 * GET  /api/healing?id=xxx  — Get single analysis + patch for a captured error id
 *                             (owner/manager only)
 *
 * SAFETY: Read-only access to file system. Never deploys patches.
 */

import { NextRequest } from 'next/server';
import { json, jsonError } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { ErrorReport } from '@/lib/healing/error-collector';
import { analyzeError, analyzeErrors } from '@/lib/healing/analyzer';
import { generatePatchProposal, generatePatchProposals } from '@/lib/healing/patch-generator';
import {
  captureErrorPersisted,
  listCapturedErrors,
  getCapturedErrorById,
  countByFingerprint,
} from '@/lib/healing/persistent-store';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// ---------------------------------------------------------------------------
// POST — Report a runtime error
// ---------------------------------------------------------------------------

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).message !== 'string'
  ) {
    return jsonError('Request body must include at least { message: string }', 400);
  }

  const report = body as ErrorReport;

  // Sanitize — strip any attempt to forge system fields.
  // businessId / userId 只取自已验证会话，禁止客户端伪造。
  const safeReport: ErrorReport = {
    message: String(report.message).slice(0, 2000),
    stack: report.stack ? String(report.stack).slice(0, 4000) : undefined,
    url: report.url ? String(report.url).slice(0, 500) : undefined,
    method: report.method ? String(report.method).slice(0, 10) : undefined,
    statusCode:
      typeof report.statusCode === 'number' &&
      report.statusCode >= 100 &&
      report.statusCode < 600
        ? report.statusCode
        : undefined,
    context:
      typeof report.context === 'object' && report.context !== null
        ? (report.context as Record<string, unknown>)
        : undefined,
    businessId: ctx.businessId ?? undefined,
    userId: ctx.user.userId,
  };

  const captured = await captureErrorPersisted(safeReport, ctx.tenantId);

  // Deduplicated occurrence count
  const occurrences = await countByFingerprint(captured.fingerprint, ctx.tenantId);

  const analysis = analyzeError(captured, occurrences);
  const patch = generatePatchProposal(analysis);

  return json({
    captured,
    analysis,
    patch,
  });
}

// ---------------------------------------------------------------------------
// GET — List / query errors with analysis（错误详情含堆栈，仅管理层可见）
// ---------------------------------------------------------------------------

async function handleGet(request: NextRequest, ctx: AuthContext): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const errorId = searchParams.get('id');
  const limitParam = searchParams.get('limit');
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10) || 20));

  if (errorId) {
    const found = await getCapturedErrorById(errorId, ctx.tenantId);
    if (!found) return jsonError('Error not found', 404);

    const occurrences = await countByFingerprint(found.fingerprint, ctx.tenantId);
    const analysis = analyzeError(found, occurrences);
    const patch = generatePatchProposal(analysis);

    return json({ error: found, analysis, patch });
  }

  // List recent errors with batch analysis
  const recent = await listCapturedErrors(limit, ctx.tenantId);
  const analyses = analyzeErrors(recent);
  const patches = generatePatchProposals(analyses);

  return json({
    total: recent.length,
    errors: recent,
    analyses,
    patches,
  });
}

// ---------------------------------------------------------------------------
// Exports — withAuth 统一鉴权 + 角色门控
// ---------------------------------------------------------------------------

export const POST = protectBusinessMutation(
  { permission: 'healing:write', action: 'healing.capture', entity: 'captured_error' },
  withAuth(handlePost),
);
export const GET = withAuth(handleGet, { roles: ['owner', 'manager'] });
