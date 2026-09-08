'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoveCard } from './rove-card';

/** 经营指标卡：指标值 + 同比变化，Insight 优先于图表。 */
export function InsightCard({
  label,
  value,
  delta,
  deltaLabel,
  icon: Icon,
  rise,
  className,
}: {
  label: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  rise?: 0 | 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <RoveCard rise={rise} className={cn('p-5', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className="mt-2.5 text-[26px] leading-8 font-bold tracking-tight font-grotesk">{value}</div>
      {delta !== undefined && (
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-semibold',
              delta >= 0 ? 'text-success' : 'text-destructive'
            )}
          >
            {delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {delta >= 0 ? '+' : ''}
            {delta}%
          </span>
          {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
        </div>
      )}
    </RoveCard>
  );
}
