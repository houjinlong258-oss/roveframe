'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  AlertTriangle, ArrowUpRight, BarChart3, Boxes, Star, TrendingDown, TrendingUp, Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtCurrency } from '@/lib/format';
import type { MissionBoard } from '@/lib/agent/missions';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const TONE_STYLE: Record<Tone, string> = {
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
  neutral: 'text-muted-foreground',
};

/**
 * Insights 模式 —— 经营洞察速览。
 *
 * 数据来自 `/api/agent/missions` 的真实聚合（营收/订单/库存/流失/差评/支付），
 * 不是另起一套 mock。完整 BI（趋势图、渠道、商品排行）仍在经营仪表盘页，
 * 这里给的是「打开工作台先看哪几个数字」。
 */
export function InsightsView({
  board,
  loading,
  className,
}: {
  board: MissionBoard | null;
  loading: boolean;
  className?: string;
}) {
  const t = useTranslations('workspace.insights');
  /** 任务文案复用 agent.missions.items.*，避免重复维护 */
  const tm = useTranslations('agent.missions');
  const locale = useLocale();

  if (loading && !board) {
    return (
      <div className={cn('grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:p-6', className)}>
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-20 animate-pulse rounded-xl border border-border/50 bg-muted/40" />
        ))}
      </div>
    );
  }

  if (!board) {
    return (
      <div className={cn('flex h-full items-center justify-center p-6 text-center', className)}>
        <p className="max-w-xs text-xs text-muted-foreground">{t('empty')}</p>
      </div>
    );
  }

  const s = board.signals;
  const revenueRatio = s.revenuePerDay7d > 0 ? s.revenueToday / s.revenuePerDay7d : null;

  const cards: Array<{
    key: string;
    label: string;
    value: string;
    tone: Tone;
    hint?: string;
    icon: typeof BarChart3;
  }> = [
    {
      key: 'revenue',
      label: t('cards.revenueToday'),
      value: fmtCurrency(s.revenueToday, 'USD', locale),
      tone: revenueRatio === null ? 'neutral' : revenueRatio < 0.85 ? 'bad' : revenueRatio > 1.15 ? 'good' : 'neutral',
      hint: t('vs7d', { value: fmtCurrency(s.revenuePerDay7d, 'USD', locale) }),
      icon: revenueRatio !== null && revenueRatio < 0.85 ? TrendingDown : TrendingUp,
    },
    { key: 'orders', label: t('cards.ordersToday'), value: `${s.ordersToday}`, tone: 'neutral', icon: BarChart3 },
    {
      key: 'inventory',
      label: t('cards.lowStock'),
      value: `${s.lowStockCount}`,
      tone: s.lowStockCount > 0 ? 'bad' : 'good',
      icon: Boxes,
    },
    {
      key: 'churn',
      label: t('cards.churnRisk'),
      value: `${s.churnRiskCount}`,
      tone: s.churnRiskCount > 0 ? 'warn' : 'good',
      icon: Users,
    },
    {
      key: 'reviews',
      label: t('cards.negativeReviews'),
      value: `${s.negativeReviewCount}`,
      tone: s.negativeReviewCount > 0 ? 'bad' : 'good',
      hint: t('pendingReviews', { count: s.pendingReviewCount }),
      icon: Star,
    },
    {
      key: 'approvals',
      label: t('cards.pendingApprovals'),
      value: `${s.pendingApprovals}`,
      tone: s.pendingApprovals > 0 ? 'warn' : 'good',
      icon: AlertTriangle,
    },
  ];

  return (
    <div className={cn('h-full overflow-y-auto p-4 sm:p-6', className)}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {t('openDashboard')}
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.key} className="rounded-xl border border-border/60 bg-card px-3.5 py-3 shadow-card">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                <Icon className="h-3 w-3" />
                {card.label}
              </p>
              <p className={cn('mt-1 text-xl font-bold tabular-nums', TONE_STYLE[card.tone])}>{card.value}</p>
              {card.hint && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{card.hint}</p>}
            </div>
          );
        })}
      </div>

      {board.items.length > 0 && (
        <section className="mt-5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('derived')}
          </p>
          <ul className="space-y-1.5">
            {board.items.map((item) => (
              <li
                key={item.code}
                className="flex items-start gap-2 rounded-lg border border-border/50 px-3 py-2"
              >
                <span className={cn(
                  'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                  item.severity === 'high' ? 'bg-destructive' : item.severity === 'medium' ? 'bg-warning' : 'bg-success',
                )} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium">{tm(`items.${item.code}.title`)}</span>
                  <span className="block text-[10px] text-muted-foreground">{tm(`items.${item.code}.detail`)}</span>
                </span>
                {item.metric && (
                  <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                    {item.metric}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
