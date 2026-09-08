'use client';

import { Check, Eye, Play, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoveCard } from './rove-card';

/**
 * AI 建议卡：老板只管理目标 —— Approve / Review / Execute 三态操作。
 * tone: opportunity（酸绿）/ risk（红）/ neutral（默认）
 */
export function AIRecommendation({
  agentName,
  title,
  description,
  tone = 'neutral',
  approveLabel,
  reviewLabel,
  executeLabel,
  onApprove,
  onReview,
  onExecute,
  rise,
  className,
}: {
  agentName?: string;
  title: string;
  description: string;
  tone?: 'opportunity' | 'risk' | 'neutral';
  approveLabel: string;
  reviewLabel: string;
  executeLabel: string;
  onApprove?: () => void;
  onReview?: () => void;
  onExecute?: () => void;
  rise?: 0 | 1 | 2 | 3 | 4;
  className?: string;
}) {
  const toneBadge =
    tone === 'opportunity'
      ? 'bg-accent/20 text-accent-foreground dark:text-accent'
      : tone === 'risk'
        ? 'bg-destructive/15 text-destructive'
        : 'bg-primary/10 text-primary';

  return (
    <RoveCard rise={rise} className={cn('p-5', className)}>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-6 h-6 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
          <Sparkles className="w-3.5 h-3.5" />
        </span>
        {agentName && (
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold', toneBadge)}>
            {agentName}
          </span>
        )}
      </div>
      <h3 className="text-sm font-bold tracking-tight">{title}</h3>
      <p className="text-xs text-muted-foreground leading-relaxed mt-1.5">{description}</p>
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 active:scale-[0.97] transition-all"
        >
          <Check className="w-3.5 h-3.5" />
          {approveLabel}
        </button>
        <button
          onClick={onReview}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-muted text-foreground text-xs font-semibold hover:bg-muted/70 active:scale-[0.97] transition-all"
        >
          <Eye className="w-3.5 h-3.5" />
          {reviewLabel}
        </button>
        <button
          onClick={onExecute}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-foreground/30 active:scale-[0.97] transition-all"
        >
          <Play className="w-3.5 h-3.5" />
          {executeLabel}
        </button>
      </div>
    </RoveCard>
  );
}
