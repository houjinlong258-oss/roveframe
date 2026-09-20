/**
 * 仪表盘 KPI —— **真实计算，不编造**。
 *
 * ## 为什么单独成模块
 *
 * Phase 16 任务 1：`/api/dashboard` 原本对每个账户都返回写死的增长数字
 * （`ordersDelta: 8.4`、`customersDelta: 5.2`、`ratingDelta: 1.2`），
 * 并把 `todayCustomers` 算成 `订单数 × 1.8`。新商家注册后看到的第一屏
 * 就是编造的增长 —— 这是产品在说假话，不是显示 bug。
 *
 * 拆成纯函数有两个目的：
 *   1. 可被测试**真实调用**（不需要凭据、不需要网络、无副作用）；
 *   2. 「有没有对比依据」与「依据是什么」都成为可断言的输出，而不是隐含在路由里。
 *
 * ## 口径（必须与 `vsLastWeek` 这个 UI 文案一致）
 *
 * 区间与长度相同、紧邻的前一段：
 *   - `range=7`：本期 = 今日往前 7 天（含今日），对比期 = 再往前 7 天；
 *   - 因此「今日订单数」与「今日客户数」都落在本期区间内，
 *     `todayOrdersDelta` / `todayCustomersDelta` 的对比期是**等长的前一段**，
 *     而不是"上周的同一天"（那会让 1 天对上 1 天，样本量为 1，噪声极大）。
 *
 * ## 「无对比依据」的语义
 *
 * 对比期**没有任何订单**时，增长率在数学上无定义（0 不能作分母）。
 * 此时返回 `null`，UI 显示 `—`，**不得回落成 0**：
 * `0%` 是一个断言（"没有变化"），而没有依据不是"没有变化"。
 *
 * 这一点是本模块存在的主要理由，也是测试的负向对照点。
 */

/** 订单行（只取计算需要的列，避免把整行搬进内存） */
export interface DashboardOrderRow {
  total: number | string | null;
  created_at: string | number | Date | null;
  customer_id?: string | null;
  status?: string | null;
}

/** 评论行 */
export interface DashboardReviewRow {
  rating: number | string | null;
  created_at?: string | number | Date | null;
  status?: string | null;
  reply_status?: string | null;
}

export interface DashboardKpi {
  todayRevenue: number;
  todayOrders: number;
  todayCustomers: number;
  positiveRate: number;
  avgRating: number;
  /** 无对比依据时为 null（UI 显示 —），不是 0 */
  revenueDelta: number | null;
  ordersDelta: number | null;
  customersDelta: number | null;
  ratingDelta: number | null;
}

export interface DashboardKpiBasis {
  /** 本期区间（本地日，含首尾） */
  periodStart: string;
  periodEnd: string;
  /** 等长对比期（本地日，含首尾） */
  priorPeriodStart: string;
  priorPeriodEnd: string;
  /** 对比期是否存在任何订单（false ⇒ 四个 delta 全为 null） */
  hasPriorBasis: boolean;
  current: { orders: number; revenue: number; customers: number; reviews: number };
  prior: { orders: number; revenue: number; customers: number; reviews: number };
}

export interface DashboardKpiResult {
  kpi: DashboardKpi;
  basis: DashboardKpiBasis;
}

const MS_PER_DAY = 86_400_000;

