import { getSupabaseClient } from '@/storage/database/supabase-client';

export type BusinessContext = {
  businessName: string;
  industry: string;
  todayRevenue: number;
  todayOrders: number;
  weekRevenue: number;
  weekOrders: number;
  avgRating: number;
  pendingReviews: number;
  lowStockItems: string[];
  churnRiskCustomers: string[];
  todayReservations: number;
};

/** 聚合实时经营数据，作为 AI 回答的事实上下文 */
export async function getBusinessContext(): Promise<BusinessContext> {
  const client = getSupabaseClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const [ordersRes, weekOrdersRes, reviewsRes, inventoryRes, customersRes, reservationsRes] = await Promise.all([
    client.from('orders').select('total').gte('created_at', todayIso).neq('status', 'cancelled'),
    client.from('orders').select('total').gte('created_at', weekStart.toISOString()).neq('status', 'cancelled'),
    client.from('reviews').select('rating, status'),
    client.from('inventory_items').select('name').lt('current_stock', 0).limit(10),
    client.from('customers').select('name').eq('churn_risk', 'high').limit(5),
    client.from('reservations').select('id', { count: 'exact', head: true }).gte('reserved_at', todayIso),
  ]);

  const todayOrders = ordersRes.data?.length ?? 0;
  const todayRevenue = (ordersRes.data ?? []).reduce((s, o) => s + Number(o.total ?? 0), 0);
  const weekOrders = weekOrdersRes.data?.length ?? 0;
  const weekRevenue = (weekOrdersRes.data ?? []).reduce((s, o) => s + Number(o.total ?? 0), 0);
  const reviews = reviewsRes.data ?? [];
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / reviews.length : 0;

  return {
    businessName: 'Sichuan House 四川人家',
    industry: 'restaurant',
    todayRevenue: Math.round(todayRevenue * 100) / 100,
    todayOrders,
    weekRevenue: Math.round(weekRevenue * 100) / 100,
    weekOrders,
    avgRating: Math.round(avgRating * 10) / 10,
    pendingReviews: reviews.filter((r) => r.status === 'pending').length,
    lowStockItems: (inventoryRes.data ?? []).map((i) => i.name as string),
    churnRiskCustomers: (customersRes.data ?? []).map((c) => c.name as string),
    todayReservations: reservationsRes.count ?? 0,
  };
}

export function contextToPrompt(ctx: BusinessContext, locale: string): string {
  if (locale === 'zh') {
    return `当前经营实时数据：
- 商户：${ctx.businessName}（${ctx.industry}）
- 今日营收：$${ctx.todayRevenue}，今日订单：${ctx.todayOrders} 单
- 近 7 天营收：$${ctx.weekRevenue}，近 7 天订单：${ctx.weekOrders} 单
- 平均评分：${ctx.avgRating}，待回复评论：${ctx.pendingReviews} 条
- 缺货物料：${ctx.lowStockItems.length ? ctx.lowStockItems.join('、') : '无'}
- 高流失风险客户：${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join('、') : '无'}
- 今日预约：${ctx.todayReservations} 个`;
  }
  return `Live business data:
- Business: ${ctx.businessName} (${ctx.industry})
- Today's revenue: $${ctx.todayRevenue}, orders: ${ctx.todayOrders}
- Last 7 days revenue: $${ctx.weekRevenue}, orders: ${ctx.weekOrders}
- Avg rating: ${ctx.avgRating}, pending reviews: ${ctx.pendingReviews}
- Out-of-stock items: ${ctx.lowStockItems.length ? ctx.lowStockItems.join(', ') : 'none'}
- High churn-risk customers: ${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join(', ') : 'none'}
- Today's reservations: ${ctx.todayReservations}`;
}
