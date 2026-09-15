'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Clock3, Loader2, PlayCircle, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtCurrency } from '@/lib/format';
import type { MissionBoard, MissionItem } from '@/lib/agent/missions';

const STATUS_STYLE: Record<MissionItem['status'], { icon: typeof CheckCircle2; className: string }> = {
  action: { icon: AlertCircle, className: 'text-destructive' },
  waiting_approval: { icon: Clock3, className: 'text-warning' },
  clear: { icon: CheckCircle2, className: 'text-success' },
};

/**
 * Agent Mission Panel —— 「这不是聊天机器人，这是一个 AI 员工」。
 *
 * 每一行都来自真实经营数据（服务端 `deriveMissions`），
 * 点击即把该任务的提示词交给 Agent 执行。
 */
export function MissionPanel({
  board,
  agentName,
  loading,
  disabled,
  currency,
  onRun,
  className,
}: {
  board: MissionBoard | null;
  agentName: string;
  loading?: boolean;
  disabled?: boolean;
  currency?: string;
  onRun: (cta: string) => void;
  className?: string;
}) {
  const t = useTranslations('agent.missions');
  const locale = useLocale();

  return (
    <section className={cn('rounded-2xl border border-border/60 bg-card shadow-card', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            {t('label')}
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold">{agentName}</p>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </header>

      {board && (
        <div className="grid grid-cols-2 gap-px border-b border-border/60 bg-border/40 sm:grid-cols-4">
          <Kpi label={t('kpi.revenueToday')} value={fmtCurrency(board.signals.revenueToday, currency ?? 'USD', locale)} />
          <Kpi label={t('kpi.revenue7d')} value={fmtCurrency(board.signals.revenuePerDay7d, currency ?? 'USD', locale)} />
          <Kpi label={t('kpi.ordersToday')} value={`${board.signals.ordersToday}`} />
          <Kpi label={t('kpi.pendingApprovals')} value={`${board.signals.pendingApprovals}`} />
        </div>
      )}

      <ul className="divide-y divide-border/40">
        {!board && !loading && (
          <li className="px-4 py-3 text-xs text-muted-foreground">{t('empty')}</li>
        )}
        {(board?.items ?? []).map((item) => {
          const style = STATUS_STYLE[item.status];
          const Icon = style.icon;
          return (
            <li key={item.code} className="group flex items-start gap-2.5 px-4 py-2.5">
              <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', style.className)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-medium">
                    {t(`items.${item.code}.title`)}
                  </span>
                  {item.metric && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        item.status === 'action'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {item.metric}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {t(`items.${item.code}.detail`)}
                </span>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRun(item.cta)}
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground disabled:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <PlayCircle className="h-3 w-3" />
                {t('run')}
              </button>
            </li>
          );
        })}
        {(board?.activeTasks?.length ?? 0) > 0 && (
          <li className="px-4 py-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t('activeTasks')}
            </p>
            <ul className="space-y-1">
              {board?.activeTasks.map((task) => (
                <li key={task.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Clock3 className="h-3 w-3" />
                  <span className="truncate">{task.name}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                    {task.status}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-4 py-2.5">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
