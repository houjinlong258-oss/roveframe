'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Banknote, Receipt, Footprints, Heart, TrendingUp, TrendingDown, Sparkles,
  ChevronRight, MessageSquareWarning, CalendarCheck, UserX, Megaphone, Reply,
  ArrowRight, Package, Star, UserCheck,
} from 'lucide-react';
import { fmtCurrency, fmtDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

type DashboardData = {
  kpi: {
    todayRevenue: number; todayOrders: number; todayCustomers: number;
    positiveRate: number; revenueDelta: number; ordersDelta: number;
    customersDelta: number; ratingDelta: number;
  };
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

const CHANNEL_COLORS = ['#2F6BFF', '#16A37B', '#E8930C', '#E5484D', '#637089'];
const CHANNEL_KEYS: Record<string, string> = {
  dine_in: 'dineIn', delivery: 'delivery', takeout: 'takeout',
  online_store: 'onlineStore', square_pos: 'dineIn', shopify: 'onlineStore',
};

const ALERT_STYLE: Record<string, { color: string; icon: typeof Star }> = {
  review: { color: 'bg-destructive/15 text-destructive', icon: MessageSquareWarning },
  customer: { color: 'bg-success/15 text-success', icon: UserCheck },
  inventory: { color: 'bg-primary/10 text-primary', icon: Package },
  order: { color: 'bg-warning/15 text-warning', icon: Receipt },
  email: { color: 'bg-primary/10 text-primary', icon: Star },
};

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const [range, setRange] = useState(7);
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/dashboard?range=${range}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [range]);

  const kpiCards = data ? [
    { label: t('kpiRevenue'), value: fmtCurrency(data.kpi.todayRevenue), delta: data.kpi.revenueDelta, icon: Banknote, iconClass: 'bg-primary/10 text-primary' },
    { label: t('kpiOrders'), value: String(data.kpi.todayOrders), delta: data.kpi.ordersDelta, icon: Receipt, iconClass: 'bg-success/15 text-success' },
    { label: t('kpiCustomers'), value: String(data.kpi.todayCustomers), delta: data.kpi.customersDelta, icon: Footprints, iconClass: 'bg-warning/15 text-warning' },
    { label: t('kpiRating'), value: `${data.kpi.positiveRate}%`, delta: data.kpi.ratingDelta, icon: Heart, iconClass: 'bg-primary/10 text-primary' },
  ] : [];

  // 营收趋势 SVG 路径
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

  const insights = [
    {
      tag: t('actionGenerate'), tagClass: 'bg-success/15 text-success',
      title: locale === 'zh' ? '周末营收创新高' : 'Weekend revenue hit a new high',
      desc: locale === 'zh'
        ? `上周峰值日营收 ${fmtCurrency(Math.max(...trend.map((p) => p.amount), 0))}，建议周末增加热销菜备料并配合社媒宣传。`
        : `Peak daily revenue reached ${fmtCurrency(Math.max(...trend.map((p) => p.amount), 0))}. Stock up on top sellers and amplify with social posts.`,
      href: '/marketing?brief=weekend-promo', icon: Megaphone, action: t('actionGenerate'),
    },
    {
      tag: locale === 'zh' ? '需关注' : 'Attention', tagClass: 'bg-destructive/15 text-destructive',
      title: locale === 'zh' ? '待回复评论积压' : 'Pending reviews piling up',
      desc: locale === 'zh'
        ? '负面评论 24 小时内回复可将客户挽回率提升 3 倍，建议立即处理。'
        : 'Replying to negative reviews within 24h triples win-back rate. Handle them now.',
      href: '/reviews?filter=pending', icon: Reply, action: t('actionReply'),
    },
    {
      tag: locale === 'zh' ? '建议' : 'Suggestion', tagClass: 'bg-primary/10 text-primary',
      title: locale === 'zh' ? '老客户挽留机会' : 'Win-back opportunity',
      desc: locale === 'zh'
        ? `${data?.totals.churnHigh ?? 0} 位高价值客户超过 21 天未到店，一封个性化邮件即可激活。`
        : `${data?.totals.churnHigh ?? 0} high-value customers haven't visited in 21+ days. A personalized email can reactivate them.`,
      href: '/customers?filter=churn', icon: UserX, action: t('actionView'),
    },
  ];

  return (
    <div>
      {/* 页面标题 + 时间范围 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex bg-muted rounded-md p-0.5">
          {[7, 30].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-sm',
                range === r ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {r === 7 ? t('range7') : t('range30')}
            </button>
          ))}
        </div>
      </div>

      {/* AI 今日简报 */}
      <section className="mb-6 bg-gradient-to-r from-accent/70 via-card to-card rounded-lg shadow-card p-5 border border-primary/10">
        <div className="flex items-start gap-4">
          <span className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('briefing')}</h2>
              <span className="text-xs text-muted-foreground">{t('briefingUpdated')}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              {data && (locale === 'zh'
                ? `今日营收 ${fmtCurrency(data.kpi.todayRevenue)}（较上周 ${data.kpi.revenueDelta >= 0 ? '+' : ''}${data.kpi.revenueDelta}%），订单 ${data.kpi.todayOrders} 单；热销菜品备货充足，晚间预约高峰注意排台。`
                : `Today's revenue is ${fmtCurrency(data.kpi.todayRevenue)} (${data.kpi.revenueDelta >= 0 ? '+' : ''}${data.kpi.revenueDelta}% vs last week) across ${data.kpi.todayOrders} orders. Evening reservations are filling up — watch table assignments.`)}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              <Link href="/reviews?filter=pending" className="flex items-center gap-3 bg-card rounded-md shadow-card px-4 py-3 hover:shadow-float transition-shadow">
                <span className="w-8 h-8 rounded-md bg-destructive/10 text-destructive flex items-center justify-center shrink-0"><MessageSquareWarning className="w-4 h-4" /></span>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{locale === 'zh' ? '差评待回复' : 'Reviews to reply'}</div>
                  <div className="text-xs text-muted-foreground truncate">Google · Yelp</div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto shrink-0" />
              </Link>
              <Link href="/reservations" className="flex items-center gap-3 bg-card rounded-md shadow-card px-4 py-3 hover:shadow-float transition-shadow">
                <span className="w-8 h-8 rounded-md bg-warning/15 text-warning flex items-center justify-center shrink-0"><CalendarCheck className="w-4 h-4" /></span>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{locale === 'zh' ? '晚餐预约高峰' : 'Dinner peak bookings'}</div>
                  <div className="text-xs text-muted-foreground truncate">18:30–19:30</div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto shrink-0" />
              </Link>
              <Link href="/customers?filter=churn" className="flex items-center gap-3 bg-card rounded-md shadow-card px-4 py-3 hover:shadow-float transition-shadow">
                <span className="w-8 h-8 rounded-md bg-destructive/10 text-destructive flex items-center justify-center shrink-0"><UserX className="w-4 h-4" /></span>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{locale === 'zh' ? `${data?.totals.churnHigh ?? 0} 位客户有流失风险` : `${data?.totals.churnHigh ?? 0} customers at churn risk`}</div>
                  <div className="text-xs text-muted-foreground truncate">{locale === 'zh' ? '超过 21 天未到店' : '21+ days since last visit'}</div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto shrink-0" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* KPI 卡片 */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {(data ? kpiCards : Array(4).fill(null)).map((card, i) => (
          <div key={i} className="bg-card rounded-lg shadow-card p-5">
            {card ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{card.label}</span>
                  <span className={cn('w-7 h-7 rounded-md flex items-center justify-center', card.iconClass)}>
                    <card.icon className="w-3.5 h-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-2xl font-bold tracking-tight">{card.value}</div>
                <div className="mt-1.5 flex items-center gap-1 text-xs">
                  <span className={cn('inline-flex items-center gap-0.5 font-medium', card.delta >= 0 ? 'text-success' : 'text-destructive')}>
                    {card.delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {card.delta >= 0 ? '+' : ''}{card.delta}%
                  </span>
                  <span className="text-muted-foreground">{t('vsLastWeek')}</span>
                </div>
              </>
            ) : (
              <div className="animate-pulse space-y-3">
                <div className="h-3 w-16 bg-muted rounded" />
                <div className="h-7 w-24 bg-muted rounded" />
                <div className="h-3 w-20 bg-muted rounded" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 图表区 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <div className="xl:col-span-2 bg-card rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold">{t('revenueTrend')}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{range === 7 ? t('range7') : t('range30')}</p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span className="w-2.5 h-2.5 rounded-full bg-primary inline-block" />{t('kpiRevenue')}
            </span>
          </div>
          {trend.length > 0 ? (
            <svg viewBox={`0 0 ${chartW} 210`} className="w-full h-48">
              <defs>
                <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2F6BFF" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#2F6BFF" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[50, 100, 150].map((y) => (
                <line key={y} x1={padX} y1={y} x2={chartW - 15} y2={y} stroke="#E6EAF2" strokeWidth="1" strokeDasharray="4 4" />
              ))}
              <polygon points={areaPath} fill="url(#rev-fill)" />
              <polyline points={linePath} fill="none" stroke="#2F6BFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {points.filter((_, i) => range === 7 || i % 5 === 0 || i === points.length - 1).map((p, i) => (
                <text key={i} x={p.x - 10} y={202} fontSize="11" fill="#637089">{fmtDate(p.date, locale)}</text>
              ))}
              {points.length > 0 && (
                <text x={points[points.length - 1].x - 40} y={points[points.length - 1].y - 12} fontSize="11" fontWeight="600" fill="#152033">
                  {fmtCurrency(points[points.length - 1].amount)}
                </text>
              )}
            </svg>
          ) : (
            <div className="h-48 animate-pulse bg-muted rounded" />
          )}
        </div>

        {/* 渠道占比 */}
        <div className="bg-card rounded-lg shadow-card p-5">
          <h2 className="text-base font-semibold">{t('channelShare')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{range === 7 ? t('range7') : t('range30')}</p>
          {data ? (
            <>
              <div className="flex items-center justify-center py-5">
                <div className="relative w-36 h-36">
                  <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${gradientStops || '#E6EAF2 0 100%'})` }} />
                  <div className="absolute inset-4 bg-card rounded-full flex flex-col items-center justify-center">
                    <span className="text-xl font-bold">{totalChannelCount}</span>
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
            <div className="h-48 animate-pulse bg-muted rounded mt-4" />
          )}
        </div>
      </div>

      {/* 下排三栏 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 热销菜品 */}
        <div className="bg-card rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">{t('topDishes')}</h2>
            <span className="text-xs text-muted-foreground">{range === 7 ? t('range7') : t('range30')}</span>
          </div>
          <div className="space-y-4">
            {data ? data.topDishes.map((dish, i) => {
              const max = data.topDishes[0]?.quantity || 1;
              return (
                <div key={dish.name}>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="font-medium truncate">{dish.name}</span>
                    <span className="text-muted-foreground text-xs shrink-0 ml-2">{dish.quantity}</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${Math.round((dish.quantity / max) * 100)}%` }} />
                  </div>
                </div>
              );
            }) : Array(5).fill(0).map((_, i) => <div key={i} className="h-8 animate-pulse bg-muted rounded" />)}
          </div>
        </div>

        {/* AI 洞察 */}
        <div className="bg-card rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center"><Sparkles className="w-3.5 h-3.5" /></span>
              {t('aiInsights')}
            </h2>
          </div>
          <div className="space-y-3">
            {insights.map((ins, i) => (
              <div key={i} className="rounded-md bg-muted/60 p-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium', ins.tagClass)}>{ins.tag}</span>
                  <span className="text-sm font-semibold">{ins.title}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{ins.desc}</p>
                <div className="mt-3 flex items-center gap-3">
                  <Link href={ins.href} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity">
                    <ins.icon className="w-3 h-3" />{ins.action}
                  </Link>
                  <Link href={`/agent?insight=${encodeURIComponent(ins.title)}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    {t('actionView') === t('actionView') && locale === 'zh' ? '问 AI' : 'Ask AI'}<ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 实时告警 */}
        <div className="bg-card rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">{t('liveAlerts')}</h2>
            {data && data.alerts.length > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-destructive/15 text-destructive">
                {data.alerts.length}
              </span>
            )}
          </div>
          <div className="space-y-3">
            {data ? data.alerts.map((alert) => {
              const style = ALERT_STYLE[alert.type] ?? ALERT_STYLE.email;
              const Icon = style.icon;
              return (
                <div key={alert.id} className="flex gap-3 rounded-md bg-muted/60 p-3.5">
                  <span className={cn('mt-0.5 w-7 h-7 rounded-md flex items-center justify-center shrink-0', style.color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{alert.title}</div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{alert.content}</p>
                    <span className="block text-xs text-muted-foreground/70 mt-1.5">{timeAgo(alert.created_at, locale)}</span>
                  </div>
                </div>
              );
            }) : Array(3).fill(0).map((_, i) => <div key={i} className="h-16 animate-pulse bg-muted rounded" />)}
          </div>
        </div>
      </div>

      {/* 智能经营洞察 */}
      {data?.orderIntel && (
        <div className="bg-card rounded-lg shadow-card p-5 mt-6">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center"><Sparkles className="w-3.5 h-3.5" /></span>
            {t('orderIntel')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('hotHours')}</p>
              <div className="flex flex-wrap gap-2">
                {data.orderIntel.hotHours.map((h) => (
                  <span key={h.hour} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium">
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
              <p className="text-2xl font-bold text-primary">{data.orderIntel.repeat.rate}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                {data.orderIntel.repeat.repeatCustomers} / {data.orderIntel.repeat.totalBuyers}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