/** 本地日零点（AGENTS.md 陷阱 1：日期切分必须按本地时区，不能用 UTC 的 toISOString 切片） */
export function localDayStart(d: Date): Date {
  const copy = new Date(d.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 已取消订单不计入任何 KPI（与原实现一致，避免口径回退） */
function isCountedOrder(row: DashboardOrderRow): boolean {
  return row.status !== 'cancelled';
}

/** 只有已发布回复的评论才算"已发布"；pending 仍在待处理队列里 */
function isPublishedReview(row: DashboardReviewRow): boolean {
  return row.status !== 'pending' && row.reply_status === 'published';
}

type DateLike = string | number | Date | null | undefined;

function toTime(value: DateLike): number {
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

interface PeriodTotals {
  orders: number;
  revenue: number;
  customers: number;
}

function totalsFor(rows: DashboardOrderRow[], start: Date, end: Date): PeriodTotals {
  const from = start.getTime();
  const to = end.getTime();
  let orders = 0;
  let revenue = 0;
  const customers = new Set<string>();
  for (const row of rows) {
    if (!isCountedOrder(row)) continue;
    const t = toTime(row.created_at);
    if (!Number.isFinite(t) || t < from || t >= to) continue;
    orders += 1;
    revenue += Number(row.total ?? 0);
    if (row.customer_id) customers.add(String(row.customer_id));
  }
  return { orders, revenue, customers: customers.size };
}

/** 百分比变化，保留一位小数。对比期无订单 ⇒ null（不得回落成 0）。 */
export function percentDeltaOrNull(current: number, prior: number, priorCount: number): number | null {
  if (priorCount <= 0) return null;
  if (prior === 0) {
    // 有订单但营收为 0：分母为 0，"增长率"同样无定义
    return current === 0 ? 0 : null;
  }
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

function positiveRateOf(rows: DashboardReviewRow[]): { count: number; positiveRate: number; avgRating: number } {
  const published = rows.filter(isPublishedReview);
  if (published.length === 0) return { count: 0, positiveRate: 0, avgRating: 0 };
  const ratings = published.map((r) => Number(r.rating ?? 0));
  const positives = ratings.filter((r) => r >= 4).length;
  return {
    count: published.length,
    positiveRate: Math.round((positives / published.length) * 1000) / 10,
    avgRating: Math.round((ratings.reduce((s, r) => s + r, 0) / published.length) * 10) / 10,
  };
}

function reviewsInPeriod(rows: DashboardReviewRow[], start: Date, end: Date): DashboardReviewRow[] {
  const from = start.getTime();
  const to = end.getTime();
  return rows.filter((r) => {
    if (!isPublishedReview(r)) return false;
    const t = toTime(r.created_at);
    return Number.isFinite(t) && t >= from && t < to;
  });
}

/**
 * 计算仪表盘 KPI。
 *
 * @param orders   覆盖「本期 + 对比期」的全部订单（多出来的行不会被计入）
 * @param reviews  该商户全部评论（本函数自行按区间切分）
 * @param options  `range` = 本期天数；`today` = 可注入的"今天"（测试用确定性时钟）
 */
export function computeDashboardKpi(
  orders: DashboardOrderRow[],
  reviews: DashboardReviewRow[],
  options: { range: number; today: Date },
): DashboardKpiResult {
  const range = Math.max(1, Math.min(30, Math.floor(options.range)));
  const periodEnd = localDayStart(options.today);
  const periodEndExclusive = new Date(periodEnd.getTime() + MS_PER_DAY);
  const periodStart = new Date(periodEnd.getTime() - (range - 1) * MS_PER_DAY);
  const priorPeriodEnd = periodStart;
  const priorPeriodStart = new Date(periodStart.getTime() - range * MS_PER_DAY);

  const today = totalsFor(orders, periodEnd, periodEndExclusive);
  const current = totalsFor(orders, periodStart, periodEndExclusive);
  const prior = totalsFor(orders, priorPeriodStart, priorPeriodEnd);

  const currentReviews = reviewsInPeriod(reviews, periodStart, periodEndExclusive);
  const priorReviews = reviewsInPeriod(reviews, priorPeriodStart, priorPeriodEnd);
  const currentRate = positiveRateOf(currentReviews);
  const priorRate = positiveRateOf(priorReviews);

  const hasPriorBasis = prior.orders > 0;

  const currentRevenue = Math.round(current.revenue * 100) / 100;
  const priorRevenue = Math.round(prior.revenue * 100) / 100;

  const ratingDelta =
    priorRate.count > 0 && currentRate.count > 0
      ? Math.round((currentRate.positiveRate - priorRate.positiveRate) * 10) / 10
      : null;

  return {
    kpi: {
      todayRevenue: Math.round(today.revenue * 100) / 100,
      todayOrders: today.orders,
      // 真实口径：今日订单覆盖到的不同客户数（原实现为 订单数 × 1.8）
      todayCustomers: today.customers,
      positiveRate: currentRate.positiveRate,
      avgRating: currentRate.avgRating,
      revenueDelta: percentDeltaOrNull(currentRevenue, priorRevenue, prior.orders),
      ordersDelta: percentDeltaOrNull(current.orders, prior.orders, prior.orders),
      customersDelta: percentDeltaOrNull(current.customers, prior.customers, prior.orders),
      ratingDelta,
    },
    basis: {
      periodStart: localDayKey(periodStart),
      periodEnd: localDayKey(periodEnd),
      priorPeriodStart: localDayKey(priorPeriodStart),
      priorPeriodEnd: localDayKey(new Date(priorPeriodEnd.getTime() - MS_PER_DAY)),
      hasPriorBasis,
      current: {
        orders: current.orders,
        revenue: currentRevenue,
        customers: current.customers,
        reviews: currentRate.count,
      },
      prior: {
        orders: prior.orders,
        revenue: priorRevenue,
        customers: prior.customers,
        reviews: priorRate.count,
      },
    },
  };
}

/** 路由查询窗口：必须覆盖「本期 + 对比期」共 2×range 天 */
export function dashboardQueryWindow(range: number, today: Date): { start: Date; end: Date } {
  const bounded = Math.max(1, Math.min(30, Math.floor(range)));
  const end = new Date(localDayStart(today).getTime() + MS_PER_DAY);
  const start = new Date(end.getTime() - 2 * bounded * MS_PER_DAY);
  return { start, end };
}
