/**
 * Sprint 6 — AI Coding Agent
 * /api/coding-agent — REST endpoint
 *
 * POST  /api/coding-agent        — Submit a coding task → returns CodingProposal (owner/manager)
 * GET   /api/coding-agent        — List recent proposals (any authenticated user)
 * GET   /api/coding-agent?id=xxx — Get single proposal (any authenticated user)
 * PATCH /api/coding-agent        — Approve / reject a pending proposal (owner/manager)
 *
 * SAFETY:
 *   - Never writes to filesystem. Code changes land only via /api/coding-agent/apply.
 *   - 'applied' status CANNOT be set through PATCH — only the apply engine may
 *     mark a proposal applied after it physically writes files and tests pass.
 *   - tenant/user identity comes from the verified session, never from the body.
 */

import { NextRequest } from 'next/server';
import { json, jsonError, getErrorMessage, getForwardHeaders } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { writeAudit } from '@/lib/audit';
import { validateTask } from '@/lib/coding-agent/permission-guard';
import { buildCodingContext } from '@/lib/coding-agent/context-builder';
import { generateCodingProposal } from '@/lib/coding-agent/code-generator';
import {
  saveProposal,
  listProposals,
  getProposalById,
  updateProposalStatus,
} from '@/lib/coding-agent/persistent-store';
import { CodingTask, CodingTaskType, ProposalStatus } from '@/lib/coding-agent/types';

const VALID_TASK_TYPES = new Set<CodingTaskType>([
  'add_feature', 'fix_bug', 'add_config', 'add_workflow',
  'add_plugin', 'refactor', 'documentation',
]);

const VALID_STATUSES = new Set<ProposalStatus>([
  'pending_review', 'approved', 'rejected', 'applied', 'changes_requested',
]);

/**
 * 审批状态机（Phase 8）：
 *   pending_review    → approved / rejected / changes_requested
 *   changes_requested → approved / rejected / pending_review（作者修订后重提）
 * 其余状态（applied/apply_failed/rolled_back）只能由 apply 引擎流转。
 */
const ALLOWED_TRANSITIONS: Partial<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  pending_review: ['approved', 'rejected', 'changes_requested'],
  changes_requested: ['approved', 'rejected', 'pending_review'],
};

// ---------------------------------------------------------------------------
// POST — Submit a coding task
// ---------------------------------------------------------------------------

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const b = body as Record<string, unknown>;

  if (typeof b.description !== 'string') {
    return jsonError('description (string) is required', 400);
  }
  if (b.type && !VALID_TASK_TYPES.has(b.type as CodingTaskType)) {
    return jsonError(`type must be one of: ${[...VALID_TASK_TYPES].join(', ')}`, 400);
  }

  const task: CodingTask = {
    id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: (b.type as CodingTaskType) ?? 'add_feature',
    description: String(b.description).slice(0, 2000),
    relatedErrorFingerprint: typeof b.relatedErrorFingerprint === 'string'
      ? b.relatedErrorFingerprint : undefined,
    targetFiles: Array.isArray(b.targetFiles)
      ? (b.targetFiles as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 5)
      : undefined,
    // 租户与用户身份只取自已验证会话，禁止客户端伪造
    businessId: ctx.businessId ?? undefined,
    userId: ctx.user.userId,
    requestedAt: new Date().toISOString(),
  };

  // Validate task
  const validation = validateTask(task);
  if (!validation.valid) {
    return jsonError(`Task validation failed: ${validation.errors.join('; ')}`, 400);
  }

  // Build context
  const context = buildCodingContext(task);

  // Forward auth headers to AI router
  const forwardHeaders = getForwardHeaders(request);

  // Generate proposal (async — may call AI)
  let proposal;
  try {
    proposal = await generateCodingProposal(task, context, forwardHeaders);
  } catch (err) {
    return jsonError(`Proposal generation failed: ${getErrorMessage(err)}`, 500);
  }

  // Persist
  await saveProposal(proposal, ctx.tenantId);

  return json({ task, context: { taskId: context.taskId, filesScanned: context.relevantFiles.length }, proposal });
}

// ---------------------------------------------------------------------------
// GET — List or retrieve proposals
// ---------------------------------------------------------------------------

async function handleGet(request: NextRequest, ctx: AuthContext): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const limitParam = searchParams.get('limit');
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10) || 20));

  if (id) {
    const proposal = await getProposalById(id, ctx.tenantId);
    if (!proposal) return jsonError('Proposal not found', 404);
    return json({ proposal });
  }

  const proposals = await listProposals(limit, ctx.tenantId);
  return json({ total: proposals.length, proposals });
}

// ---------------------------------------------------------------------------
// PATCH — Approve / reject a pending proposal
// ---------------------------------------------------------------------------

async function handlePatch(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string') return jsonError('id (string) is required', 400);
  if (typeof b.status !== 'string' || !VALID_STATUSES.has(b.status as ProposalStatus)) {
    return jsonError(`status must be one of: ${[...VALID_STATUSES].join(', ')}`, 400);
  }

  const target = b.status as ProposalStatus;
  // Phase 8：审批人备注（request changes 时建议必填，最长 2000 字符）
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 2000) : undefined;
  if (target === 'changes_requested' && !note) {
    return jsonError('note is required when requesting changes', 400);
  }

  // 'applied' 只能由 apply 引擎在真实写入并测试通过后设置
  if (target === 'applied') {
    return jsonError("'applied' cannot be set manually; use /api/coding-agent/apply", 400);
  }

  const existing = await getProposalById(b.id, ctx.tenantId);
  if (!existing) return jsonError('Proposal not found', 404);

  // 状态机校验：只有显式声明的流转合法（见 ALLOWED_TRANSITIONS）
  const beforeStatus = existing.status; // 先快照：内存存储为同引用对象，更新后会污染 before
  const allowedTargets = ALLOWED_TRANSITIONS[beforeStatus] ?? [];
  if (!allowedTargets.includes(target)) {
    return jsonError(
      `invalid transition '${beforeStatus}' → '${target}'; allowed: ${allowedTargets.join(', ') || '(none — terminal state)'}`,
      409
    );
  }

  const updated = await updateProposalStatus(b.id, target, ctx.tenantId, {
    decidedBy: ctx.user.userId,
    decidedAt: new Date().toISOString(),
  }, note ? { reviewNote: note } : undefined);
  if (!updated) return jsonError('Proposal not found', 404);

  // 审计：审批决定必须留痕（AGENTS.md 陷阱：Next 路由里必须 await）
  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.user.userId,
    action: `coding_proposal.${target}`,
    entity: 'coding_proposal',
    entityId: b.id,
    before: { status: beforeStatus },
    after: { status: target, title: existing.title, note: note ?? null },
  });

  return json({ proposal: updated });
}

// ---------------------------------------------------------------------------
// Exports — withAuth 统一鉴权 + 角色门控
// ---------------------------------------------------------------------------

export const POST = withAuth(handlePost, { roles: ['owner', 'manager'] });
export const GET = withAuth(handleGet);
export const PATCH = withAuth(handlePatch, { roles: ['owner', 'manager'] });
