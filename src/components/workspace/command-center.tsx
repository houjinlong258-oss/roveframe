'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  AlertCircle, Bell, CheckCircle2, ChevronRight, Clock3, Loader2, RefreshCw,
  ShieldCheck, Sparkles, Target, TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtCurrency } from '@/lib/format';
import type { MissionBoard, MissionItem } from '@/lib/agent/missions';
import type { ApprovalCardPayload } from '@/lib/agent/stream-events';

const SEVERITY_DOT: Record<MissionItem['severity'], string> = {
  high: 'bg-destructive',
  medium: 'bg-warning',
  low: 'bg-success',
};

const STATUS_STYLE: Record<MissionItem['status'], { icon: typeof CheckCircle2; tone: string }> = {
  action: { icon: AlertCircle, tone: 'text-destructive' },
  waiting_approval: { icon: Clock3, tone: 'text-warning' },
  clear: { icon: CheckCircle2, tone: 'text-success' },
};

export interface CommandCenterProps {
  agentName: string;
  board: MissionBoard | null;
  loading: boolean;
  /** 拉取失败与「真的没有信号」必须分开呈现，否则用户以为系统坏了 */
  failed: boolean;
  onRetry: () => void;
  runningSteps: Array<{ key: string; label: string; done: boolean }>;
  running: boolean;
  approvals: ApprovalCardPayload[];
  currency?: string;
  onRunMission: (cta: string) => void;
  onOpenApprovals: () => void;
  onOpenArtifact: (id: string) => void;
  className?: string;
}

/**
 * AI Command Center —— 右侧「指挥中心」。
 *
 * 定位：老板扫一眼就知道「今天该关心什么、AI 正在干什么、有什么等我拍板」。
 * 四个分区：Agent 状态 / 今日任务 / 待审批 / AI 建议。
 */
