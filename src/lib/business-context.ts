import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';
import {
  businessDayRange,
  localDateInTimeZone,
  resolveBusinessTimeZone,
} from '@/lib/time';

export type BusinessContext = {
  businessName: string;
  industry: string;
  location: string;
  language: string;
  currency: string;
  todayRevenue: number;
  todayOrders: number;
  yesterdayRevenue: number;
  yesterdayOrders: number;
  weekRevenue: number;
  weekOrders: number;
  customerCount: number;
  avgRating: number;
  pendingReviews: number;
  lowStockItems: string[];
  churnRiskCustomers: string[];
  todayReservations: number;
  channelRevenue: { channel: string; revenue: number; orders: number }[];
  recentNegativeReviews: string[];
  topProducts: { name: string; price: number; salesCount: number }[];
  paymentSummary: { succeeded: number; pending: number; failed: number; volume: number };
};

/** 聚合实时经营数据，作为 AI 回答的事实上下文（含环比/渠道/差评/库存归因） */
export async function getBusinessContext(
  tenantId: string,
  businessId: string,
): Promise<BusinessContext> {
  const client = getSupabaseClient();
  // P0-8：按业务配置时区取本地零点切日；统计走 count/avg 聚合而非静默截断。
  const settings = await getSettings(tenantId, businessId);
  const timeZone = resolveBusinessTimeZone(settings.locale?.timezone);
  const todayStr = localDateInTimeZone(new Date(), timeZone);
  const { start: todayStart, end: todayEnd } = businessDayRange(todayStr, timeZone);
  const todayIso = todayStart.toISOString();
  const todayEndIso = todayEnd.toISOString();
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

  const scopedQuery = (table: string, columns: string) => {
    return client.from(table).select(columns)
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId);
  };
  const [
    businessRes,
    todayRes,
    ydayRes,
    weekRes,
    reviewsRecentRes,
    reviewsAggRes,
    inventoryRes,
    customerCountRes,
    churnRiskRes,
    reservationsRes,
    productsRes,
    paymentsSucceededRes,
    paymentsPendingRes,
    paymentsFailedRes,
  ] = await Promise.all([
    client.from('businesses').select('name, industry, location, language, currency')
      .eq('tenant_id', tenantId).eq('id', businessId).maybeSingle(),
    scopedQuery('orders', 'total, channel').gte('created_at', todayIso).lt('created_at', todayEndIso).neq('status', 'cancelled'),
    scopedQuery('orders', 'total, channel').gte('created_at', yesterdayStart.toISOString()).lt('created_at', todayIso).neq('status', 'cancelled'),
    scopedQuery('orders', 'total').gte('created_at', weekStart.toISOString()).neq('status', 'cancelled'),
    // 差评要点：明确为「最近 20 条」口径
    scopedQuery('reviews', 'rating, content, status').order('created_at', { ascending: false }).limit(20),
    // 评分/待回复：全量聚合（无截断）
    scopedQuery('reviews', 'rating, status'),
    scopedQuery('inventory_items', 'name, current_stock, safety_stock'),
    client.from('customers').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('business_id', businessId),
    scopedQuery('customers', 'name').eq('churn_risk', 'high').limit(5),
    scopedQuery('reservations', 'id').gte('reserved_at', todayIso).lt('reserved_at', todayEndIso),
    scopedQuery('products', 'name, price, sales_count').eq('status', 'active').order('sales_count', { ascending: false }).limit(8),
    scopedQuery('payments', 'amount').eq('status', 'succeeded').gte('created_at', weekStart.toISOString()),
    client.from('payments').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('business_id', businessId)
      .eq('status', 'pending').gte('created_at', weekStart.toISOString()),
    client.from('payments').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('business_id', businessId)
      .in('status', ['failed', 'cancelled']).gte('created_at', weekStart.toISOString()),
  ]);

  const queryError = [
    businessRes.error, todayRes.error, ydayRes.error, weekRes.error, reviewsRecentRes.error,
    reviewsAggRes.error, inventoryRes.error, customerCountRes.error, churnRiskRes.error,
    reservationsRes.error, productsRes.error, paymentsSucceededRes.error,
    paymentsPendingRes.error, paymentsFailedRes.error,
  ].find((error) => error !== null);
  if (queryError) throw new Error(`business context query failed: ${queryError.message}`);

  const sum = (rows: { total?: string | number | null }[] | null) =>
    (rows ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);

  const todayRows = (todayRes.data ?? []) as unknown as { total: string | number; channel: string }[];
  const ydayRows = (ydayRes.data ?? []) as unknown as { total: string | number; channel: string }[];
  const weekRows = (weekRes.data ?? []) as unknown as { total: string | number }[];

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
  const inventory = (inventoryRes.data ?? []) as unknown as { name: string; current_stock: string | number; safety_stock: string | number }[];
  const lowStockItems = inventory
    .filter((i) => Number(i.current_stock) < Number(i.safety_stock))
    .slice(0, 8)
    .map((i) => i.name);

  // 近期差评要点（明确口径：最近 20 条评论）
  const reviews = (reviewsRecentRes.data ?? []) as unknown as { rating: number; content: string; status: string }[];
  const recentNegativeReviews = reviews
    .filter((r) => (r.rating ?? 5) <= 3)
    .slice(0, 3)
    .map((r) => r.content.slice(0, 80));

  // P0-8：平均分/待回复按全量评论聚合，不因 limit(20) 静默失真
  const reviewsAll = (reviewsAggRes.data ?? []) as unknown as { rating: number | null; status: string }[];
  const rated = reviewsAll.filter((r) => r.rating !== null && r.rating !== undefined);
  const avgRating = rated.length
    ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
    : 0;
  const pendingReviews = reviewsAll.filter((r) => r.status === 'pending').length;

  const todayRevenue = Math.round(sum(todayRows) * 100) / 100;
  const yesterdayRevenue = Math.round(sum(ydayRows) * 100) / 100;
  const weekRevenue = Math.round(sum(weekRows) * 100) / 100;
  const business = businessRes.data as {
    name?: string; industry?: string; location?: string; language?: string; currency?: string;
  } | null;
  const topProducts = ((productsRes.data ?? []) as unknown as Array<{
    name: string; price: string | number; sales_count: number;
  }>).map((product) => ({
    name: product.name,
    price: Number(product.price ?? 0),
    salesCount: Number(product.sales_count ?? 0),
  }));
  const paymentRows = (paymentsSucceededRes.data ?? []) as unknown as Array<{
    amount: string | number;
  }>;
  const paymentSummary = {
    succeeded: paymentRows.length,
    pending: paymentsPendingRes.count ?? 0,
    failed: paymentsFailedRes.count ?? 0,
    volume: Math.round(paymentRows
      .reduce((total, payment) => total + Number(payment.amount ?? 0), 0) * 100) / 100,
  };

  return {
    businessName: business?.name ?? 'Your business',
    industry: business?.industry ?? 'restaurant',
    location: business?.location ?? '',
    language: business?.language ?? 'en',
    currency: business?.currency ?? 'USD',
    todayRevenue,
    todayOrders: todayRows.length,
    yesterdayRevenue,
    yesterdayOrders: ydayRows.length,
    weekRevenue,
    weekOrders: weekRows.length,
    avgRating: Math.round(avgRating * 10) / 10,
    pendingReviews,
    lowStockItems,
    customerCount: customerCountRes.count ?? 0,
    churnRiskCustomers: ((churnRiskRes.data ?? []) as unknown as { name: string }[])
      .map((customer) => customer.name),
    todayReservations: reservationsRes.data?.length ?? 0,
    channelRevenue,
    recentNegativeReviews,
    topProducts,
    paymentSummary,
  };
}

