/**
 * Phase 8 — Enterprise AI Change Approval
 * GET /api/coding-agent/review?id=xxx
 *
 * 审批详情聚合端点（任何已认证用户可读；决策仍由 PATCH 角色门控）：
 *
 *   - proposal：提案本体
 *   - files：每个变更文件的结构化 unified diff（服务端基于当前工作区
 *     文件内容实时计算；旧内容读取带路径穿越防护）
 *   - checks：审批前检查包（permission / security / testGate / rollback）
 *   - activity：该提案的审计时间线（best-effort，DB 不可用为空数组）
 *
 * 安全：
 *   - withAuth 完整校验；tenant 隔离由 getProposalById(id, tenantId) 保证
 *   - 文件读取只允许仓库相对路径（拒绝 .. 与绝对路径）
 */

import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { json, jsonError } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { listAuditForEntity } from '@/lib/audit';
import { getProposalById } from '@/lib/coding-agent/persistent-store';
import { diffFile, type FileDiff } from '@/lib/coding-agent/diff';
import { buildReviewChecks } from '@/lib/coding-agent/review-checks';

/** 读取仓库内文件内容；路径非法或不存在返回 null */
async function safeReadRepoFile(relPath: string): Promise<string | null> {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.includes('..') || path.isAbsolute(normalized)) return null;
  try {
    return await readFile(path.join(process.cwd(), normalized), 'utf8');
  } catch {
    return null;
  }
}

async function handleGet(request: NextRequest, ctx: AuthContext): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return jsonError('id (query param) is required', 400);

  const proposal = await getProposalById(id, ctx.tenantId);
  if (!proposal) return jsonError('Proposal not found', 404);

  // 逐文件计算 diff（读取当前工作区内容作为 diff 旧侧）
  const files: FileDiff[] = [];
  for (const change of proposal.changes) {
    const oldContent =
      change.operation === 'create' ? null : await safeReadRepoFile(change.filePath);
    files.push(
      diffFile(change.filePath, change.operation, oldContent, change.proposedContent)
    );
  }

  const checks = buildReviewChecks(proposal);
  const activity = await listAuditForEntity(ctx.tenantId, 'coding_proposal', id);

  return json({ proposal, files, checks, activity });
}

export const GET = withAuth(handleGet);
