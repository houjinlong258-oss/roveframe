'use client';

/**
 * Phase 8 — Enterprise AI Change Approval Experience
 * /enterprise/approvals
 *
 * GitHub PR + Linear 风格的企业级 AI 代码变更审批台：
 *   - 左栏：提案列表（状态 / 风险 / 时间）
 *   - 右栏：提案头 → 审批前检查包（permission / security / testGate / rollback）
 *     → 决策面板（Approve / Request changes / Reject + 备注）
 *     → 逐文件 unified diff viewer（增/删/上下文行 + 双侧行号）
 *     → 审计活动时间线
 *
 * 安全：本页只做展示与调用既有 API；所有写操作由服务端
 * withAuth（owner/manager）+ 状态机 + Apply Engine 复检兜底，
 * UI 不提供任何绕过路径。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ShieldCheck, RefreshCw, Check, X, Rocket, Undo2, FileCode2, ChevronRight,
  GitPullRequest, Lock, ShieldAlert, FlaskConical, History, MessageSquare,
  AlertTriangle, CircleCheck, CircleMinus, CircleHelp,
} from 'lucide-react';
import { safeFetchJson } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types（与 /api/coding-agent/review 返回结构一致）
// ---------------------------------------------------------------------------

type ProposalStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'applied'
  | 'apply_failed'
  | 'rolled_back';

interface CodeChange {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  proposedContent?: string;
  rationale: string;
}

interface Proposal {
  id: string;
  taskId: string;
  status: ProposalStatus;
  title: string;
  summary: string;
  changes: CodeChange[];
  riskLevel: 'safe' | 'moderate' | 'review_required';
  blockedPaths: string[];
  generatedAt: string;
  model?: string;
  decidedBy?: string;
  decidedAt?: string;
  appliedAt?: string;
  appliedBy?: string;
  appliedCommitSha?: string;
  rolledBackAt?: string;
  rolledBackBy?: string;
  rollbackCommitSha?: string;
  applyLog?: string;
  reviewNote?: string;
}

interface DiffLine {
  type: 'context' | 'add' | 'del';
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface FileDiff {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  tooLarge: boolean;
}

interface SecurityFinding {
  filePath: string;
  line: number;
  rule: string;
  severity: 'high' | 'medium';
  excerpt: string;
}

interface ReviewChecks {
  permission: { ok: boolean; problems: string[] };
  security: { ok: boolean; findings: SecurityFinding[] };
  testGate: { steps: string[]; lastResult: 'pass' | 'fail' | 'unknown'; detail?: string };
  rollback: { available: boolean; reason: string };
}

interface AuditRow {
  id: number;
  actorId: string | null;
  action: string;
  after: unknown;
  createdAt: string;
}

interface ReviewPack {
  proposal: Proposal;
  files: FileDiff[];
  checks: ReviewChecks;
  activity: AuditRow[];
}

// ---------------------------------------------------------------------------
// 样式常量
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<ProposalStatus, string> = {
  pending_review: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  approved: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  rejected: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
  changes_requested: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  applied: 'bg-green-500/15 text-green-700 dark:text-green-400',
  apply_failed: 'bg-red-500/15 text-red-700 dark:text-red-400',
  rolled_back: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
};

const RISK_STYLES: Record<Proposal['riskLevel'], string> = {
  safe: 'bg-green-500/15 text-green-700 dark:text-green-400',
  moderate: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  review_required: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

const OP_STYLES: Record<CodeChange['operation'], string> = {
  create: 'text-green-700 dark:text-green-400',
  modify: 'text-blue-700 dark:text-blue-400',
  delete: 'text-red-700 dark:text-red-400',
};

// ---------------------------------------------------------------------------
// 子组件：检查行
// ---------------------------------------------------------------------------

type CheckState = 'pass' | 'warn' | 'fail' | 'unknown';

function CheckRow(props: {
  icon: React.ReactNode;
  label: string;
  state: CheckState;
  detail?: string;
  children?: React.ReactNode;
}) {
  const stateBadge: Record<CheckState, { cls: string; icon: React.ReactNode }> = {
    pass: { cls: 'text-green-600 dark:text-green-400', icon: <CircleCheck className="w-4 h-4" /> },
    warn: { cls: 'text-amber-600 dark:text-amber-400', icon: <AlertTriangle className="w-4 h-4" /> },
    fail: { cls: 'text-red-600 dark:text-red-400', icon: <CircleMinus className="w-4 h-4" /> },
    unknown: { cls: 'text-zinc-500', icon: <CircleHelp className="w-4 h-4" /> },
  };
  const badge = stateBadge[props.state];
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-on-surface-variant">{props.icon}</span>
        <span className="text-sm font-medium">{props.label}</span>
        <span className={`ml-auto flex items-center gap-1.5 text-xs font-medium ${badge.cls}`}>
          {badge.icon}
          {props.detail ?? props.state}
        </span>
      </div>
      {props.children && (
        <div className="mt-2 ml-7 space-y-1 text-xs text-on-surface-variant">{props.children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件：单文件 diff 卡片
// ---------------------------------------------------------------------------

function DiffCard({ file, rationale }: { file: FileDiff; rationale?: string }) {
  const t = useTranslations('enterpriseApprovals');
  return (
    <div className="rounded-lg border border-outline overflow-hidden">
      {/* 文件头 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-container border-b border-outline text-xs">
        <FileCode2 className="w-3.5 h-3.5 text-on-surface-variant" />
        <code className="font-medium text-[13px]">{file.filePath}</code>
        <span className={`uppercase tracking-wide font-medium ${OP_STYLES[file.operation]}`}>
          {t(`operation.${file.operation}`)}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono">
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
      </div>

      {rationale && (
        <p className="px-3 py-2 text-xs text-on-surface-variant border-b border-outline">
          {rationale}
        </p>
      )}

      {/* diff 主体 */}
      {file.tooLarge ? (
        <div className="p-3 text-xs text-on-surface-variant">{t('files.tooLarge')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk, hi) => (
                <HunkRows key={hi} hunk={hunk} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <tr className="bg-blue-500/10">
        <td colSpan={3} className="px-3 py-1 text-blue-700 dark:text-blue-400 select-none">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((line, li) => (
        <tr
          key={li}
          className={
            line.type === 'add'
              ? 'bg-green-500/10'
              : line.type === 'del'
                ? 'bg-red-500/10'
                : ''
          }
        >
          <td className="w-10 px-2 text-right text-on-surface-variant/50 select-none border-r border-outline/50">
            {line.oldLine ?? ''}
          </td>
          <td className="w-10 px-2 text-right text-on-surface-variant/50 select-none border-r border-outline/50">
            {line.newLine ?? ''}
          </td>
          <td className="px-3 whitespace-pre-wrap break-all">
            <span
              className={
                line.type === 'add'
                  ? 'text-green-700 dark:text-green-300'
                  : line.type === 'del'
                    ? 'text-red-700 dark:text-red-300'
                    : ''
              }
            >
              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
              {line.content}
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function EnterpriseApprovalsPage() {
  const t = useTranslations('enterpriseApprovals');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pack, setPack] = useState<ReviewPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const loadList = useCallback(async () => {
    setLoading(true);
    const data = await safeFetchJson<{ proposals: Proposal[] }>('/api/coding-agent?limit=50');
    setProposals(data?.proposals ?? []);
    setLoading(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const data = await safeFetchJson<ReviewPack>(
      `/api/coding-agent/review?id=${encodeURIComponent(id)}`
    );
    setPack(data);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) {
      setNote('');
      loadDetail(selectedId);
    }
  }, [selectedId, loadDetail]);

  async function doAction(
    kind: 'approve' | 'reject' | 'request_changes' | 'apply' | 'rollback',
    id: string
  ) {
    setActionBusy(kind);
    setNotice(null);
    try {
      let res: Response;
      if (kind === 'apply' || kind === 'rollback') {
        res = await fetch(`/api/coding-agent/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
      } else {
        const status =
          kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'changes_requested';
        res = await fetch('/api/coding-agent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status, note: note.trim() || undefined }),
        });
      }
      const data = (await res.json().catch(() => null)) as
        | { error?: string; log?: string }
        | null;
      if (!res.ok) {
        setNotice(data?.error ?? data?.log ?? `HTTP ${res.status}`);
      } else {
        setNote('');
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
      await loadList();
      await loadDetail(id);
    }
  }

  const proposal = pack?.proposal ?? null;
  const checks = pack?.checks ?? null;
  const rationaleByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of proposal?.changes ?? []) map.set(c.filePath, c.rationale);
    return map;
  }, [proposal]);

  const canDecide = proposal?.status === 'pending_review' || proposal?.status === 'changes_requested';

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitPullRequest className="w-6 h-6 text-primary" />
            {t('title')}
          </h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={loadList}
          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-outline hover:bg-surface-container transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          {t('refresh')}
        </button>
      </div>

      {notice && (
        <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-sm text-red-700 dark:text-red-400 whitespace-pre-wrap">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 items-start">
        {/* 提案列表 */}
        <div className="rounded-lg border border-outline bg-surface overflow-hidden lg:sticky lg:top-6">
          <div className="px-4 py-3 border-b border-outline text-sm font-semibold">
            {t('listTitle', { count: proposals.length })}
          </div>
          <div className="divide-y divide-outline max-h-[75vh] overflow-y-auto">
            {loading && <div className="p-6 text-sm text-on-surface-variant">{t('loading')}</div>}
            {!loading && proposals.length === 0 && (
              <div className="p-6 text-sm text-on-surface-variant">{t('empty')}</div>
            )}
            {proposals.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`w-full text-left px-4 py-3 hover:bg-surface-container/60 transition-colors ${
                  selectedId === p.id ? 'bg-surface-container' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{p.title}</span>
                  <ChevronRight className="w-4 h-4 shrink-0 text-on-surface-variant" />
                </div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_STYLES[p.status]}`}>
                    {t(`status.${p.status}`)}
                  </span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${RISK_STYLES[p.riskLevel]}`}>
                    {t(`risk.${p.riskLevel}`)}
                  </span>
                  <span className="text-[11px] text-on-surface-variant ml-auto">
                    {fmtDateTime(p.generatedAt)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 详情 */}
        <div className="space-y-5 min-w-0">
          {!proposal && (
            <div className="rounded-lg border border-outline bg-surface p-10 text-center text-sm text-on-surface-variant">
              {t('selectPrompt')}
            </div>
          )}

          {proposal && checks && (
            <>
              {/* 提案头 */}
              <div className="rounded-lg border border-outline bg-surface p-5 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[proposal.status]}`}>
                    {t(`status.${proposal.status}`)}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_STYLES[proposal.riskLevel]}`}>
                    {t(`risk.${proposal.riskLevel}`)}
                  </span>
                </div>
                <h2 className="text-lg font-semibold">{proposal.title}</h2>
                <p className="text-sm text-on-surface-variant">{proposal.summary}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
                  <span>{t('agent')}: AI Coding Agent{proposal.model ? ` · ${proposal.model}` : ''}</span>
                  <span>{t('generatedAt')}: {fmtDateTime(proposal.generatedAt)}</span>
                  {proposal.decidedBy && (
                    <span>{t('decidedBy')}: {proposal.decidedBy}</span>
                  )}
                  {proposal.appliedCommitSha && (
                    <span>
                      {t('commit')}: <code className="font-mono">{proposal.appliedCommitSha.slice(0, 8)}</code>
                    </span>
                  )}
                </div>
                {proposal.reviewNote && (
                  <div className="flex items-start gap-2 rounded-md bg-orange-500/10 border border-orange-500/20 px-3 py-2 text-sm">
                    <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
                    <div>
                      <div className="text-xs font-medium text-orange-700 dark:text-orange-400 mb-0.5">
                        {t('reviewNote')}
                      </div>
                      <p className="whitespace-pre-wrap">{proposal.reviewNote}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* 审批前检查包 */}
              <div className="rounded-lg border border-outline bg-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-outline text-sm font-semibold flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  {t('checks.title')}
                </div>
                <div className="divide-y divide-outline">
                  <CheckRow
                    icon={<Lock className="w-4 h-4" />}
                    label={t('checks.permission')}
                    state={checks.permission.ok ? 'pass' : 'fail'}
                    detail={checks.permission.ok ? t('checks.pass') : t('checks.problems', { count: checks.permission.problems.length })}
                  >
                    {checks.permission.problems.map((p, i) => (
                      <div key={i} className="font-mono">{p}</div>
                    ))}
                  </CheckRow>

                  <CheckRow
                    icon={<ShieldAlert className="w-4 h-4" />}
                    label={t('checks.security')}
                    state={checks.security.findings.length === 0 ? 'pass' : checks.security.ok ? 'warn' : 'fail'}
                    detail={
                      checks.security.findings.length === 0
                        ? t('checks.pass')
                        : t('checks.findings', { count: checks.security.findings.length })
                    }
                  >
                    {checks.security.findings.slice(0, 8).map((f, i) => (
                      <div key={i}>
                        <code>{f.filePath}:{f.line}</code> — {f.rule}
                        <span className={f.severity === 'high' ? ' text-red-600 dark:text-red-400 font-medium' : ''}>
                          {' '}({f.severity})
                        </span>
                      </div>
                    ))}
                  </CheckRow>

                  <CheckRow
                    icon={<FlaskConical className="w-4 h-4" />}
                    label={t('checks.testGate')}
                    state={checks.testGate.lastResult === 'pass' ? 'pass' : checks.testGate.lastResult === 'fail' ? 'fail' : 'unknown'}
                    detail={
                      checks.testGate.lastResult === 'pass'
                        ? t('checks.pass')
                        : checks.testGate.lastResult === 'fail'
                          ? t('checks.fail')
                          : t('checks.notRun')
                    }
                  >
                    <div>{t('checks.gateSteps')}: {checks.testGate.steps.join(' + ')}</div>
                    {checks.testGate.detail && <div className="font-mono">{checks.testGate.detail}</div>}
                  </CheckRow>

                  <CheckRow
                    icon={<History className="w-4 h-4" />}
                    label={t('checks.rollback')}
                    state={checks.rollback.available ? 'pass' : 'unknown'}
                    detail={checks.rollback.available ? t('checks.rollbackReady') : t('checks.rollbackNo')}
                  >
                    <div className="font-mono">{checks.rollback.reason}</div>
                  </CheckRow>
                </div>
              </div>

              {/* 决策面板 */}
              {(canDecide || proposal.status === 'approved' || proposal.status === 'applied') && (
                <div className="rounded-lg border border-outline bg-surface p-4 space-y-3">
                  <div className="text-sm font-semibold">{t('decision.title')}</div>
                  {canDecide && (
                    <>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={t('decision.notePlaceholder')}
                        rows={3}
                        className="w-full rounded-md border border-outline bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={actionBusy !== null}
                          onClick={() => doAction('approve', proposal.id)}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          <Check className="w-4 h-4" /> {t('decision.approve')}
                        </button>
                        <button
                          disabled={actionBusy !== null || !note.trim()}
                          onClick={() => doAction('request_changes', proposal.id)}
                          title={!note.trim() ? t('decision.noteRequired') : undefined}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
                        >
                          <MessageSquare className="w-4 h-4" /> {t('decision.requestChanges')}
                        </button>
                        <button
                          disabled={actionBusy !== null}
                          onClick={() => doAction('reject', proposal.id)}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-red-500/50 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          <X className="w-4 h-4" /> {t('decision.reject')}
                        </button>
                      </div>
                    </>
                  )}
                  {proposal.status === 'approved' && (
                    <div className="space-y-2">
                      <button
                        disabled={actionBusy !== null}
                        onClick={() => doAction('apply', proposal.id)}
                        className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        <Rocket className="w-4 h-4" />
                        {actionBusy === 'apply' ? t('decision.applying') : t('decision.apply')}
                      </button>
                      <p className="text-xs text-on-surface-variant">{t('decision.gateNote')}</p>
                    </div>
                  )}
                  {proposal.status === 'applied' && (
                    <button
                      disabled={actionBusy !== null}
                      onClick={() => doAction('rollback', proposal.id)}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                    >
                      <Undo2 className="w-4 h-4" />
                      {actionBusy === 'rollback' ? t('decision.rollingBack') : t('decision.rollback')}
                    </button>
                  )}
                </div>
              )}

              {/* 文件 diff */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">
                  {t('files.title', { count: pack?.files.length ?? 0 })}
                </h3>
                {(pack?.files ?? []).map((f, i) => (
                  <DiffCard key={i} file={f} rationale={rationaleByPath.get(f.filePath)} />
                ))}
              </div>

              {/* 审计时间线 */}
              <div className="rounded-lg border border-outline bg-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-outline text-sm font-semibold flex items-center gap-2">
                  <History className="w-4 h-4 text-primary" />
                  {t('activity.title')}
                </div>
                <div className="divide-y divide-outline">
                  {(pack?.activity ?? []).length === 0 && (
                    <div className="px-4 py-3 text-xs text-on-surface-variant">{t('activity.empty')}</div>
                  )}
                  {(pack?.activity ?? []).map((a) => (
                    <div key={a.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                      <code className="px-1.5 py-0.5 rounded bg-surface-container font-mono">{a.action}</code>
                      <span className="text-on-surface-variant">{a.actorId ?? '—'}</span>
                      <span className="ml-auto text-on-surface-variant">{fmtDateTime(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
