'use client';

import { useTranslations } from 'next-intl';
import {
  CheckCircle2, Clock3, Loader2, ShieldCheck, Sparkles, Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ApprovalCardPayload } from '@/lib/agent/stream-events';

export interface TaskRun {
  key: string;
  title: string;
  at: string;
  running: boolean;
  steps: Array<{ key: string; label: string; done: boolean }>;
  error?: string | null;
}

/**
 * Tasks 模式 —— Agent 执行视图（类似 Cursor 的 agent 运行视图）。
 *
 * 与 Chat 的区别：Chat 关注「说了什么」，Tasks 关注「做了什么」——
 * 每一步工具调用、每次生成文件、每个待审批动作都在时间线上。
 */
export function TasksView({
  runs,
  approvals,
  scheduled,
  onOpenChat,
  className,
}: {
  runs: TaskRun[];
  approvals: ApprovalCardPayload[];
  scheduled: Array<{ id: string; name: string; status: string; nextRunAt: string | null }>;
  onOpenChat: () => void;
  className?: string;
}) {
  const t = useTranslations('workspace.tasks');
  /** 风险等级文案复用 agent.approval.risk.* */
  const ta = useTranslations('agent.approval');
  const pending = approvals.filter((item) => item.status === 'pending' || item.status === 'executing');

  return (
    <div className={cn('h-full overflow-y-auto px-4 py-4 sm:px-6', className)}>
      <header className="mb-4">
        <h2 className="font-display text-lg font-bold tracking-tight">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('subtitle')}</p>
      </header>

      {pending.length > 0 && (
        <section className="mb-4 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-warning">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('waitingApproval')}
          </p>
          <ul className="mt-2 space-y-1">
            {pending.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-[12px]">
                <Clock3 className="h-3 w-3 shrink-0 text-warning" />
                <span className="truncate">{item.title}</span>
                <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                  {ta(`risk.${item.riskLevel}` as 'risk.medium')}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onOpenChat}
            className="mt-2 text-[11px] text-primary underline-offset-2 hover:underline"
          >
            {t('decideInChat')}
          </button>
        </section>
      )}

      <section className="space-y-2">
        {runs.length === 0 && (
          <p className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
            {t('empty')}
          </p>
        )}
        {runs.map((run) => {
          const done = run.steps.filter((step) => step.done).length;
          return (
            <article key={run.key} className="rounded-xl border border-border/60 bg-card px-4 py-3 shadow-card">
              <header className="flex items-center gap-2">
                <span className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md',
                  run.running ? 'bg-primary' : 'bg-muted',
                )}>
                  <Sparkles className={cn('h-3.5 w-3.5', run.running ? 'text-primary-foreground' : 'text-muted-foreground')} />
                </span>
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.title}</p>
                <span className="shrink-0 text-[10px] text-muted-foreground">{run.at}</span>
              </header>

              {run.steps.length > 0 && (
                <ul className="mt-2.5 space-y-1 border-l border-border/50 pl-3">
                  {run.steps.map((step) => (
                    <li key={step.key} className="flex items-center gap-1.5 text-[11px]">
                      {step.done
                        ? <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
                        : <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
                      <Wrench className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                      <span className={cn('truncate', step.done ? 'text-muted-foreground' : 'text-foreground')}>
                        {step.label}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-2 text-[10px] text-muted-foreground">
                {run.running ? t('running', { done, total: run.steps.length }) : t('done', { total: run.steps.length })}
              </p>

              {run.error && (
                <p className="mt-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                  {run.error}
                </p>
              )}
            </article>
          );
        })}
      </section>

      {scheduled.length > 0 && (
        <section className="mt-5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('scheduled')}
          </p>
          <ul className="space-y-1.5">
            {scheduled.map((task) => (
              <li key={task.id} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-[12px]">
                <Clock3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{task.name}</span>
                <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{task.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
