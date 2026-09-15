/**
 * Agent Mission Board —— 「这不是聊天机器人，这是一个 AI 员工」的核心表达。
 *
 * 与"给每个 Agent 写死一段 Today's Mission 文案"不同，这里每一条任务都由
 * **真实经营数据**推导：营收是否低于 7 日均值、有没有低于安全库存的 SKU、
 * 有没有高流失风险客户、有没有待审批动作……
 *
 * 服务端只输出稳定的 `code`（i18n 键）与已格式化的 `metric`，
 * 文案由前端按语言渲染 —— 避免把中英文案塞进业务逻辑。
 *
 * 纯函数，无 IO，可直接单测。
 */

import type { PersonaKey } from '@/lib/agent/personas';
import type { BusinessContext } from '@/lib/business-context';

export type MissionStatus = 'action' | 'clear' | 'waiting_approval';
export type MissionSeverity = 'high' | 'medium' | 'low';

export interface MissionItem {
  /** i18n 键：`missions.items.<code>.title` */
  code: string;
  status: MissionStatus;
  severity: MissionSeverity;
  /** 已格式化的关键数字（如 "-18%"、"3 SKU"），无则 null */
  metric: string | null;
  /** 点一下就交给 Agent 执行的提示词 */
  cta: string;
}

export interface MissionActiveTask {
  id: string;
  name: string;
  status: string;
  nextRunAt: string | null;
}

export interface MissionBoard {
  persona: PersonaKey;
  generatedAt: string;
  items: MissionItem[];
  activeTasks: MissionActiveTask[];
  /** 供 UI 显示 KPI 迷你条 */
  signals: {
    revenueToday: number;
    revenuePerDay7d: number;
    ordersToday: number;
    pendingApprovals: number;
    lowStockCount: number;
    churnRiskCount: number;
    negativeReviewCount: number;
    pendingReviewCount: number;
    unreadErrorAlerts: number;
  };
}

export interface MissionInput {
  persona: PersonaKey;
  context: BusinessContext;
  pendingApprovals: number;
  unreadErrorAlerts: number;
  activeTasks: MissionActiveTask[];
}

const REVENUE_DROP = 0.85;
const REVENUE_SURGE = 1.15;

