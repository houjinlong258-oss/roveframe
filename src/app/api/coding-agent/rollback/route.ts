/**
 * POST /api/coding-agent/rollback — 回滚已 applied 的提案（owner/manager）
 *
 * Body: { id: string }
 *
 * 实现：git revert 提案合入提交（merge commit 用 -m 1），回滚后重跑测试门禁，
 * 状态置为 rolled_back 并留审计。
 */

import { NextRequest } from 'next/server';
import { json, jsonError } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { writeAudit } from '@/lib/audit';
import { rollbackProposal, applyEngineAvailable } from '@/lib/coding-agent/apply-engine';

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

  const result = await rollbackProposal(id, { userId: ctx.user.userId, tenantId: ctx.tenantId });

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.user.userId,
    action: result.ok ? 'coding_proposal.rollback' : 'coding_proposal.rollback_failed',
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