export function CommandCenter({
  agentName, board, loading, failed, onRetry,
  runningSteps, running, approvals, currency,
  onRunMission, onOpenApprovals, onOpenArtifact, className,
}: CommandCenterProps) {
  const t = useTranslations('workspace.command');
  /** 任务文案复用 agent.missions.items.*，避免同一批任务维护两份三语文案 */
  const tm = useTranslations('agent.missions');
  const locale = useLocale();

  const openApprovals = approvals.filter((item) => item.status === 'pending' || item.status === 'executing');
  const actionItems = (board?.items ?? []).filter((item) => item.status === 'action');

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto', className)}>
      {/* Agent 状态：AI 正在做什么 */}
      <section className="border-b border-border/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md bg-primary',
            running && 'rove-live-dot',
          )}>
            <Sparkles className="h-3.5 w-3.5 text-primary-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold">{agentName}</p>
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {running ? (
                <>
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  {t('working')}
                </>
              ) : (
                <>
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  {t('idle')}
                </>
              )}
            </p>
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>

        {runningSteps.length > 0 && (
          <ul className="mt-2.5 space-y-1 border-l border-border/50 pl-3">
            {runningSteps.map((step) => (
              <li key={step.key} className="flex items-center gap-1.5 text-[11px]">
                {step.done
                  ? <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
                  : <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
                <span className={cn('truncate', step.done ? 'text-muted-foreground' : 'text-foreground')}>
                  {step.label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 今日任务 */}
      <section className="border-b border-border/40">
        <header className="flex items-center justify-between px-4 pb-1 pt-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            <Target className="h-3 w-3" />
            {t('missions')}
          </p>
          {failed && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              {t('retry')}
            </button>
          )}
        </header>

        {board && (
          <div className="grid grid-cols-2 gap-px bg-border/30">
            <Kpi label={t('kpi.revenueToday')} value={fmtCurrency(board.signals.revenueToday, currency ?? 'USD', locale)} />
            <Kpi label={t('kpi.ordersToday')} value={`${board.signals.ordersToday}`} />
          </div>
        )}

        <ul className="px-2 py-1.5">
          {failed && (
            <li className="px-2 py-2 text-[11px] text-warning">{t('loadFailed')}</li>
          )}
          {!failed && !board && loading && (
            <li className="space-y-1.5 px-2 py-2">
              {/* 骨架屏：避免「空态」在加载期间闪一下让人误以为坏了 */}
              <span className="block h-3 w-3/4 animate-pulse rounded bg-muted" />
              <span className="block h-3 w-2/3 animate-pulse rounded bg-muted" />
              <span className="block h-3 w-1/2 animate-pulse rounded bg-muted" />
            </li>
          )}
          {!failed && !board && !loading && (
            <li className="px-2 py-2 text-[11px] text-muted-foreground">{t('empty')}</li>
          )}
          {(board?.items ?? []).map((item) => {
            const style = STATUS_STYLE[item.status];
            const Icon = style.icon;
            return (
              <li key={item.code} className="group">
                <button
                  type="button"
                  disabled={running}
                  onClick={() => onRunMission(item.cta)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[item.severity])} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[12px] font-medium">{tm(`items.${item.code}.title`)}</span>
                      {item.metric && (
                        <span className={cn(
                          'shrink-0 rounded-full px-1.5 text-[9px] font-semibold',
                          item.status === 'action' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                        )}>
                          {item.metric}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {tm(`items.${item.code}.detail`)}
                    </span>
                  </span>
                  <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', style.tone)} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 待审批 */}
      <section className="border-b border-border/40">
        <button
          type="button"
          onClick={onOpenApprovals}
          className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            <ShieldCheck className="h-3 w-3" />
            {t('approvals')}
          </span>
          <span className="flex items-center gap-1.5">
            {openApprovals.length > 0 ? (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
                {openApprovals.length}
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground">{t('noApprovals')}</span>
            )}
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </span>
        </button>
        {openApprovals.length > 0 && (
          <ul className="px-4 pb-3">
            {openApprovals.slice(0, 3).map((item) => (
              <li key={item.id} className="flex items-center gap-2 py-0.5 text-[11px]">
                <span className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  item.riskLevel === 'high' || item.riskLevel === 'critical' ? 'bg-destructive' : 'bg-warning',
                )} />
                <span className="truncate text-muted-foreground">{item.title}</span>
              </li>
            ))}
            <li className="pt-1">
              <button
                type="button"
                onClick={onOpenApprovals}
                className="text-[10px] text-primary underline-offset-2 hover:underline"
              >
                {t('decideInChat')}
              </button>
            </li>
          </ul>
        )}
      </section>

      {/* AI 建议：从真实信号推导，不是写死的文案 */}
      <section className="px-4 py-3">
        <p className="flex items-center gap-1.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          <TrendingUp className="h-3 w-3" />
          {t('recommendations')}
        </p>
        {actionItems.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t('noRecommendations')}</p>
        ) : (
          <ul className="space-y-1.5">
            {actionItems.slice(0, 3).map((item) => (
              <li key={`rec-${item.code}`}>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => onRunMission(item.cta)}
                  className="w-full rounded-lg border border-border/50 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/50 disabled:opacity-50"
                >
                  <span className="block text-[11px] font-medium">{tm(`items.${item.code}.title`)}</span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {tm(`items.${item.code}.detail`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {(board?.activeTasks?.length ?? 0) > 0 && (
          <>
            <p className="flex items-center gap-1.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              <Bell className="h-3 w-3" />
              {t('scheduled')}
            </p>
            <ul className="space-y-1">
              {board?.activeTasks.map((task) => (
                <li key={task.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Clock3 className="h-3 w-3 shrink-0" />
                  <button
                    type="button"
                    className="truncate text-left hover:text-foreground"
                    onClick={() => onOpenArtifact(task.id)}
                  >
                    {task.name}
                  </button>
                  <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px]">{task.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-4 py-2">
      <p className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="truncate text-[13px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}
