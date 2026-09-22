'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import {
  Banknote, Receipt, Footprints, Heart, Sparkles,
  Crown, Boxes, Megaphone, HeartHandshake, Package,
  MessageSquareWarning, Star, UserCheck,
} from 'lucide-react';
import { fmtCurrency, fmtDate, timeAgo } from '@/lib/format';
import { cn, safeFetchJson } from '@/lib/utils';
import { CommandPanel } from '@/components/rove/command-panel';
import { AgentCard, type AgentStatus } from '@/components/rove/agent-card';
import { InsightCard } from '@/components/rove/insight-card';
import { AIRecommendation } from '@/components/rove/ai-recommendation';
import { ActivityTimeline, type ActivityItem } from '@/components/rove/activity-timeline';
import { RoveCard, RoveCardHeader } from '@/components/rove/rove-card';

type DashboardData = {
  kpi: {
    todayRevenue: number; todayOrders: number; todayCustomers: number;
    positiveRate: number; avgRating: number;
    // null = 没有对比依据（对比期无数据），UI 显示 —，不得回落成 0
    revenueDelta: number | null; ordersDelta: number | null;
    customersDelta: number | null; ratingDelta: number | null;
  };
  basis?: {
    periodStart: string; periodEnd: string;
    priorPeriodStart: string; priorPeriodEnd: string;
    hasPriorBasis: boolean;
  };
  /** 仅演示模式返回；真实路径不返回此字段 */
  demo?: boolean;
  revenueTrend: { date: string; amount: number }[];
  channels: { channel: string; count: number; pct: number }[];
  topDishes: { name: string; quantity: number; revenue: number }[];
  orderIntel: {
    hotHours: { hour: number; orders: number; revenue: number }[];
    combos: { combo: string; count: number }[];
    repeat: { repeatCustomers: number; totalBuyers: number; rate: number };
  };
  totals: { customers: number; churnHigh: number };
  alerts: { id: string; type: string; title: string; content: string; created_at: string }[];
};

const CHANNEL_COLORS = ['#A7FF00', '#16A37B', '#E8930C', '#E5484D', '#637089'];
const CHANNEL_KEYS: Record<string, string> = {
  dine_in: 'dineIn', delivery: 'delivery', takeout: 'takeout',
  online_store: 'onlineStore', square_pos: 'dineIn', shopify: 'onlineStore',
};

/** 告警类型 → 负责的 AI 员工（AI Activity 归属） */
const ALERT_AGENT: Record<string, string> = {
  review: 'Customer Agent',
  customer: 'Customer Agent',
  inventory: 'Operations Agent',
  order: 'Operations Agent',
  email: 'CEO Agent',
};

const ALERT_TONE: Record<string, ActivityItem['tone']> = {
  review: 'risk',
  customer: 'warning',
  inventory: 'warning',
  order: 'default',
  email: 'default',
};

/**
 * 经营仪表盘，路径 `/<locale>/dashboard`。
 *
 * Phase 15：本文件此前是 `[locale]/page.tsx`。为了给未登录访客一个真正的落地页，
 * `/` 改由 `(marketing)` 路由组承担；仪表盘整体搬到这里，**组件体未改动**。
 *
 * 仍然套在 `[locale]/layout.tsx` 的 AppShell 里，因此侧栏、顶栏、
 * 会话守卫（401 → 登录页）行为与搬迁前完全一致。
 */
