/**
 * Production Hardening — CodingProposal 持久化存储
 *
 * Supabase 表 coding_proposals 可用时以数据库为准（重启不丢、可审计、按
 * tenant_id 隔离）；数据库未配置或迁移未应用时自动回退到进程内环形缓冲
 * （proposal-store.ts，保持 Sprint 6 行为与测试兼容）。
 *
 * 模式探测带 60s 缓存：应用迁移后最多 60s 自动切回数据库模式，无需重启。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { CodingProposal, ProposalStatus } from './types';
import * as memory from './proposal-store';

const TABLE = 'coding_proposals';
const PROBE_INTERVAL_MS = 60_000;

// 演示模式（仅 RF_E2E_DEMO=1 且非生产）：每个模块图自我播种演示提案。
// 幂等（demo-seed 内部按 id 判重）；生产环境永不生效。
if (process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD') {
  void import('./demo-seed')
    .then((m) => m.seedApprovalDemo())
    .catch(() => undefined);
}

// null = 未探测；true = DB 模式；false = 内存回退
let _dbMode: boolean | null = null;
let _lastProbe = 0;

async function isDbMode(): Promise<boolean> {
  const now = Date.now();
  if (_dbMode !== null && now - _lastProbe < PROBE_INTERVAL_MS) return _dbMode;
  _lastProbe = now;
  try {
    const { error } = await getSupabaseClient().from(TABLE).select('id').limit(1);
    _dbMode = !error;
  } catch {
    _dbMode = false;
  }
  return _dbMode;
}

/** 测试用：重置模式探测缓存 */
export function _resetPersistenceProbe(): void {
  _dbMode = null;
  _lastProbe = 0;
}

// ---------------------------------------------------------------------------
// 行 <-> 领域对象映射
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  tenant_id: string;
  task_id: string;
  status: string;
  title: string;
  summary: string;
  changes: unknown;
  risk_level: string;
  blocked_paths: unknown;
  model: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  applied_by: string | null;
  applied_commit_sha: string | null;
  rolled_back_at: string | null;
  rolled_back_by: string | null;
  rollback_commit_sha: string | null;
  apply_log: string | null;
  review_note: string | null;
  generated_at: string;
}

function toRow(p: CodingProposal, tenantId: string): Record<string, unknown> {
  return {
    id: p.id,
    tenant_id: tenantId,
    task_id: p.taskId,
    status: p.status,
    title: p.title,
    summary: p.summary,
    changes: p.changes,
    risk_level: p.riskLevel,
    blocked_paths: p.blockedPaths,
    model: p.model ?? null,
    decided_by: p.decidedBy ?? null,
    decided_at: p.decidedAt ?? null,
    applied_at: p.appliedAt ?? null,
    applied_by: p.appliedBy ?? null,
    applied_commit_sha: p.appliedCommitSha ?? null,
    rolled_back_at: p.rolledBackAt ?? null,
    rolled_back_by: p.rolledBackBy ?? null,
    rollback_commit_sha: p.rollbackCommitSha ?? null,
    apply_log: p.applyLog ?? null,
    review_note: p.reviewNote ?? null,
    generated_at: p.generatedAt,
  };
}

function fromRow(r: ProposalRow): CodingProposal {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as ProposalStatus,
    title: r.title,
    summary: r.summary,
    changes: (r.changes ?? []) as CodingProposal['changes'],
    riskLevel: r.risk_level as CodingProposal['riskLevel'],
    requiresHumanApproval: true,
    blockedPaths: (r.blocked_paths ?? []) as string[],
    generatedAt: r.generated_at,
    model: r.model ?? undefined,
    tenantId: r.tenant_id,
    decidedBy: r.decided_by ?? undefined,
    decidedAt: r.decided_at ?? undefined,
    appliedAt: r.applied_at ?? undefined,
    appliedBy: r.applied_by ?? undefined,
    appliedCommitSha: r.applied_commit_sha ?? undefined,
    rolledBackAt: r.rolled_back_at ?? undefined,
    rolledBackBy: r.rolled_back_by ?? undefined,
    rollbackCommitSha: r.rollback_commit_sha ?? undefined,
    applyLog: r.apply_log ?? undefined,
    reviewNote: r.review_note ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// 公开 API（全部 tenant 隔离，async）
// ---------------------------------------------------------------------------

export async function saveProposal(proposal: CodingProposal, tenantId: string): Promise<void> {
  if (await isDbMode()) {
    const { error } = await getSupabaseClient().from(TABLE).insert(toRow(proposal, tenantId));
    if (!error) return;
    // 写入失败降级到内存，保证本次请求不丢数据
  }
  memory.saveProposal({ ...proposal, tenantId });
}

export async function listProposals(limit = 50, tenantId?: string): Promise<CodingProposal[]> {
  if (await isDbMode()) {
    let q = getSupabaseClient()
      .from(TABLE)
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(limit);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (!error && data) return (data as ProposalRow[]).map(fromRow);
  }
  return memory
    .listProposals(200)
    .filter((p) => !tenantId || p.tenantId === tenantId)
    .slice(0, limit);
}

export async function getProposalById(
  id: string,
  tenantId?: string
): Promise<CodingProposal | undefined> {
  if (await isDbMode()) {
    let q = getSupabaseClient().from(TABLE).select('*').eq('id', id);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q.maybeSingle();
    if (!error && data) return fromRow(data as ProposalRow);
    return undefined;
  }
  const found = memory.getProposalById(id);
  // 内存回退也必须 fail-closed 做租户隔离（与 DB 模式 .eq('tenant_id') 对齐）
  if (tenantId && found && found.tenantId !== tenantId) return undefined;
  return found;
}

export interface DecisionMeta {
  decidedBy?: string;
  decidedAt?: string;
}

/** 更新状态（可附带审批元数据与 apply/rollback 字段补丁） */
export async function updateProposalStatus(
  id: string,
  status: ProposalStatus,
  tenantId?: string,
  meta?: DecisionMeta,
  patch?: Partial<CodingProposal>
): Promise<CodingProposal | undefined> {
  if (await isDbMode()) {
    const existing = await getProposalById(id, tenantId);
    if (!existing) return undefined;
    const merged: CodingProposal = {
      ...existing,
      ...patch,
      status,
      decidedBy: meta?.decidedBy ?? existing.decidedBy,
      decidedAt: meta?.decidedAt ?? existing.decidedAt,
    };
    const row = toRow(merged, existing.tenantId ?? tenantId ?? '');
    let q = getSupabaseClient().from(TABLE).update(row).eq('id', id);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { error } = await q;
    if (!error) return merged;
    return undefined;
  }
  const existing = memory.getProposalById(id);
  if (!existing) return undefined;
  if (tenantId && existing.tenantId !== tenantId) return undefined;
  const updated = memory.updateProposalStatus(id, status);
  if (updated) {
    // 内存回退路径也必须合并审批元数据与 apply/rollback 补丁，
    // 否则 appliedCommitSha 等字段会丢失（演练发现的真 bug）
    if (patch) Object.assign(updated, patch);
    if (meta?.decidedBy) updated.decidedBy = meta.decidedBy;
    if (meta?.decidedAt) updated.decidedAt = meta.decidedAt;
    updated.status = status;
    // 演示模式文件后备：patch/meta 合并发生在 updateProposalStatus 落盘之后，
    // 必须再落一次盘，否则 applyLog 等补丁字段在跨模块图读取时丢失
    memory.persistDemoIfNeeded();
  }
  return updated;
}
