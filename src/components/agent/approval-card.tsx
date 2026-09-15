'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle, CheckCircle2, Clock3, Loader2, Pencil, ShieldCheck, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ApprovalCardPayload } from '@/lib/agent/stream-events';

type Decision = 'approve' | 'reject';

const RISK_STYLE: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-warning/15 text-warning',
  high: 'bg-destructive/10 text-destructive',
  critical: 'bg-destructive/20 text-destructive',
};

const STATUS_STYLE: Record<string, { icon: typeof Clock3; className: string }> = {
  pending: { icon: Clock3, className: 'text-warning' },
  approved: { icon: ShieldCheck, className: 'text-primary' },
  executing: { icon: Loader2, className: 'text-primary' },
  executed: { icon: CheckCircle2, className: 'text-success' },
  completed: { icon: CheckCircle2, className: 'text-success' },
  rejected: { icon: XCircle, className: 'text-destructive' },
  failed: { icon: AlertTriangle, className: 'text-destructive' },
  expired: { icon: Clock3, className: 'text-muted-foreground' },
};

/**
 * 聊天内审批卡片。
 *
 * **这是 UI 入口，不是绕过审批系统**：点「批准」调用的仍然是
 * `POST /api/agent/approvals` → `processApproval`，RBAC、参数哈希、
 * 审计日志、exactly-once 执行控制全部原样生效。
 *
 * 独立审批中心保留为历史/审计/批量管理的补充入口。
 */
export function ApprovalCard({
  approval,
  onDecided,
  onModify,
  className,
}: {
  approval: ApprovalCardPayload;
  onDecided?: (id: string, status: string) => void;
  /** 点「修改方案」时把当前输入框改成让 Agent 重做 */
  onModify?: (approval: ApprovalCardPayload) => void;
  className?: string;
}) {
  const t = useTranslations('agent.approval');
  const [status, setStatus] = useState(approval.status);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  const style = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  const StatusIcon = style.icon;
  const isPending = status === 'pending';

  const decide = async (action: Decision) => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/agent/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_id: approval.id, action }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
      };
      if (!response.ok || data.error) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      const next = data.status ?? (action === 'approve' ? 'approved' : 'rejected');
      setStatus(next);
      onDecided?.(approval.id, next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  };

  const summaryEntries = Object.entries(approval.summary ?? {}).slice(0, 8);

  return (
    <section
      className={cn(
        'my-3 overflow-hidden rounded-xl border border-warning/40 bg-warning/5',
        !isPending && 'border-border/60 bg-card',
        className,
      )}
    >
      <header className="flex items-start gap-2.5 px-4 pt-3.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('label')}
          </p>
          <p className="mt-0.5 text-sm font-semibold">{approval.title}</p>
          {approval.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{approval.description}</p>
          )}
        </div>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold', RISK_STYLE[approval.riskLevel] ?? RISK_STYLE.medium)}>
          {t(`risk.${approval.riskLevel}` as 'risk.medium')}
        </span>
      </header>

      {summaryEntries.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 px-4 sm:grid-cols-3">
          {summaryEntries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{key}</dt>
              <dd className="truncate text-[12px] font-medium tabular-nums">
                {value === null ? '—' : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-3">
        <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', style.className)}>
          <StatusIcon className={cn('h-3.5 w-3.5', status === 'executing' && 'animate-spin')} />
          {t(`status.${status}` as 'status.pending')}
        </span>

        {isPending && approval.canDecide && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void decide('approve')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'approve' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              {t('approve')}
            </button>
            <button
              type="button"
              onClick={() => onModify?.(approval)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Pencil className="h-3 w-3" />
              {t('modify')}
            </button>
            <button
              type="button"
              onClick={() => void decide('reject')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {busy === 'reject' ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
              {t('reject')}
            </button>
          </span>
        )}

        {isPending && !approval.canDecide && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t('needsRole', { role: approval.requiredRole })}
          </span>
        )}

        <button
          type="button"
          onClick={() => setShowAudit((prev) => !prev)}
          className={cn('text-[11px] text-muted-foreground underline-offset-2 hover:underline', isPending && approval.canDecide ? '' : 'ml-auto')}
        >
          {t('audit')}
        </button>
      </div>

      {showAudit && (
        <dl className="space-y-1 border-t border-border/50 bg-muted/40 px-4 py-2.5 text-[11px] text-muted-foreground">
          <div className="flex gap-2"><dt className="w-24 shrink-0">{t('auditFields.action')}</dt><dd className="font-mono">{approval.actionType}</dd></div>
          <div className="flex gap-2"><dt className="w-24 shrink-0">{t('auditFields.id')}</dt><dd className="truncate font-mono">{approval.id}</dd></div>
          <div className="flex gap-2"><dt className="w-24 shrink-0">{t('auditFields.requiredRole')}</dt><dd>{approval.requiredRole}</dd></div>
          <div className="flex gap-2"><dt className="w-24 shrink-0">{t('auditFields.createdAt')}</dt><dd>{approval.createdAt}</dd></div>
        </dl>
      )}

      {error && (
        <p className="flex items-start gap-1.5 border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </section>
  );
}
