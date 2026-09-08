import { getSupabaseClient } from '@/storage/database/supabase-client';

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
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const scopedQuery = (table: string, columns: string) => {
    return client.from(table).select(columns)
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId);
  };
  const [businessRes, todayRes, ydayRes, weekRes, reviewsRes, inventoryRes, customersRes, reservationsRes, productsRes, paymentsRes] = await Promise.all([
    client.from('businesses').select('name, industry, location, language, currency')
      .eq('tenant_id', tenantId).eq('id', businessId).maybeSingle(),
    scopedQuery('orders', 'total, channel').gte('created_at', todayIso).neq('status', 'cancelled'),
    scopedQuery('orders', 'total, channel').gte('created_at', yesterdayStart.toISOString()).lt('created_at', todayIso).neq('status', 'cancelled'),
    scopedQuery('orders', 'total').gte('created_at', weekStart.toISOString()).neq('status', 'cancelled'),
    scopedQuery('reviews', 'rating, content, status').order('created_at', { ascending: false }).limit(20),
    scopedQuery('inventory_items', 'name, current_stock, safety_stock'),
    scopedQuery('customers', 'name, churn_risk').limit(500),
    scopedQuery('reservations', 'id').gte('reserved_at', todayIso),
    scopedQuery('products', 'name, price, sales_count').eq('status', 'active').order('sales_count', { ascending: false }).limit(8),
    scopedQuery('payments', 'amount, status').gte('created_at', weekStart.toISOString()).limit(200),
  ]);

  const queryError = [
    businessRes.error, todayRes.error, ydayRes.error, weekRes.error, reviewsRes.error,
    inventoryRes.error, customersRes.error, reservationsRes.error, productsRes.error, paymentsRes.error,
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

  // 近期差评要点
  const reviews = (reviewsRes.data ?? []) as unknown as { rating: number; content: string; status: string }[];
  const recentNegativeReviews = reviews
    .filter((r) => (r.rating ?? 5) <= 3)
    .slice(0, 3)
    .map((r) => r.content.slice(0, 80));

  const reviewsAll = reviews;
  const avgRating = reviewsAll.length ? reviewsAll.reduce((s, r) => s + (r.rating ?? 0), 0) / reviewsAll.length : 0;

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
  const paymentRows = (paymentsRes.data ?? []) as unknown as Array<{
    amount: string | number; status: string;
  }>;
  const paymentSummary = {
    succeeded: paymentRows.filter((payment) => payment.status === 'succeeded').length,
    pending: paymentRows.filter((payment) => payment.status === 'pending').length,
    failed: paymentRows.filter((payment) => ['failed', 'cancelled'].includes(payment.status)).length,
    volume: Math.round(paymentRows
      .filter((payment) => payment.status === 'succeeded')
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
    pendingReviews: reviewsAll.filter((r) => r.status === 'pending').length,
    lowStockItems,
    customerCount: customersRes.data?.length ?? 0,
    churnRiskCustomers: ((customersRes.data ?? []) as unknown as { name: string; churn_risk: string }[])
      .filter((customer) => customer.churn_risk === 'high')
      .slice(0, 5)
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
