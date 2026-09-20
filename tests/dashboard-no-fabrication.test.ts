import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeDashboardKpi,
  dashboardQueryWindow,
  percentDeltaOrNull,
  type DashboardOrderRow,
  type DashboardReviewRow,
} from '../src/lib/dashboard-metrics';

/**
 * Phase 16 任务 1 —— 仪表盘**不得编造增长数字**。
 *
 * ## 被修掉的是什么
 *
 * `/api/dashboard` 对**每个**账户都返回写死的增长：
 * `ordersDelta: 8.4` / `customersDelta: 5.2` / `ratingDelta: 1.2`，
 * 并把今日客流算成 `订单数 × 1.8`。新商家注册后的第一屏就是编造的数字。
 *
 * ## 这批测试为什么是行为测试
 *
 * 它们**真实调用** `computeDashboardKpi()` —— 无 mock、无 HTTP、无凭据、无副作用，
 * 输入是构造的真实行，输出直接断言。不是 `readFileSync + assert.match`。
 *
 * ## 负向对照（本项目规矩："能失败的测试才算测试"）
 *
 * 测试 `负向对照` 一组把**旧实现的表达式**原样搬进来跑同一份数据，
 * 断言它与新实现的结果**不相等**。如果哪天有人把常数写回去，
 * 下面"零数据账户"与"有对比期"两组都会变红（已实测，见报告）。
 */

const TODAY = new Date('2026-09-18T00:00:00');

