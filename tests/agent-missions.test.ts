import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMissions } from '../src/lib/agent/missions';
import type { BusinessContext } from '../src/lib/business-context';

function contextFixture(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    businessName: 'Demo Restaurant',
    industry: 'restaurant',
    location: 'New York',
    language: 'en',
    currency: 'USD',
    todayRevenue: 1_000,
    todayOrders: 40,
    yesterdayRevenue: 1_000,
    yesterdayOrders: 40,
    weekRevenue: 7_000,
    weekOrders: 280,
    customerCount: 500,
    avgRating: 4.6,
    pendingReviews: 0,
    lowStockItems: [],
    churnRiskCustomers: [],
    todayReservations: 3,
    channelRevenue: [],
    recentNegativeReviews: [],
    topProducts: [],
    paymentSummary: { succeeded: 10, pending: 0, failed: 0, volume: 1_000 },
    ...overrides,
  };
}

const noTasks = { pendingApprovals: 0, unreadErrorAlerts: 0, activeTasks: [] };

test('a normal day produces no action items for the COO', () => {
  const board = deriveMissions({
    persona: 'coo',
    context: contextFixture(),
    ...noTasks,
  });
  assert.equal(board.items.some((item) => item.status === 'action'), false);
  assert.equal(board.signals.revenuePerDay7d, 1_000);
});

test('a revenue drop raises a high-severity action with a signed metric', () => {
  const board = deriveMissions({
    persona: 'coo',
    context: contextFixture({ todayRevenue: 700, weekRevenue: 7_000 }),
    ...noTasks,
  });
  const item = board.items.find((entry) => entry.code === 'revenue_decline');
  assert.ok(item, 'expected revenue_decline');
  assert.equal(item.status, 'action');
  assert.equal(item.severity, 'high');
  assert.equal(item.metric, '-30%');
});

test('a revenue surge is reported as clear, never as an action', () => {
  const board = deriveMissions({
    persona: 'ceo-insight',
    context: contextFixture({ todayRevenue: 1_500 }),
    ...noTasks,
  });
  const item = board.items.find((entry) => entry.code === 'revenue_surge');
  assert.equal(item?.status, 'clear');
  assert.equal(item?.metric, '+50%');
});

test('no order history yields a baseline mission instead of a fake percentage', () => {
  const board = deriveMissions({
    persona: 'ceo-insight',
    context: contextFixture({ weekRevenue: 0, todayRevenue: 0 }),
    ...noTasks,
  });
  const item = board.items.find((entry) => entry.code === 'revenue_baseline');
  assert.equal(item?.status, 'clear');
  assert.equal(item?.metric, null);
});

test('low stock, churn risk and negative reviews become action items', () => {
  const board = deriveMissions({
    persona: 'cmo',
    context: contextFixture({
      lowStockItems: ['Beef', 'Rice', 'Oil'],
      churnRiskCustomers: ['Alice', 'Bob'],
      recentNegativeReviews: ['cold food'],
      pendingReviews: 4,
    }),
    ...noTasks,
  });
  const codes = board.items.filter((item) => item.status === 'action').map((item) => item.code);
  assert.ok(codes.includes('churn_risk'));
  assert.ok(codes.includes('reviews_negative'));
  assert.equal(board.signals.lowStockCount, 3);
  assert.equal(board.signals.churnRiskCount, 2);
  // 有差评时不再显示「待回复」这条较弱信号
  assert.equal(codes.includes('reviews_pending'), false);
});

test('pending approvals surface for every persona that watches governance', () => {
  for (const persona of ['ceo-insight', 'coo', 'cto'] as const) {
    const board = deriveMissions({
      persona,
      context: contextFixture(),
      pendingApprovals: 3,
      unreadErrorAlerts: 0,
      activeTasks: [],
    });
    const item = board.items.find((entry) => entry.code === 'approvals_pending');
    assert.ok(item, `${persona} should see approvals`);
    assert.equal(item.status, 'waiting_approval');
    assert.equal(item.metric, '3');
  }
});

test('action items are sorted ahead of clear ones', () => {
  const board = deriveMissions({
    persona: 'coo',
    context: contextFixture({
      todayRevenue: 400,
      lowStockItems: ['Beef'],
      todayReservations: 0,
    }),
    ...noTasks,
  });
  const firstClearIndex = board.items.findIndex((item) => item.status !== 'action');
  const lastActionIndex = board.items.reduce(
    (acc, item, index) => (item.status === 'action' ? index : acc),
    -1,
  );
  assert.ok(lastActionIndex >= 0 && firstClearIndex > lastActionIndex);
});

test('scheduled missions are passed through untouched', () => {
  const board = deriveMissions({
    persona: 'cto',
    context: contextFixture(),
    pendingApprovals: 0,
    unreadErrorAlerts: 2,
    activeTasks: [
      { id: 't1', name: 'daily brief', status: 'active', nextRunAt: '2026-09-11T00:00:00Z' },
    ],
  });
  assert.equal(board.activeTasks.length, 1);
  assert.equal(board.activeTasks[0].name, 'daily brief');
  assert.ok(board.items.some((item) => item.code === 'system_alerts' && item.status === 'action'));
});

test('every mission code has a matching i18n key in all three locales', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const personas = ['ceo-insight', 'coo', 'cmo', 'cto'] as const;
  const allCodes = new Set<string>();
  for (const persona of personas) {
    const board = deriveMissions({
      persona,
      context: contextFixture({
        todayRevenue: 100,
        lowStockItems: ['x'],
        churnRiskCustomers: ['y'],
        recentNegativeReviews: ['z'],
        paymentSummary: { succeeded: 0, pending: 1, failed: 1, volume: 0 },
        weekRevenue: 7_000,
      }),
      pendingApprovals: 1,
      unreadErrorAlerts: 1,
      activeTasks: [],
    });
    for (const item of board.items) allCodes.add(item.code);
  }
  // 把可能出现的所有 code 都覆盖到（含 clear 分支）
  for (const persona of personas) {
    for (const extra of [
      contextFixture(),
      contextFixture({ weekRevenue: 0 }),
      contextFixture({ todayRevenue: 10_000 }),
      contextFixture({ todayReservations: 0 }),
      contextFixture({ paymentSummary: { succeeded: 1, pending: 0, failed: 0, volume: 100 } }),
    ]) {
      const board = deriveMissions({
        persona,
        context: extra,
        pendingApprovals: 0,
        unreadErrorAlerts: 0,
        activeTasks: [],
      });
      for (const item of board.items) allCodes.add(item.code);
    }
  }

  for (const locale of ['en', 'zh', 'es']) {
    const messages = JSON.parse(
      readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
    ) as { agent: { missions: { items: Record<string, { title?: string; detail?: string }> } } };
    for (const code of allCodes) {
      const entry = messages.agent.missions.items[code];
      assert.ok(entry, `${locale}: missing missions.items.${code}`);
      assert.equal(typeof entry.title, 'string', `${locale}: ${code}.title`);
      assert.equal(typeof entry.detail, 'string', `${locale}: ${code}.detail`);
    }
  }
});
