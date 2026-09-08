'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ShieldCheck, RefreshCw, Check, X, Rocket, Undo2, FileCode2, ChevronRight,
} from 'lucide-react';
import { safeFetchJson } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types（与 /api/coding-agent 返回结构一致）
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
  rollbackCommitSha?: string;
  applyLog?: string;
}

const STATUS_STYLES: Record<ProposalStatus, string> = {
  pending_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  rejected: 'bg-gray-200 text-gray-600',
  changes_requested: 'bg-orange-100 text-orange-800',
  applied: 'bg-green-100 text-green-800',
  apply_failed: 'bg-red-100 text-red-800',
  rolled_back: 'bg-purple-100 text-purple-800',
};

// 经营动作审批（agent_approvals，含 RoveAgent 门控推送的 requires_approval 事件）
interface AgentApproval {
  id: string;
  action_type: string;
  title: string;
  description?: string | null;
  status: 'pending' | 'approved' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';
  tool_name?: string | null;
  risk_level?: string | null;
  required_role?: string | null;
  invocation_id?: string | null;
  execution_id?: string | null;
  created_at: string;
  payload: Record<string, unknown>;
  arguments?: Record<string, unknown> | null;
  agent?: string | null;
  user_id?: string | null;
  requester?: string | null;
  business_id?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  executed_at?: string | null;
  failed_at?: string | null;
  rejected_at?: string | null;
  execution_result?: unknown;
  last_error?: string | null;
  expires_at?: string | null;
}

const BIZ_STATUS_STYLES: Record<AgentApproval['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  executing: 'bg-blue-100 text-blue-800',
  executed: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-200 text-gray-600',
  expired: 'bg-gray-100 text-gray-500',
  failed: 'bg-red-100 text-red-800',
};