export function contextToPrompt(ctx: BusinessContext, locale: string): string {
  const channelStr = ctx.channelRevenue.length
    ? ctx.channelRevenue.map((c) => `${c.channel} $${c.revenue}(${c.orders}单)`).join('、')
    : '无';
  const negativeStr = ctx.recentNegativeReviews.length ? ctx.recentNegativeReviews.join('；') : '无';
  const productsStr = ctx.topProducts.length
    ? ctx.topProducts.map((product) => `${product.name} $${product.price} (${product.salesCount})`).join('、')
    : '无';

  if (locale === 'zh') {
    const revDelta = ctx.yesterdayRevenue > 0 ? Math.round((((ctx.todayRevenue - ctx.yesterdayRevenue) / ctx.yesterdayRevenue) * 100) * 10) / 10 : null;
    return `当前经营实时数据：
- 商户：${ctx.businessName}（${ctx.industry}，${ctx.location || '地点未设置'}，${ctx.currency}）
- 今日营收：$${ctx.todayRevenue}，订单 ${ctx.todayOrders} 单
- 昨日营收：$${ctx.yesterdayRevenue}${revDelta !== null ? `（环比 ${revDelta >= 0 ? '+' : ''}${revDelta}%）` : ''}
- 近 7 天营收：$${ctx.weekRevenue}，订单 ${ctx.weekOrders} 单
- 当前客户：${ctx.customerCount} 人
- 分渠道（今日）：${channelStr}
- 平均评分：${ctx.avgRating}，待回复评论：${ctx.pendingReviews} 条
- 近期差评要点：${negativeStr}
- 缺货物料：${ctx.lowStockItems.length ? ctx.lowStockItems.join('、') : '无'}
- 高流失风险客户：${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join('、') : '无'}
- 热销商品（价格/销量）：${productsStr}
- 近 7 天支付：成功 ${ctx.paymentSummary.succeeded}、待处理 ${ctx.paymentSummary.pending}、失败 ${ctx.paymentSummary.failed}，成功金额 $${ctx.paymentSummary.volume}
- 今日预约：${ctx.todayReservations} 个`;
  }

  const revDelta = ctx.yesterdayRevenue > 0 ? Math.round(((ctx.todayRevenue - ctx.yesterdayRevenue) / ctx.yesterdayRevenue) * 1000) / 10 : null;
  return `Live business data:
- Business: ${ctx.businessName} (${ctx.industry}, ${ctx.location || 'location not set'}, ${ctx.currency})
- Today's revenue: $${ctx.todayRevenue}, orders: ${ctx.todayOrders}
- Yesterday's revenue: $${ctx.yesterdayRevenue}${revDelta !== null ? ` (${revDelta >= 0 ? '+' : ''}${revDelta}% vs yesterday)` : ''}
- Last 7 days revenue: $${ctx.weekRevenue}, orders: ${ctx.weekOrders}
- Current customers: ${ctx.customerCount}
- By channel (today): ${channelStr}
- Avg rating: ${ctx.avgRating}, pending reviews: ${ctx.pendingReviews}
- Recent negative review highlights: ${negativeStr}
- Out-of-stock items: ${ctx.lowStockItems.length ? ctx.lowStockItems.join(', ') : 'none'}
- High churn-risk customers: ${ctx.churnRiskCustomers.length ? ctx.churnRiskCustomers.join(', ') : 'none'}
- Top products (price/sales): ${productsStr}
- Last-7-day payments: ${ctx.paymentSummary.succeeded} succeeded, ${ctx.paymentSummary.pending} pending, ${ctx.paymentSummary.failed} failed; succeeded volume $${ctx.paymentSummary.volume}
- Today's reservations: ${ctx.todayReservations}`;
}
