'use client';

import { cn } from '@/lib/utils';
import { RoveCard, RoveCardHeader } from './rove-card';

export type ActivityItem = {
  id: string;
  time: string;
  agent: string;
  text: string;
  tone?: 'default' | 'success' | 'warning' | 'risk';
};

const TONE_DOT: Record<NonNullable<ActivityItem['tone']>, string> = {
  default: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  risk: 'bg-destructive',
};

/** AI Activity 时间线：AI 团队全天动作的可审计流水。 */
export function ActivityTimeline({
  title,
  items,
  emptyText,
  rise,
  className,
}: {
  title: string;
  items: ActivityItem[];
  emptyText: string;
  rise?: 0 | 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <RoveCard rise={rise} className={cn('p-5', className)}>
      <RoveCardHeader title={title} />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">{emptyText}</p>
      ) : (
        <ol className="relative space-y-4 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-border">
          {items.map((item) => (
            <li key={item.id} className="relative pl-6">
              <span
                className={cn(
                  'absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-card',
                  TONE_DOT[item.tone ?? 'default']
                )}
              />
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-mono text-muted-foreground/80 shrink-0">{item.time}</span>
                <span className="text-xs font-semibold text-primary shrink-0">{item.agent}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{item.text}</p>
            </li>
          ))}
        </ol>
      )}
    </RoveCard>
  );
}
