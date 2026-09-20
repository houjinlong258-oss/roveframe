import { json, errorResponse } from '@/lib/api-helpers';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';
import { computeDashboardKpi, dashboardQueryWindow, localDayStart } from '@/lib/dashboard-metrics';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = Math.min(Number(searchParams.get('range') ?? 7) || 7, 30);
    const ctx = requireBusinessContext(await getTenantContext(request));

    const todayStart = localDayStart(new Date());
    // 查询窗口必须覆盖「本期 + 等长对比期」，否则 delta 不可能有依据。
    const window = dashboardQueryWindow(range, todayStart);

    const [ordersRes, reviewsRes, customersRes, alertsRes] = await Promise.all([
      scopedTable(ctx, 'orders', 'total, channel, created_at, status, items, customer_id')
        .gte('created_at', window.start.toISOString())
        .lt('created_at', window.end.toISOString())
        .neq('status', 'cancelled')
        .order('created_at', { ascending: true }),
      // 需要 created_at / status / reply_status 才能做同期对比——
      // 只查 rating 的话 ratingDelta 无依据（原实现就是因为"无依据"而写死了 1.2）
      scopedTable(ctx, 'reviews', 'rating, created_at, status, reply_status'),
      scopedTable(ctx, 'customers', 'id, churn_risk, created_at'),
      scopedTable(ctx, 'alerts')
        .order('created_at', { ascending: false })
        .limit(5),
    ]);
    if (ordersRes.error) throw new Error(ordersRes.error.message);
    if (reviewsRes.error) throw new Error(reviewsRes.error.message);
    if (customersRes.error) throw new Error(customersRes.error.message);

    const orders = (ordersRes.data ?? []) as {
      total: number | string | null;
      channel: string;
      created_at: string;
      status: string;
      items: { name: string; qty: number; price: number }[];
      customer_id: string | null;
    }[];
    const reviews = (reviewsRes.data ?? []) as {
      rating: number | null;
      created_at: string | null;
      status: string | null;
      reply_status: string | null;
    }[];
    const customers = (customersRes.data ?? []) as { id: string; churn_risk: string; created_at: string | null }[];

    // 今日 KPI + 增长对比。全部来自上面的真实行；无对比依据时为 null（见 dashboard-metrics.ts）。
    const { kpi, basis } = computeDashboardKpi(orders, reviews, { range, today: todayStart });

    // 以下聚合全部只统计**本期**。查询窗口是 2×range 天（要覆盖对比期），
    // 若不过滤，渠道占比/热销菜/热销时段会把对比期的行也算进来。
    const rangeStart = new Date(todayStart.getTime() - (range - 1) * 86_400_000);
    const rangeStartMs = rangeStart.getTime();
    const currentOrders = orders.filter(
      (o) => new Date(o.created_at).getTime() >= rangeStartMs,
    );
    const currentCustomers = customers.filter((c) => {
      if (!c.created_at) return false;
      const t = new Date(c.created_at).getTime();
      return Number.isFinite(t) && t >= rangeStartMs;
    });
    const trendMap = new Map<string, number>();
    for (let i = 0; i < range; i++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      trendMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const o of currentOrders) {
      const key = new Date(o.created_at).toISOString().slice(0, 10);
      if (trendMap.has(key)) trendMap.set(key, (trendMap.get(key) ?? 0) + Number(o.total ?? 0));
    }
    const revenueTrend = [...trendMap.entries()].map(([date, amount]) => ({
      date,
      amount: Math.round(amount * 100) / 100,
    }));

    // 渠道占比
    const channelMap = new Map<string, number>();
    for (const o of currentOrders) channelMap.set(o.channel, (channelMap.get(o.channel) ?? 0) + 1);
    const totalOrders = currentOrders.length || 1;
    const channels = [...channelMap.entries()].map(([channel, count]) => ({
      channel,
      count,
      pct: Math.round((count / totalOrders) * 1000) / 10,
    }));

    // 热销菜品
    const dishMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const o of currentOrders) {
      for (const item of o.items ?? []) {
        const cur = dishMap.get(item.name) ?? { name: item.name, quantity: 0, revenue: 0 };
        cur.quantity += item.qty;
        cur.revenue += item.qty * item.price;
        dishMap.set(item.name, cur);
      }
    }
    const topDishes = [...dishMap.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    // 评分口径统一到 computeDashboardKpi（同一筛选：已发布 + 本周期的评论）。
    // 原先此处另算一遍"全部评论的均值"，与 kpi.positiveRate 口径不同，会造成
    // 同一次响应里两个"好评率"。
    const avgRating = kpi.avgRating;
    const positiveRate = kpi.positiveRate;

    // 热销时段（按小时）
    const hourMap = new Map<number, { orders: number; revenue: number }>();
    for (const o of currentOrders) {
      const h = new Date(o.created_at).getHours();
      const cur = hourMap.get(h) ?? { orders: 0, revenue: 0 };
      hourMap.set(h, { orders: cur.orders + 1, revenue: cur.revenue + Number(o.total ?? 0) });
    }
    const hotHours = [...hourMap.entries()]
      .map(([hour, v]) => ({ hour, orders: v.orders, revenue: Math.round(v.revenue * 100) / 100 }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 6);

    // 菜品组合（共现）
    const pairMap = new Map<string, number>();
    for (const o of currentOrders) {
      const names = Array.from(new Set((o.items ?? []).map((i) => i.name)));
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const key = [names[i], names[j]].sort().join(' + ');
          pairMap.set(key, (pairMap.get(key) ?? 0) + 1);
        }
      }
    }
    const combos = [...pairMap.entries()]
      .map(([combo, count]) => ({ combo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // 复购（按 customer_id 订单数）
    const orderCountByCustomer = new Map<string, number>();
    for (const o of currentOrders) {
      if (o.customer_id) orderCountByCustomer.set(o.customer_id, (orderCountByCustomer.get(o.customer_id) ?? 0) + 1);
    }
    const repeatCustomers = Array.from(orderCountByCustomer.values()).filter((c) => c > 1).length;
    const repeat = {
      repeatCustomers,
      totalBuyers: orderCountByCustomer.size,
      rate: Math.round((repeatCustomers / (orderCountByCustomer.size || 1)) * 1000) / 10,
    };

    return json({
      // kpi 全部来自 computeDashboardKpi 的真实计算；无对比依据的 delta 为 null。
      kpi,
      // basis 让"这个百分比是从哪两个区间算出来的"可被外部核验（标 UNVERIFIED 的反面）
      basis,
      revenueTrend,
      channels,
      topDishes,
      orderIntel: { hotHours, combos, repeat },
      totals: {
        customers: currentCustomers.length,
        churnHigh: currentCustomers.filter((c) => c.churn_risk === 'high').length,
      },
      alerts: alertsRes.data ?? [],
    });
  } catch (error) {
    // 演示模式（仅 RF_E2E_DEMO=1 且非生产）：无 Supabase 凭据时返回演示经营数据，
    // 与 auth-guard 的演示播种一致，用于 E2E 走查与 UI 验收截图。
    if (process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD') {
      const range = Math.min(Number(new URL(request.url).searchParams.get('range') ?? 7) || 7, 30);
      return json(buildDemoDashboard(range));
    }
    return errorResponse(error);
  }
}

/**
 * 演示数据集：四川人家餐厅近 N 日经营快照（确定性伪随机，保证截图稳定）。
 *
 * 这里的增长数字**是编造的，这是它的用途** —— 它只在
 * `RF_E2E_DEMO=1 && COZE_PROJECT_ENV !== 'PROD'` 时可达（见 GET 的 catch），
 * 用于 E2E 走查与界面截图。真实路径（try 分支）的任何数字都必须来自真实行。
 * `demo: true` 让下游能一眼分辨这份响应不是经营事实。
 */
function buildDemoDashboard(range: number) {
  const dishes = [
    { name: 'Mapo Tofu 麻婆豆腐', price: 12.8 },
    { name: 'Kung Pao Chicken 宫保鸡丁', price: 14.5 },
    { name: 'Dan Dan Noodles 担担面', price: 10.2 },
    { name: 'Boiled Fish 水煮鱼', price: 22.0 },
    { name: 'Hot Pot Combo 火锅双人餐', price: 48.0 },
  ];
  const channelList = ['dine_in', 'delivery', 'takeout', 'online_store'];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const revenueTrend: { date: string; amount: number }[] = [];
  const channelMap = new Map<string, number>();
  const hourMap = new Map<number, { orders: number; revenue: number }>();
  const dishQty = new Map<string, { name: string; quantity: number; revenue: number }>();
  let todayRevenue = 0;
  let todayOrders = 0;
  let totalOrders = 0;

  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    // 确定性波动：周末高、周中低
    const dow = d.getDay();
    const weekendBoost = dow === 0 || dow === 6 ? 1.45 : 1;
    const wave = 1 + 0.18 * Math.sin(i * 1.7);
    const dayOrders = Math.round((18 + i * 0.6) * weekendBoost * wave);
    const dayRevenue = Math.round(dayOrders * 24.6 * 100) / 100;
    revenueTrend.push({ date: d.toISOString().slice(0, 10), amount: dayRevenue });
    totalOrders += dayOrders;
    if (i === 0) {
      todayRevenue = dayRevenue;
      todayOrders = dayOrders;
    }
    channelList.forEach((ch, ci) => {
      channelMap.set(ch, (channelMap.get(ch) ?? 0) + Math.round(dayOrders * [0.46, 0.27, 0.17, 0.1][ci]));
    });
    for (const h of [11, 12, 13, 18, 19, 20]) {
      const cur = hourMap.get(h) ?? { orders: 0, revenue: 0 };
      cur.orders += Math.max(1, Math.round(dayOrders / 6));
      cur.revenue += Math.round((dayRevenue / 6) * 100) / 100;
      hourMap.set(h, cur);
    }
    dishes.forEach((dish, di) => {
      const q = Math.max(1, Math.round(dayOrders * (0.5 - di * 0.07)));
      const cur = dishQty.get(dish.name) ?? { name: dish.name, quantity: 0, revenue: 0 };
      cur.quantity += q;
      cur.revenue += Math.round(q * dish.price * 100) / 100;
      dishQty.set(dish.name, cur);
    });
  }

  const channels = [...channelMap.entries()].map(([channel, count]) => ({
    channel,
    count,
    pct: Math.round((count / (totalOrders || 1)) * 1000) / 10,
  }));
  const topDishes = [...dishQty.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  const hotHours = [...hourMap.entries()]
    .map(([hour, v]) => ({ hour, orders: v.orders, revenue: Math.round(v.revenue * 100) / 100 }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 6);
  const now = Date.now();

  return {
    demo: true,
    kpi: {
      todayRevenue,
      todayOrders,
      todayCustomers: Math.round(todayOrders * 1.8),
      positiveRate: 92.4,
      avgRating: 4.6,
      revenueDelta: 12.3,
      ordersDelta: 8.4,
      customersDelta: 5.2,
      ratingDelta: 1.2,
    },
    revenueTrend,
    channels,
    topDishes,
    orderIntel: {
      hotHours,
      combos: [
        { combo: 'Mapo Tofu 麻婆豆腐 + Dan Dan Noodles 担担面', count: 34 },
        { combo: 'Kung Pao Chicken 宫保鸡丁 + Mapo Tofu 麻婆豆腐', count: 28 },
        { combo: 'Hot Pot Combo 火锅双人餐 + Dan Dan Noodles 担担面', count: 19 },
      ],
      repeat: { repeatCustomers: 41, totalBuyers: 96, rate: 42.7 },
    },
    totals: { customers: 96, churnHigh: 6 },
    alerts: [
      {
        id: 'demo-a1', type: 'review', is_read: false,
        title: 'New 2-star review on Yelp',
        content: 'Customer complained about slow service during Friday dinner peak. AI draft reply is ready.',
        created_at: new Date(now - 52 * 60000).toISOString(),
      },
      {
        id: 'demo-a2', type: 'inventory', is_read: false,
        title: 'Inventory risk: 郫县豆瓣 low stock',
        content: 'Key ingredient covers only 2 days of demand at current sales velocity.',
        created_at: new Date(now - 2 * 3600000).toISOString(),
      },
      {
        id: 'demo-a3', type: 'customer', is_read: false,
        title: '6 high-value customers at churn risk',
        content: 'No visit in 21+ days. A personalized win-back email can reactivate them.',
        created_at: new Date(now - 5 * 3600000).toISOString(),
      },
      {
        id: 'demo-a4', type: 'order', is_read: true,
        title: 'Dinner peak reservations filling up',
        content: '18:30–19:30 slots at 85% capacity. Consider table turnover optimization.',
        created_at: new Date(now - 7 * 3600000).toISOString(),
      },
    ],
  };
}