function pct(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function revenueItem(context: BusinessContext): MissionItem {
  const perDay = context.weekRevenue / 7;
  if (perDay <= 0) {
    return {
      code: 'revenue_baseline',
      status: 'clear',
      severity: 'low',
      metric: null,
      cta: 'Set up revenue tracking and tell me what baseline I should expect each day.',
    };
  }
  const ratio = context.todayRevenue / perDay;
  if (ratio < REVENUE_DROP) {
    return {
      code: 'revenue_decline',
      status: 'action',
      severity: 'high',
      metric: pct(ratio - 1),
      cta: "Today's revenue is below my 7-day average. Analyse the cause and give me 3 prioritised actions.",
    };
  }
  if (ratio > REVENUE_SURGE) {
    return {
      code: 'revenue_surge',
      status: 'clear',
      severity: 'low',
      metric: pct(ratio - 1),
      cta: 'Today is well above my 7-day average. What should I do to keep this momentum?',
    };
  }
  return {
    code: 'revenue_ontrack',
    status: 'clear',
    severity: 'low',
    metric: pct(ratio - 1),
    cta: 'Revenue is on track today. What is the highest-leverage next action?',
  };
}

function ordersItem(context: BusinessContext): MissionItem {
  return {
    code: 'orders_today',
    status: 'clear',
    severity: 'low',
    metric: `${context.todayOrders}`,
    cta: 'Review today\u2019s orders and flag anything unusual (large refunds, odd hours, unusual items).',
  };
}

function inventoryItem(context: BusinessContext): MissionItem {
  const count = context.lowStockItems.length;
  return {
    code: count > 0 ? 'inventory_low' : 'inventory_ok',
    status: count > 0 ? 'action' : 'clear',
    severity: count > 0 ? 'high' : 'low',
    metric: count > 0 ? `${count}` : null,
    cta: 'Which items are below safety stock and what purchase order should I place today?',
  };
}

function reservationsItem(context: BusinessContext): MissionItem {
  return {
    code: context.todayReservations > 0 ? 'reservations_today' : 'reservations_empty',
    status: 'clear',
    severity: 'low',
    metric: `${context.todayReservations}`,
    cta: 'Review today\u2019s reservations and tell me how to staff and prepare for them.',
  };
}

function churnItem(context: BusinessContext): MissionItem {
  const count = context.churnRiskCustomers.length;
  return {
    code: count > 0 ? 'churn_risk' : 'churn_ok',
    status: count > 0 ? 'action' : 'clear',
    severity: count > 0 ? 'high' : 'low',
    metric: count > 0 ? `${count}` : null,
    cta: 'Which customers are at churn risk and what retention offer should I send each of them?',
  };
}

function reviewsItem(context: BusinessContext): MissionItem {
  const negative = context.recentNegativeReviews.length;
  if (negative > 0) {
    return {
      code: 'reviews_negative',
      status: 'action',
      severity: 'high',
      metric: `${negative}`,
      cta: 'Draft replies for my recent negative reviews and tell me what to fix operationally.',
    };
  }
  if (context.pendingReviews > 0) {
    return {
      code: 'reviews_pending',
      status: 'action',
      severity: 'medium',
      metric: `${context.pendingReviews}`,
      cta: 'Reply to the reviews that are still waiting for a response.',
    };
  }
  return {
    code: 'reviews_ok',
    status: 'clear',
    severity: 'low',
    metric: context.avgRating ? context.avgRating.toFixed(1) : null,
    cta: 'How can I get more 5-star reviews this week?',
  };
}

function paymentsItem(context: BusinessContext): MissionItem {
  const { failed, pending } = context.paymentSummary;
  if (failed > 0) {
    return {
      code: 'payments_failed',
      status: 'action',
      severity: 'high',
      metric: `${failed}`,
      cta: 'Some payments failed in the last 7 days. Investigate and tell me how to recover them.',
    };
  }
  if (pending > 0) {
    return {
      code: 'payments_pending',
      status: 'action',
      severity: 'medium',
      metric: `${pending}`,
      cta: 'List the payments still pending and what I should do about each.',
    };
  }
  return {
    code: 'payments_ok',
    status: 'clear',
    severity: 'low',
    metric: null,
    cta: 'Summarise this week\u2019s payment and refund health.',
  };
}

function approvalsItem(pendingApprovals: number): MissionItem {
  return {
    code: pendingApprovals > 0 ? 'approvals_pending' : 'approvals_ok',
    status: pendingApprovals > 0 ? 'waiting_approval' : 'clear',
    severity: pendingApprovals > 0 ? 'high' : 'low',
    metric: pendingApprovals > 0 ? `${pendingApprovals}` : null,
    cta: 'What is waiting for my approval and what happens if I approve each one?',
  };
}

function systemItem(unreadErrorAlerts: number): MissionItem {
  return {
    code: unreadErrorAlerts > 0 ? 'system_alerts' : 'system_ok',
    status: unreadErrorAlerts > 0 ? 'action' : 'clear',
    severity: unreadErrorAlerts > 0 ? 'high' : 'low',
    metric: unreadErrorAlerts > 0 ? `${unreadErrorAlerts}` : null,
    cta: 'Summarise the current system alerts and tell me what to fix first.',
  };
}

/** 每个 AI 员工关心的信号集合（决定 Mission Panel 显示哪些行） */
const PERSONA_SIGNALS: Record<PersonaKey, readonly string[]> = {
  'ceo-insight': ['revenue', 'payments', 'churn', 'reviews', 'approvals'],
  coo: ['revenue', 'orders', 'inventory', 'reservations', 'approvals'],
  cmo: ['churn', 'reviews', 'revenue', 'orders'],
  cto: ['approvals', 'system', 'payments'],
};

export function deriveMissions(input: MissionInput): MissionBoard {
  const { context, persona } = input;
  const builders: Record<string, () => MissionItem> = {
    revenue: () => revenueItem(context),
    orders: () => ordersItem(context),
    inventory: () => inventoryItem(context),
    reservations: () => reservationsItem(context),
    churn: () => churnItem(context),
    reviews: () => reviewsItem(context),
    payments: () => paymentsItem(context),
    approvals: () => approvalsItem(input.pendingApprovals),
    system: () => systemItem(input.unreadErrorAlerts),
  };

  const items = PERSONA_SIGNALS[persona]
    .map((signal) => builders[signal]?.())
    .filter((item): item is MissionItem => Boolean(item));

  const severityRank: Record<MissionSeverity, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => {
    if (a.status === 'action' && b.status !== 'action') return -1;
    if (b.status === 'action' && a.status !== 'action') return 1;
    return severityRank[a.severity] - severityRank[b.severity];
  });

  return {
    persona,
    generatedAt: new Date().toISOString(),
    items,
    activeTasks: input.activeTasks,
    signals: {
      revenueToday: Math.round(context.todayRevenue * 100) / 100,
      revenuePerDay7d: Math.round((context.weekRevenue / 7) * 100) / 100,
      ordersToday: context.todayOrders,
      pendingApprovals: input.pendingApprovals,
      lowStockCount: context.lowStockItems.length,
      churnRiskCount: context.churnRiskCustomers.length,
      negativeReviewCount: context.recentNegativeReviews.length,
      pendingReviewCount: context.pendingReviews,
      unreadErrorAlerts: input.unreadErrorAlerts,
    },
  };
}
