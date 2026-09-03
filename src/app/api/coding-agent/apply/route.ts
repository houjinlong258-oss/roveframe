/**
 * POST /api/coding-agent/apply — 把 approved 提案真实落地（owner/manager）
 *
 * Body: { id: string }
 *
 * 流程：状态守卫 → 路径复检 → git worktree 隔离写入 → merge → 测试门禁 →
 * 失败自动 revert。全程审计留痕。
 */

import { NextRequest } from 'next/server';
import { json, jsonError } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { writeAudit } from '@/lib/audit';
import { applyProposal, applyEngineAvailable } from '@/lib/coding-agent/apply-engine';

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== 'string') return jsonError('id (string) is required', 400);

  if (!applyEngineAvailable()) {
    return jsonError('apply engine unavailable: not a git repository', 503);
  }

  const result = await applyProposal(id, { userId: ctx.user.userId, tenantId: ctx.tenantId });

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.user.userId,
    action: result.ok ? 'coding_proposal.apply' : 'coding_proposal.apply_failed',
    entity: 'coding_proposal',
    entityId: id,
    after: {
      status: result.status,
      commitSha: result.commitSha ?? null,
      log: result.log.slice(0, 4000),
    },
  });

  if (!result.ok) {
    return json({ ok: false, status: result.status, log: result.log }, 422);
  }
  return json({ ok: true, status: result.status, commitSha: result.commitSha, log: result.log });
}

export const POST = withAuth(handlePost, { roles: ['owner', 'manager'] });