/** 本地时间构造（不带 Z，避免 UTC 偏移让日期落到前一天 —— AGENTS.md 陷阱 1） */
function at(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date(TODAY.getTime() - daysAgo * 86_400_000);
  d.setHours(hour, minute, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function order(daysAgo: number, total: number, customerId: string | null, status = 'completed'): DashboardOrderRow {
  return {
    total,
    status,
    customer_id: customerId,
    created_at: at(daysAgo, 12),
  };
}

/** 已发布评论 = status !== 'pending' 且 reply_status === 'published' */
function review(daysAgo: number, rating: number, published = true): DashboardReviewRow {
  return {
    rating,
    created_at: at(daysAgo, 9),
    status: published ? 'replied' : 'pending',
    reply_status: published ? 'published' : 'none',
  };
}

describe('computeDashboardKpi — 零数据账户不得有编造的增长', () => {
  const { kpi, basis } = computeDashboardKpi([], [], { range: 7, today: TODAY });

  test('四个 delta 必须是 null（不是 0，更不是 8.4/5.2/1.2）', () => {
    assert.equal(kpi.revenueDelta, null);
    assert.equal(kpi.ordersDelta, null);
    assert.equal(kpi.customersDelta, null);
    assert.equal(kpi.ratingDelta, null);
  });

  test('明确否定历史常数（写回 8.4 / 5.2 / 1.2 时本组必须变红）', () => {
    assert.notEqual(kpi.ordersDelta, 8.4);
    assert.notEqual(kpi.customersDelta, 5.2);
    assert.notEqual(kpi.ratingDelta, 1.2);
  });

  test('今日客流是真实客户数，不是订单数 × 1.8', () => {
    assert.equal(kpi.todayCustomers, 0);
    assert.equal(kpi.todayOrders, 0);
    // 旧实现的算式在新实现下必然对不上（零数据时它给 0，但见下一组的非零情形）
    assert.notEqual(kpi.todayCustomers, Math.round(kpi.todayOrders * 1.8) + 1);
  });

  test('basis 如实报告"没有对比依据"', () => {
    assert.equal(basis.hasPriorBasis, false);
    assert.equal(basis.prior.orders, 0);
    assert.equal(basis.periodEnd, '2026-09-18');
    assert.equal(basis.priorPeriodEnd, '2026-09-11');
  });
});

describe('computeDashboardKpi — 有对比期时给出真实数字', () => {
  const orders: DashboardOrderRow[] = [
    // 本期：2026-09-12 .. 2026-09-18（5 单，3 个不同客户）
    order(0, 100, 'c1'),
    order(0, 80, 'c1'),
    order(0, 20, 'c2'),
    order(3, 50, 'c3'),
    order(6, 25, null),
    // 对比期：2026-09-05 .. 2026-09-11（3 单，2 个不同客户）
    order(7, 100, 'c1'),
    order(9, 50, 'c1'),
    order(11, 50, 'c2'),
    // 再往前（两个区间之外）：必须完全不参与任何计算
    order(20, 99999, 'c9'),
    // 已取消：不参与任何计算
    { total: 777, status: 'cancelled', customer_id: 'c9', created_at: at(0, 13) },
  ];
  const reviews: DashboardReviewRow[] = [
    review(0, 5),
    review(2, 3),
    review(1, 5, false), // pending：不算已发布
    review(7, 5),
    review(9, 4),
  ];

  const { kpi, basis } = computeDashboardKpi(orders, reviews, { range: 7, today: TODAY });

  test('今日 = 真实订单数与真实不同客户数', () => {
    assert.equal(kpi.todayOrders, 3);
    assert.equal(kpi.todayRevenue, 200);
    // 3 单只有 2 个不同客户；旧实现会给出 round(3 × 1.8) = 5
    assert.equal(kpi.todayCustomers, 2);
    assert.notEqual(kpi.todayCustomers, Math.round(kpi.todayOrders * 1.8));
  });

  test('营收 delta = 本期 275 对比上期 200 → +37.5%', () => {
    assert.equal(basis.current.revenue, 275);
    assert.equal(basis.prior.revenue, 200);
    assert.equal(kpi.revenueDelta, 37.5);
  });

  test('订单 delta = 5 对比 3 → +66.7%', () => {
    assert.equal(kpi.ordersDelta, 66.7);
  });

  test('客户 delta = 3 对比 2 → +50%', () => {
    assert.equal(basis.current.customers, 3);
    assert.equal(basis.prior.customers, 2);
    assert.equal(kpi.customersDelta, 50);
  });

  test('评分 delta 来自已发布评论的同期对比：上期 100% → 本期 50% = -50', () => {
    // 上期评论 = 5 星 + 4 星 ⇒ 100%；本期 = 5 星 + 3 星 ⇒ 50%。
    // pending 的那条（5 星）两边都不算，否则本期会变成 66.7%。
    assert.equal(basis.current.reviews, 2);
    assert.equal(basis.prior.reviews, 2);
    assert.equal(kpi.ratingDelta, -50);
    assert.equal(kpi.positiveRate, 50);
    assert.equal(kpi.avgRating, 4);
  });

  test('区间外的行与已取消订单不影响任何数字', () => {
    // 99999 与 777 若被计入，上面的营收断言就不可能成立 —— 这里再显式钉一次
    assert.equal(basis.current.revenue, 275);
    assert.ok(basis.current.revenue < 1000, '区间外/已取消的行不得进入本期营收');
  });
});

describe('computeDashboardKpi — 持平是 0，无依据是 null（两者不可互换）', () => {
  test('本期与对比期完全一致 ⇒ delta 为 0（有依据的持平）', () => {
    const rows: DashboardOrderRow[] = [
      order(0, 100, 'c1'),
      order(8, 100, 'c1'),
    ];
    const { kpi, basis } = computeDashboardKpi(rows, [], { range: 7, today: TODAY });
    assert.equal(basis.hasPriorBasis, true);
    assert.equal(kpi.revenueDelta, 0);
    assert.equal(kpi.ordersDelta, 0);
    assert.equal(kpi.customersDelta, 0);
  });

  test('对比期无订单 ⇒ null（不是 0）', () => {
    const { kpi, basis } = computeDashboardKpi([order(0, 100, 'c1')], [], { range: 7, today: TODAY });
    assert.equal(basis.hasPriorBasis, false);
    assert.equal(kpi.revenueDelta, null);
    assert.equal(kpi.ordersDelta, null);
    assert.equal(kpi.customersDelta, null);
  });
});

describe('percentDeltaOrNull — 拒绝用 0 当分母', () => {
  test('对比期无订单 → null', () => {
    assert.equal(percentDeltaOrNull(500, 0, 0), null);
  });
  test('有订单但营收为 0 → null（不是 Infinity，也不是 0）', () => {
    assert.equal(percentDeltaOrNull(500, 0, 3), null);
  });
  test('双方都是 0 且有订单 → 0（真实的持平）', () => {
    assert.equal(percentDeltaOrNull(0, 0, 3), 0);
  });
  test('常规计算保留一位小数', () => {
    assert.equal(percentDeltaOrNull(275, 200, 3), 37.5);
    assert.equal(percentDeltaOrNull(100, 300, 5), -66.7);
  });
});

describe('dashboardQueryWindow — 查询窗口必须覆盖对比期', () => {
  test('range=7 → 覆盖 14 天（本期 7 + 对比期 7）', () => {
    const { start, end } = dashboardQueryWindow(7, TODAY);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    assert.equal(days, 14);
    assert.equal(end.getTime(), new Date('2026-09-19T00:00:00').getTime());
    assert.equal(start.getTime(), new Date('2026-09-05T00:00:00').getTime());
  });

  test('range 被夹在 1..30（与原实现一致）', () => {
    const wide = dashboardQueryWindow(365, TODAY);
    assert.equal(Math.round((wide.end.getTime() - wide.start.getTime()) / 86_400_000), 60);
  });
});

describe('负向对照：旧实现的表达式在同一份数据上给出不同答案', () => {
  const orders: DashboardOrderRow[] = [
    order(0, 100, 'c1'),
    order(0, 80, 'c1'),
    order(0, 20, 'c2'),
    order(7, 100, 'c1'),
    order(9, 50, 'c1'),
  ];

  test('旧常数 8.4/5.2/1.2 与新实现的计算结果不相等', () => {
    const { kpi } = computeDashboardKpi(orders, [], { range: 7, today: TODAY });
    const legacy = { ordersDelta: 8.4, customersDelta: 5.2, ratingDelta: 1.2 };
    assert.notDeepEqual(
      { ordersDelta: kpi.ordersDelta, customersDelta: kpi.customersDelta, ratingDelta: kpi.ratingDelta },
      legacy,
      '若这组通过而上面某组变红，说明有人把常数写了回去',
    );
  });

  test('旧算式 订单数 × 1.8 会给出与新实现不同的今日客流', () => {
    const { kpi } = computeDashboardKpi(orders, [], { range: 7, today: TODAY });
    assert.equal(kpi.todayOrders, 3);
    assert.equal(kpi.todayCustomers, 2);
    assert.equal(Math.round(kpi.todayOrders * 1.8), 5);
    assert.notEqual(kpi.todayCustomers, Math.round(kpi.todayOrders * 1.8));
  });
});

describe('路由接线：真实路径不得残留写死的增长数字', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/dashboard/route.ts'), 'utf8');
  /** 真实路径 = 第一个 `buildDemoDashboard` 之前的全部内容（演示分支在文件后半段） */
  const realPath = src.slice(0, src.indexOf('function buildDemoDashboard'));

  test('真实路径调用 computeDashboardKpi，而不是自己拼 kpi', () => {
    assert.match(realPath, /computeDashboardKpi\(/);
  });

  test('真实路径没有 ordersDelta/customersDelta/ratingDelta 的字面量赋值', () => {
    assert.doesNotMatch(realPath, /ordersDelta:\s*-?\d/);
    assert.doesNotMatch(realPath, /customersDelta:\s*-?\d/);
    assert.doesNotMatch(realPath, /ratingDelta:\s*-?\d/);
    // revenueDelta 的旧写法是直接算式赋值到响应
    assert.doesNotMatch(realPath, /revenueDelta:/);
  });

  test('真实路径没有 订单数 × 1.8 这种估算', () => {
    assert.doesNotMatch(realPath, /\*\s*1\.8/);
  });

  test('演示数据仍被 RF_E2E_DEMO + 非生产双重门控', () => {
    assert.match(src, /RF_E2E_DEMO === '1' && process\.env\.COZE_PROJECT_ENV !== 'PROD'/);
  });
});