const RISK_STYLES: Record<Proposal['riskLevel'], string> = {
  safe: 'bg-green-100 text-green-700',
  moderate: 'bg-amber-100 text-amber-700',
  review_required: 'bg-red-100 text-red-700',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage() {
  const t = useTranslations('approvals');
  const [tab, setTab] = useState<'code' | 'business'>('business');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bizApprovals, setBizApprovals] = useState<AgentApproval[]>([]);
  const [bizLoading, setBizLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    const data = await safeFetchJson<{ proposals: Proposal[] }>('/api/coding-agent?limit=50');
    setProposals(data?.proposals ?? []);
    setLoading(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const data = await safeFetchJson<{ proposal: Proposal }>(
      `/api/coding-agent?id=${encodeURIComponent(id)}`
    );
    setDetail(data?.proposal ?? null);
  }, []);

  const loadBiz = useCallback(async () => {
    setBizLoading(true);
    const data = await safeFetchJson<{ approvals: AgentApproval[] }>('/api/agent/approvals');
    setBizApprovals(data?.approvals ?? []);
    setBizLoading(false);
  }, []);

  useEffect(() => {
    loadList();
    loadBiz();
  }, [loadList, loadBiz]);

  // 审批台轮询：business 标签页可见时每 8 秒刷新（新审批单/执行结果自动可见）。
  useEffect(() => {
    if (tab !== 'business') return;
    const id = setInterval(() => {
      void loadBiz();
    }, 8000);
    return () => clearInterval(id);
  }, [tab, loadBiz]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function bizAction(id: string, action: 'approve' | 'reject') {
    setActionBusy(action);
    setNotice(null);
    try {
      const res = await fetch('/api/agent/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_id: id, action }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setNotice(data?.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
      await loadBiz();
    }
  }

  async function doAction(kind: 'approve' | 'reject' | 'apply' | 'rollback', id: string) {
    setActionBusy(kind);
    setNotice(null);
    try {
      let res: Response;
      if (kind === 'approve' || kind === 'reject') {
        res = await fetch('/api/coding-agent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status: kind === 'approve' ? 'approved' : 'rejected' }),
        });
      } else {
        res = await fetch(`/api/coding-agent/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
      }
      const data = (await res.json().catch(() => null)) as { error?: string; log?: string } | null;
      if (!res.ok) {
        setNotice(data?.error ?? data?.log ?? `HTTP ${res.status}`);
      } else {
        setNotice(null);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
      await loadList();
      await loadDetail(id);
    }
  }

  const selected = detail;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
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
        <div className="px-4 py-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 whitespace-pre-wrap">
          {notice}
        </div>
      )}

      {/* 标签页：代码变更 / 经营动作 */}
      <div className="flex gap-1 border-b border-outline">
        {(['code', 'business'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === k
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {t(`tabs.${k}`)}
            {k === 'business' && bizApprovals.filter((a) => a.status === 'pending').length > 0 && (
              <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                {bizApprovals.filter((a) => a.status === 'pending').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'business' && (
        <div className="rounded-lg border border-outline bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-outline text-sm font-semibold flex items-center justify-between">
            <span>{t('biz.listTitle', { count: bizApprovals.filter((a) => a.status === 'pending').length })}</span>
            <button
              onClick={loadBiz}
              className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface"
            >
              <RefreshCw className="w-3.5 h-3.5" /> {t('refresh')}
            </button>
          </div>
          <div className="divide-y divide-outline">
            {bizLoading && <div className="p-6 text-sm text-on-surface-variant">{t('loading')}</div>}
            {!bizLoading && bizApprovals.length === 0 && (
              <div className="p-6 text-sm text-on-surface-variant">{t('biz.empty')}</div>
            )}
            {bizApprovals.map((a) => {
              const expanded = expandedId === a.id;
              const step = (label: string, done: boolean, failed = false) => (
                <span
                  className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${
                    failed ? 'bg-red-100 text-red-700' : done ? 'bg-green-100 text-green-700' : 'bg-surface-container text-on-surface-variant/60'
                  }`}
                >
                  {done ? <Check className="w-3 h-3" /> : failed ? <X className="w-3 h-3" /> : <span className="w-3 h-3 inline-block border border-current rounded-full" />}
                  {label}
                </span>
              );
              const timeline = [
                { label: t.has('biz.status.pending') ? t('biz.status.pending') : 'Pending', done: true, failed: false, at: a.created_at },
                ...(a.status === 'rejected' ? [{ label: t.has('biz.status.rejected') ? t('biz.status.rejected') : 'Rejected', done: true, failed: false, at: a.rejected_at ?? null }]
                  : a.status === 'expired' ? [{ label: t.has('biz.status.expired') ? t('biz.status.expired') : 'Expired', done: true, failed: false, at: a.expires_at ?? null }]
                  : [
                    { label: t.has('biz.status.approved') ? t('biz.status.approved') : 'Approved', done: Boolean(a.approved_at), failed: false, at: a.approved_at ?? null },
                    { label: t.has('biz.status.executing') ? t('biz.status.executing') : 'Executing', done: Boolean(a.execution_id), failed: false, at: a.executed_at ?? null },
                    { label: t.has('biz.status.executed') ? t('biz.status.executed') : 'Completed', done: a.status === 'executed', failed: false, at: a.executed_at ?? null },
                    ...(a.status === 'failed' ? [{ label: t.has('biz.status.failed') ? t('biz.status.failed') : 'Failed', done: false, failed: true, at: a.failed_at ?? null }] : []),
                  ]),
              ];
              return (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-start gap-4">
                    <button
                      className="flex-1 min-w-0 text-left"
                      onClick={() => setExpandedId(expanded ? null : a.id)}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{a.title}</span>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded ${BIZ_STATUS_STYLES[a.status]}`}>
                          {t(`biz.status.${a.status}`)}
                        </span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                          {t.has(`biz.type.${a.action_type}`) ? t(`biz.type.${a.action_type}`) : a.action_type}
                        </span>
                        {a.risk_level && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-700">
                            {a.risk_level} · {a.required_role}
                          </span>
                        )}
                      </div>
                      {a.description && (
                        <p className="text-xs text-on-surface-variant mt-1">{a.description}</p>
                      )}
                      <div className="text-[11px] text-on-surface-variant mt-1">
                        {fmtDateTime(a.created_at)}
                        <span className="font-mono ml-2">{a.tool_name}{a.execution_id ? ` · ${a.execution_id.slice(0, 8)}` : ''}</span>
                      </div>
                    </button>
                    {a.status === 'pending' && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          disabled={actionBusy !== null}
                          onClick={() => bizAction(a.id, 'approve')}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" /> {t('approve')}
                        </button>
                        <button
                          disabled={actionBusy !== null}
                          onClick={() => bizAction(a.id, 'reject')}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md border border-outline hover:bg-surface-container disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" /> {t('reject')}
                        </button>
                      </div>
                    )}
                  </div>
                  {expanded && (
                    <div className="mt-3 space-y-3 rounded-md bg-surface-container/50 p-3">
                      {/* Request */}
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1">
                          {t.has('biz.request') ? t('biz.request') : 'Request'}
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                          <div><span className="text-on-surface-variant">{t.has('biz.agent') ? t('biz.agent') : 'Agent'}:</span> <span className="font-mono">{a.agent ?? '—'}</span></div>
                          <div><span className="text-on-surface-variant">{t.has('biz.tool') ? t('biz.tool') : 'Tool'}:</span> <span className="font-mono">{a.tool_name ?? '—'}</span></div>
                          <div><span className="text-on-surface-variant">{t.has('biz.business') ? t('biz.business') : 'Business'}:</span> <span className="font-mono">{a.business_id ?? '—'}</span></div>
                          <div><span className="text-on-surface-variant">{t.has('biz.user') ? t('biz.user') : 'User'}:</span> <span className="font-mono">{a.requester ?? a.user_id ?? '—'}</span></div>
                        </div>
                        {a.arguments && (
                          <pre className="mt-2 text-[11px] leading-relaxed bg-surface rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                            {JSON.stringify(a.arguments, null, 2)}
                          </pre>
                        )}
                      </div>
                      {/* Risk */}
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1">
                          {t.has('biz.risk') ? t('biz.risk') : 'Risk'}
                        </p>
                        <div className="flex gap-2 text-xs">
                          <span className="px-2 py-0.5 rounded bg-red-50 text-red-700">{a.risk_level ?? '—'}</span>
                          <span className="px-2 py-0.5 rounded bg-surface text-on-surface-variant">{a.required_role ?? '—'}</span>
                          {a.approved_by && (
                            <span className="px-2 py-0.5 rounded bg-surface text-on-surface-variant">
                              {t.has('biz.approvedBy') ? t('biz.approvedBy') : 'Approved by'}: {a.approved_by}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Execution Status */}
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1">
                          {t.has('biz.executionStatus') ? t('biz.executionStatus') : 'Execution Status'}
                        </p>
                        <div className="flex items-center gap-1 flex-wrap">
                          {timeline.map((s, idx) => (
                            <span key={idx} className="inline-flex items-center gap-1">
                              {step(s.label, s.done, s.failed)}
                              {s.at && <span className="text-[10px] text-on-surface-variant/70">{fmtDateTime(s.at)}</span>}
                              {idx < timeline.length - 1 && <span className="text-on-surface-variant/40">→</span>}
                            </span>
                          ))}
                        </div>
                        {a.status === 'executing' && (
                          <p className="text-xs text-blue-700 mt-1">{t.has('biz.executingHint') ? t('biz.executingHint') : 'Executing the approved action…'}</p>
                        )}
                      </div>
                      {/* Result */}
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1">
                          {t.has('biz.result') ? t('biz.result') : 'Result'}
                        </p>
                        {a.execution_result !== undefined && a.execution_result !== null ? (
                          <pre className="text-[11px] leading-relaxed bg-surface rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                            {typeof a.execution_result === 'string' ? a.execution_result : JSON.stringify(a.execution_result, null, 2)}
                          </pre>
                        ) : a.last_error ? (
                          <p className="text-xs text-red-700 whitespace-pre-wrap">{a.last_error}</p>
                        ) : (
                          <p className="text-xs text-on-surface-variant">{t.has('biz.noResult') ? t('biz.noResult') : 'No execution result yet.'}</p>
                        )}
                      </div>
                      {/* Audit */}
                      <div>
                        <a
                          href={`/audit?approval_id=${encodeURIComponent(a.id)}`}
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          <FileCode2 className="w-3.5 h-3.5" />
                          {t.has('biz.viewAudit') ? t('biz.viewAudit') : 'View audit trail'}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'code' && (
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5">
        {/* 提案列表 */}
        <div className="rounded-lg border border-outline bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-outline text-sm font-semibold">
            {t('listTitle', { count: proposals.length })}
          </div>
          <div className="divide-y divide-outline max-h-[70vh] overflow-y-auto">
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
                <div className="flex items-center gap-2 mt-1.5">
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

        {/* 详情 / Diff 预览 / 操作 */}
        <div className="rounded-lg border border-outline bg-surface min-h-[40vh]">
          {!selected && (
            <div className="p-10 text-center text-sm text-on-surface-variant">
              {t('selectPrompt')}
            </div>
          )}
          {selected && (
            <div className="p-5 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{selected.title}</h2>
                <p className="text-sm text-on-surface-variant mt-1">{selected.summary}</p>
                <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-on-surface-variant">
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_STYLES[selected.status]}`}>
                    {t(`status.${selected.status}`)}
                  </span>
                  <span>{t('generatedAt')}: {fmtDateTime(selected.generatedAt)}</span>
                  {selected.model && <span>· {selected.model}</span>}
                  {selected.decidedAt && (
                    <span>· {t('decidedAt')}: {fmtDateTime(selected.decidedAt)}</span>
                  )}
                  {selected.appliedCommitSha && (
                    <span>· commit: <code>{selected.appliedCommitSha.slice(0, 8)}</code></span>
                  )}
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex flex-wrap gap-2">
                {selected.status === 'pending_review' && (
                  <>
                    <button
                      disabled={actionBusy !== null}
                      onClick={() => doAction('approve', selected.id)}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" /> {t('approve')}
                    </button>
                    <button
                      disabled={actionBusy !== null}
                      onClick={() => doAction('reject', selected.id)}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-outline hover:bg-surface-container disabled:opacity-50"
                    >
                      <X className="w-4 h-4" /> {t('reject')}
                    </button>
                  </>
                )}
                {selected.status === 'approved' && (
                  <button
                    disabled={actionBusy !== null}
                    onClick={() => doAction('apply', selected.id)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    <Rocket className="w-4 h-4" />
                    {actionBusy === 'apply' ? t('applying') : t('apply')}
                  </button>
                )}
                {selected.status === 'applied' && (
                  <button
                    disabled={actionBusy !== null}
                    onClick={() => doAction('rollback', selected.id)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                  >
                    <Undo2 className="w-4 h-4" />
                    {actionBusy === 'rollback' ? t('rollingBack') : t('rollback')}
                  </button>
                )}
              </div>

              {/* 变更清单 */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">
                  {t('changesTitle', { count: selected.changes.length })}
                </h3>
                {selected.changes.map((c, i) => (
                  <div key={i} className="rounded-md border border-outline overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-2 bg-surface-container text-xs">
                      <FileCode2 className="w-3.5 h-3.5" />
                      <code className="font-medium">{c.filePath}</code>
                      <span className="ml-auto uppercase tracking-wide text-on-surface-variant">
                        {c.operation}
                      </span>
                    </div>
                    <p className="px-3 py-2 text-xs text-on-surface-variant border-b border-outline">
                      {c.rationale}
                    </p>
                    {c.proposedContent && (
                      <pre className="p-3 text-xs overflow-x-auto max-h-72 overflow-y-auto bg-[#0D0D0D] text-[#A7FF00]">
                        {c.proposedContent}
                      </pre>
                    )}
                  </div>
                ))}
              </div>

              {/* Apply 日志 */}
              {selected.applyLog && (
                <div>
                  <h3 className="text-sm font-semibold mb-1.5">{t('applyLog')}</h3>
                  <pre className="p-3 text-xs rounded-md bg-surface-container overflow-x-auto whitespace-pre-wrap">
                    {selected.applyLog}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