export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const router = useRouter();
  const [range, setRange] = useState(7);
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/dashboard?range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d === 'object' && d.kpi && typeof d.kpi === 'object') {
          setData(d as DashboardData);
        }
      })
      .catch(() => {});
  }, [range]);

  const kpi = data?.kpi;
  const alerts = data?.alerts ?? [];
  const churnHigh = data?.totals.churnHigh ?? 0;
  const reviewAlerts = alerts.filter((a) => a.type === 'review').length;
  const inventoryAlerts = alerts.filter((a) => a.type === 'inventory').length;
  /**
   * 演示数据标记（Phase 18 审计修复）。
   *
   * `/api/dashboard` 在演示模式下（`RF_E2E_DEMO=1` 且非生产）返回的整套数字
   * **是编造的**（`Math.round((18 + i * 0.6) * ...)`），并带 `demo: true`。
   *
   * 实测：这个字段在类型里声明了、接口也返回了，但**页面从来没有读过它** ——
   * 也就是说演示数据与真实经营数据在界面上完全无法区分。一个截图被当成经营
   * 事实传出去，是这套系统里最不该发生的事（Phase 16 的任务 1 修的就是
   * "仪表盘对零数据账户编造增长"）。
   *
   * 修法不是在接口层删演示模式（它是刻意的 E2E / 截图能力），而是让**看到它的
   * 人知道自己在看什么**。
   */
  const isDemoData = data?.demo === true;

  // —— AI 员工团队实时状态（全部来自真实经营数据） ——
  const team = useMemo(() => {
    const has = data !== null;
    return [
      {
        key: 'ceo', name: t('agentCeo'), role: t('agentCeoRole'), icon: Crown,
        status: (has ? 'active' : 'thinking') as AgentStatus,
        task: has
          ? t('agentCeoTask', {
              revenue: fmtCurrency(kpi?.todayRevenue ?? 0),
              delta: `${(kpi?.revenueDelta ?? 0) >= 0 ? '+' : ''}${kpi?.revenueDelta ?? 0}%`,
            })
          : t('agentAnalyzing'),
        last: t('agentCeoLast'),
      },
      {
        key: 'ops', name: t('agentOps'), role: t('agentOpsRole'), icon: Boxes,
        status: (inventoryAlerts > 0 ? 'attention' : has ? 'active' : 'thinking') as AgentStatus,
        task: inventoryAlerts > 0 ? t('agentOpsTaskRisk', { count: inventoryAlerts }) : t('agentOpsTaskOk'),
        last: t('agentOpsLast'),
      },
      {
        key: 'mkt', name: t('agentMarketing'), role: t('agentMarketingRole'), icon: Megaphone,
        status: (has ? 'active' : 'thinking') as AgentStatus,
        task: t('agentMarketingTask', { count: churnHigh }),
        last: t('agentMarketingLast'),
      },
      {
        key: 'cust', name: t('agentCustomer'), role: t('agentCustomerRole'), icon: HeartHandshake,
        status: (reviewAlerts > 0 ? 'attention' : has ? 'active' : 'thinking') as AgentStatus,
        task: reviewAlerts > 0 ? t('agentCustomerTaskRisk', { count: reviewAlerts }) : t('agentCustomerTaskOk'),
        last: t('agentCustomerLast'),
      },
    ];
  }, [data, inventoryAlerts, reviewAlerts, churnHigh, kpi, t]);

  // —— AI Activity：真实告警流水按时间倒序 ——
  const activity: ActivityItem[] = useMemo(
    () =>
      alerts.slice(0, 7).map((a) => ({
        id: a.id,
        time: timeAgo(a.created_at, locale),
        agent: ALERT_AGENT[a.type] ?? 'CEO Agent',
        text: `${a.title} — ${a.content}`,
        tone: ALERT_TONE[a.type] ?? 'default',
      })),
    [alerts, locale]
  );

  // —— 首要 AI 建议（按数据严重度排序取第一条） ——
  const recommendation = useMemo(() => {
    if (churnHigh > 0) {
      return {
        tone: 'risk' as const,
        agent: t('agentCustomer'),
        title: t('recChurnTitle', { count: churnHigh }),
        desc: t('recChurnDesc'),
        href: '/marketing?brief=win-back',
      };
    }
    if (reviewAlerts > 0) {
      return {
        tone: 'risk' as const,
        agent: t('agentCustomer'),
        title: t('recReviewTitle', { count: reviewAlerts }),
        desc: t('recReviewDesc'),
        href: '/reviews?filter=pending',
      };
    }
    return {
      tone: 'opportunity' as const,
      agent: t('agentMarketing'),
      title: t('recGrowthTitle'),
      desc: t('recGrowthDesc', {
        revenue: fmtCurrency(Math.max(...(data?.revenueTrend ?? [{ amount: 0 }]).map((p) => p.amount), 0)),
      }),
      href: '/marketing?brief=weekend-promo',
    };
  }, [churnHigh, reviewAlerts, data, t]);

  // 营收趋势 SVG
  const trend = data?.revenueTrend ?? [];
  const maxAmount = Math.max(...trend.map((p) => p.amount), 1);
  const chartW = 560, chartH = 185, padX = 20;
  const points = trend.map((p, i) => {
    const x = padX + (i * (chartW - padX * 2)) / Math.max(trend.length - 1, 1);
    const y = chartH - 35 - (p.amount / maxAmount) * 130;
    return { x, y, ...p };
  });
  const linePath = points.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath = points.length ? `${linePath} ${points[points.length - 1].x},${chartH} ${padX},${chartH}` : '';

  // 渠道圆环
  const channels = data?.channels ?? [];
  const totalChannelCount = channels.reduce((s, c) => s + c.count, 0);
  const cumPcts = channels.reduce<number[]>((sums, c) => [...sums, (sums[sums.length - 1] ?? 0) + c.pct], []);
  const gradientStops = channels.map((c, i) => {
    const start = i === 0 ? 0 : cumPcts[i - 1];
    return `${CHANNEL_COLORS[i % CHANNEL_COLORS.length]} ${start}% ${cumPcts[i]}%`;
  }).join(', ');

  return (
    <div>
      {/* ===== AI Business Command Center · Hero ===== */}
      <CommandPanel
        ownerName="Adam"
        greetingMorning={t('greetingMorning')}
        greetingAfternoon={t('greetingAfternoon')}
        greetingEvening={t('greetingEvening')}
        teamSummary={t('commandSummary')}
        headline={
          kpi
            ? t('commandHeadline', {
                delta: `${(kpi.revenueDelta ?? 0) >= 0 ? '+' : ''}${kpi.revenueDelta ?? 0}%`,
                orders: kpi.todayOrders ?? 0,
              })
            : undefined
        }
      >
        {/* 时间范围切换 */}
        <div className="inline-flex bg-white/10 backdrop-blur-sm rounded-full p-1">
          {[7, 30].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'px-4 py-1.5 text-xs font-semibold rounded-full transition-all',
                range === r ? 'bg-accent text-accent-foreground shadow' : 'text-white/70 hover:text-white'
              )}
            >
              {r === 7 ? t('range7') : t('range30')}
            </button>
          ))}
        </div>
      </CommandPanel>

      {/* ===== Your AI Team ===== */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-bold tracking-tight">{t('yourTeam')}</h2>
        <Link href="/agent" className="text-xs font-semibold text-primary hover:underline">
          {t('openCommand')} →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {team.map((a, i) => (
          <AgentCard
            key={a.key}
            rise={(i + 1) as 1 | 2 | 3 | 4}
            name={a.name}
            role={a.role}
            icon={a.icon}
            status={a.status}
            statusLabel={t(`status.${a.status}` as 'status.active')}
            currentTask={a.task}
            lastAction={a.last}
            action={
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                {t('openAgent')} →
              </span>
            }
            onOpen={() => router.push(`/agent?team=${a.key}`)}
          />
        ))}
      </div>

      {/* ===== 演示数据横幅（仅当接口明确回报 demo: true 时出现）=====
          演示模式下这套数字是编造的；没有这条横幅，它与真实经营数据在界面上
          完全一样。故意用高对比的警示色，而不是低调的灰字。 */}
      {isDemoData && (
        <div
          role="status"
          className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4"
        >
          <span className="mt-0.5 text-amber-500" aria-hidden="true">⚠</span>
          <div className="text-sm">
            <p className="font-semibold text-amber-600 dark:text-amber-400">{t('demoBadge')}</p>
            <p className="mt-0.5 text-muted-foreground">{t('demoNotice')}</p>
          </div>
        </div>
      )}

      {/* ===== 关键指标 InsightCards ===== */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {(data
          ? [
              { label: t('kpiRevenue'), value: fmtCurrency(kpi?.todayRevenue ?? 0), delta: kpi?.revenueDelta, icon: Banknote },
              { label: t('kpiOrders'), value: String(kpi?.todayOrders ?? 0), delta: kpi?.ordersDelta, icon: Receipt },
              { label: t('kpiCustomers'), value: String(kpi?.todayCustomers ?? 0), delta: kpi?.customersDelta, icon: Footprints },
              { label: t('kpiRating'), value: `${kpi?.positiveRate ?? 0}%`, delta: kpi?.ratingDelta, icon: Heart },
            ]
          : Array(4).fill(null)
        ).map((card, i) =>
          card ? (
            <InsightCard
              key={i}
              rise={(i + 1) as 1 | 2 | 3 | 4}
              label={card.label}
              value={card.value}
              // 不写 `?? 0`：null 必须保持 null，否则零数据账户会看到 "+0%"（一个假断言）
              delta={card.delta ?? null}
              deltaLabel={t('vsLastWeek')}
              noBasisLabel={t('noComparison')}
              icon={card.icon}
            />
          ) : (
            <RoveCard key={i} className="p-5">
              <div className="animate-pulse space-y-3">
                <div className="h-3 w-16 bg-muted rounded" />
                <div className="h-7 w-24 bg-muted rounded" />
                <div className="h-3 w-20 bg-muted rounded" />
              </div>
            </RoveCard>
          )
        )}
      </div>

      {/* ===== AI 建议 + AI Activity ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <AIRecommendation
            rise={1}
            agentName={recommendation.agent}
            title={recommendation.title}
            description={recommendation.desc}
            tone={recommendation.tone}
            approveLabel={t('actionApprove')}
            reviewLabel={t('actionReview')}
            executeLabel={t('actionExecute')}
            onApprove={() => router.push(recommendation.href as '/marketing')}
            onReview={() => router.push(`/agent?insight=${encodeURIComponent(recommendation.title)}`)}
            onExecute={() => router.push(recommendation.href as '/marketing')}
          />

          {/* 营收趋势 */}
          <RoveCard rise={2} className="p-5 flex-1">
            <RoveCardHeader
              title={t('revenueTrend')}
              subtitle={range === 7 ? t('range7') : t('range30')}
              action={
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-full bg-accent inline-block" />
                  {t('kpiRevenue')}
                </span>
              }
            />
            {trend.length > 0 ? (
              <svg viewBox={`0 0 ${chartW} 210`} className="w-full h-48">
                <defs>
                  <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#A7FF00" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#A7FF00" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[50, 100, 150].map((y) => (
                  <line key={y} x1={padX} y1={y} x2={chartW - 15} y2={y} stroke="var(--color-outline)" strokeWidth="1" strokeDasharray="4 4" />
                ))}
                <polygon points={areaPath} fill="url(#rev-fill)" />
                <polyline points={linePath} fill="none" stroke="#A7FF00" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {points.filter((_, i) => range === 7 || i % 5 === 0 || i === points.length - 1).map((p, i) => (
                  <text key={i} x={p.x - 10} y={202} fontSize="11" fill="var(--color-muted-foreground)">{fmtDate(p.date, locale)}</text>
                ))}
                {points.length > 0 && (
                  <text x={points[points.length - 1].x - 40} y={points[points.length - 1].y - 12} fontSize="11" fontWeight="600" fill="var(--color-foreground)">
                    {fmtCurrency(points[points.length - 1].amount)}
                  </text>
                )}
              </svg>
            ) : (
              <div className="h-48 animate-pulse bg-muted rounded-xl" />
            )}
          </RoveCard>
        </div>

        <ActivityTimeline
          rise={2}
          title={t('aiActivity')}
          items={activity}
          emptyText={t('aiActivityEmpty')}
          className="min-h-full"
        />
      </div>

      {/* ===== 经营详情（保留真实数据视图，Rove 风格化） ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 渠道占比 */}
        <RoveCard rise={1} className="p-5">
          <RoveCardHeader title={t('channelShare')} subtitle={range === 7 ? t('range7') : t('range30')} />
          {data ? (
            <>
              <div className="flex items-center justify-center py-4">
                <div className="relative w-36 h-36">
                  <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${gradientStops || 'var(--color-outline) 0 100%'})` }} />
                  <div className="absolute inset-4 bg-card rounded-full flex flex-col items-center justify-center">
                    <span className="text-xl font-bold font-grotesk">{totalChannelCount}</span>
                    <span className="text-xs text-muted-foreground">{t('kpiOrders')}</span>
                  </div>
                </div>
              </div>
              <div className="space-y-2.5">
                {channels.slice(0, 4).map((c, i) => (
                  <div key={c.channel} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />
                      {t(CHANNEL_KEYS[c.channel] as 'dineIn') || c.channel}
                    </span>
                    <span className="font-semibold">{c.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 animate-pulse bg-muted rounded-xl" />
          )}
        </RoveCard>

        {/* 热销菜品 */}
        <RoveCard rise={2} className="p-5">
          <RoveCardHeader title={t('topDishes')} subtitle={range === 7 ? t('range7') : t('range30')} />
          <div className="space-y-4">
            {data ? data.topDishes.map((dish) => {
              const max = data.topDishes[0]?.quantity || 1;
              return (
                <div key={dish.name}>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="font-medium truncate">{dish.name}</span>
                    <span className="text-muted-foreground text-xs shrink-0 ml-2">{dish.quantity}</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full" style={{ width: `${Math.round((dish.quantity / max) * 100)}%` }} />
                  </div>
                </div>
              );
            }) : Array(5).fill(0).map((_, i) => <div key={i} className="h-8 animate-pulse bg-muted rounded-lg" />)}
          </div>
        </RoveCard>

        {/* 实时告警 */}
        <RoveCard rise={3} className="p-5">
          <RoveCardHeader
            title={t('liveAlerts')}
            action={
              data && data.alerts.length > 0 ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-destructive/15 text-destructive">
                  {data.alerts.length}
                </span>
              ) : undefined
            }
          />
          <div className="space-y-3">
            {data ? data.alerts.map((alert) => {
              const style = {
                review: { color: 'bg-destructive/15 text-destructive', icon: MessageSquareWarning },
                customer: { color: 'bg-success/15 text-success', icon: UserCheck },
                inventory: { color: 'bg-primary/10 text-primary', icon: Package },
                order: { color: 'bg-warning/15 text-warning', icon: Receipt },
                email: { color: 'bg-primary/10 text-primary', icon: Star },
              }[alert.type] ?? { color: 'bg-primary/10 text-primary', icon: Star };
              const Icon = style.icon;
              return (
                <div key={alert.id} className="flex gap-3 rounded-xl bg-muted/60 p-3.5">
                  <span className={cn('mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0', style.color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{alert.title}</div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{alert.content}</p>
                    <span className="block text-xs text-muted-foreground/70 mt-1.5">{timeAgo(alert.created_at, locale)}</span>
                  </div>
                </div>
              );
            }) : Array(3).fill(0).map((_, i) => <div key={i} className="h-16 animate-pulse bg-muted rounded-xl" />)}
          </div>
        </RoveCard>
      </div>

      {/* 智能经营洞察 */}
      {data?.orderIntel && (
        <RoveCard rise={1} className="p-5 mt-6">
          <RoveCardHeader
            title={
              <span className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Sparkles className="w-3.5 h-3.5" />
                </span>
                {t('orderIntel')}
              </span>
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('hotHours')}</p>
              <div className="flex flex-wrap gap-2">
                {data.orderIntel.hotHours.map((h) => (
                  <span key={h.hour} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium">
                    {h.hour}:00 · {h.orders}
                  </span>
                ))}
                {data.orderIntel.hotHours.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('combos')}</p>
              <div className="space-y-1.5">
                {data.orderIntel.combos.map((c) => (
                  <div key={c.combo} className="flex items-center justify-between text-sm">
                    <span className="font-medium truncate">{c.combo}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2">×{c.count}</span>
                  </div>
                ))}
                {data.orderIntel.combos.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('repeatRate')}</p>
              <p className="text-2xl font-bold text-primary font-grotesk">{data.orderIntel.repeat.rate}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                {data.orderIntel.repeat.repeatCustomers} / {data.orderIntel.repeat.totalBuyers}
              </p>
            </div>
          </div>
        </RoveCard>
      )}
    </div>
  );
}
