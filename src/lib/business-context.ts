import { getSupabaseClient } from '@/storage/database/supabase-client';

export type BusinessContext = {
  businessName: string;
  industry: string;
  todayRevenue: number;
  todayOrders: number;
  yesterdayRevenue: number;
  yesterdayOrders: number;
  weekRevenue: number;
  weekOrders: number;
  avgRating: number;
  pendingReviews: number;
  lowStockItems: string[];
  churnRiskCustomers: string[];
  todayReservations: number;
  channelRevenue: { channel: string; revenue: number; orders: number }[];
  recentNegativeReviews: string[];
};

/** 聚合实时经营数据，作为 AI 回答的事实上下文（含环比/渠道/差评/库存归因） */
export async function getBusinessContext(): Promise<BusinessContext> {
  const client = getSupabaseClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const [todayRes, ydayRes, weekRes, reviewsRes, inventoryRes, customersRes, reservationsRes] = await Promise.all([
    client.from('orders').select('total, channel').gte('created_at', todayIso).neq('status', 'cancelled'),
    client.from('orders').select('total, channel').gte('created_at', yesterdayStart.toISOString()).lt('created_at', todayIso).neq('status', 'cancelled'),
    client.from('orders').select('total').gte('created_at', weekStart.toISOString()).neq('status', 'cancelled'),
    client.from('reviews').select('rating, content, status').order('created_at', { ascending: false }).limit(20),
    client.from('inventory_items').select('name, current_stock, safety_stock'),
    client.from('customers').select('name').eq('churn_risk', 'high').limit(5),
    client.from('reservations').select('id', { count: 'exact', head: true }).gte('reserved_at', todayIso),
  ]);

  const sum = (rows: { total?: string | number | null }[] | null) =>
    (rows ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);

  const todayRows = (todayRes.data ?? []) as { total: string | number; channel: string }[];
  const ydayRows = (ydayRes.data ?? []) as { total: string | number; channel: string }[];
  const weekRows = (weekRes.data ?? []) as { total: string | number }[];

  // 分渠道（今日）
  const channelMap = new Map<string, { revenue: number; orders: number }>();
  for (const o of todayRows) {
    const ch = o.channel ?? 'other';
    const cur = channelMap.get(ch) ?? { revenue: 0, orders: 0 };
    channelMap.set(ch, { revenue: cur.revenue + Number(o.total ?? 0), orders: cur.orders + 1 });
  }
  const channelRevenue = Array.from(channelMap.entries())
    .map(([channel, v]) => ({ channel, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders }))
    .sort((a, b) => b.revenue - a.revenue);

  // 低库存（低于安全库存）
  const inventory = (inventoryRes.data ?? []) as { name: string; current_stock: string | number; safety_stock: string | number }[];
  const lowStockItems = inventory
    .filter((i) => Number(i.current_stock) < Number(i.safety_stock))
    .slice(0, 8)
    .map((i) => i.name);

  // 近期差评要点
  const reviews = (reviewsRes.data ?? []) as { rating: number; content: string; status: string }[];
  const recentNegativeReviews = reviews
    .filter((r) => (r.rating ?? 5) <= 3)
    .slice(0, 3)
    .map((r) => r.content.slice(0, 80));

  const reviewsAll = reviews;
  const avgRating = reviewsAll.length ? reviewsAll.reduce((s, r) => s + (r.rating ?? 0), 0) / reviewsAll.length : 0;

  const todayRevenue = Math.round(sum(todayRows) * 100) / 100;
  const yesterdayRevenue = Math.round(sum(ydayRows) * 100) / 100;
  const weekRevenue = Math.round(sum(weekRows) * 100) / 100;

  return {
    businessName: 'Sichuan House 四川人家',
    industry: 'restaurant',
    todayRevenue,
    todayOrders: todayRows.length,
    yesterdayRevenue,
    yesterdayOrders: ydayRows.length,
    weekRevenue,
    weekOrders: weekRows.length,
    avgRating: Math.round(avgRating * 10) / 10,
    pendingReviews: reviewsAll.filter((r) => r.status === 'pending').length,
    lowStockItems,
    churnRiskCustomers: (customersRes.data ?? []).map((c) => c.name as string),
    todayReservations: reservationsRes.count ?? 0,
    channelRevenue,
    recentNegativeReviews,
  };
}

export function contextToPrompt(ctx: BusinessContext, locale: string): string {
  const channelStr = ctx.channelRevenue.length
    ? ctx.channelRevenue.map((c) => `${c.channel} $${c.revenue}(${c.orders}单)`).join('、')
    : '无';
  const negativeStr = ctx.recentNegativeReviews.length ? ctx.recentNegativeReviews.join('；') : '无';

  if (locale === 'zh') {
    const revDelta = ctx.yesterdayRevenue > 0 ? Math.round((((ctx.todayRevenue - ctx.yesterdayRevenue) / ctx.yesterdayRevenue) * 100) * 10) / 10 : null;
    return `当前经营实时数据：
- 商户：${ctx.businessName}（${ctx.industry}）
- 今日营收：$${ctx.todayRevenue}，订单 ${ctx.todayOrders} 单
- 昨日营收：$${ctx.yesterdayRevenue}${revDelta !== null ? `（环比 ${revDelta >= 0 ? '+' : ''}${revDelta}%）` : ''}
- 近 7 天营收：$${ctx.weekRevenue}，订单 ${ctx.weekOrders} 单
- 分渠道（今日）：${channelStr}
- 平均评分：${ctx.avgRating}，待回复评论：${ctx.pendingReviews} 条
- 近期差评要点：${negativeStr}
- 缺货物料：${ctx.lowStockItems.length ? ctx.lowStockItems.join('、') : '无'}
- 高流失风险客户：${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join('、') : '无'}
- 今日预约：${ctx.todayReservations} 个`;
  }

  const revDelta = ctx.yesterdayRevenue > 0 ? Math.round(((ctx.todayRevenue - ctx.yesterdayRevenue) / ctx.yesterdayRevenue) * 1000) / 10 : null;
  return `Live business data:
- Business: ${ctx.businessName} (${ctx.industry})
- Today's revenue: $${ctx.todayRevenue}, orders: ${ctx.todayOrders}
- Yesterday's revenue: $${ctx.yesterdayRevenue}${revDelta !== null ? ` (${revDelta >= 0 ? '+' : ''}${revDelta}% vs yesterday)` : ''}
- Last 7 days revenue: $${ctx.weekRevenue}, orders: ${ctx.weekOrders}
- By channel (today): ${channelStr}
- Avg rating: ${ctx.avgRating}, pending reviews: ${ctx.pendingReviews}
- Recent negative review highlights: ${negativeStr}
- Out-of-stock items: ${ctx.lowStockItems.length ? ctx.lowStockItems.join(', ') : 'none'}
- High churn-risk customers: ${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join(', ') : 'none'}
- Today's reservations: ${ctx.todayReservations}`;
}