'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoveCard } from './rove-card';

/**
 * 经营指标卡：指标值 + 同比变化，Insight 优先于图表。
 *
 * `delta` 的三态是刻意区分的（Phase 16 任务 1）：
 *   - `null` / `undefined` → **没有对比依据**，显示 `—` 与原因文案；
 *   - `0`                  → 有依据且确实持平，显示 `+0%`；
 *   - 其他数字              → 正常涨跌。
 *
 * 为什么不能把 `null` 当成 0：`+0%` 是一个断言（"与上期持平"），
 * 而"没有对比期数据"不是持平。此前的实现在路由层就把无依据的 delta 写成了
 * 常数（8.4 / 5.2 / 1.2），于是一个刚注册、零数据的商家会看到编造的增长。
 */
export function InsightCard({
  label,
  value,
  delta,
  deltaLabel,
  noBasisLabel,
  icon: Icon,
  rise,
  className,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaLabel?: string;
  /** delta 为 null 时显示的说明（i18n 文案由调用方注入） */
  noBasisLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  rise?: 0 | 1 | 2 | 3 | 4;
  className?: string;
}) {
  const hasBasis = typeof delta === 'number' && Number.isFinite(delta);
  return (
    <RoveCard rise={rise} className={cn('p-5', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className="mt-2.5 text-[26px] leading-8 font-bold tracking-tight font-grotesk">{value}</div>
      {hasBasis ? (
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
      ) : (
        <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="font-semibold">—</span>
          {noBasisLabel && <span>{noBasisLabel}</span>}
        </div>
      )}
    </RoveCard>
  );
}
