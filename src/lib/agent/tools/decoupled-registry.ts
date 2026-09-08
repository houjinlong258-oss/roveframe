import { z } from 'zod';
import { agentToolRegistry } from '@/lib/agent/registry';
import { getCustomerRiskSummary, getLowStockItems, getNegativeReviewTrend, getSalesSummary } from '@/lib/agent/business-data';
import { createPendingApproval } from '@/lib/agent/approvals';
import { enqueueNotification } from '@/lib/notifications/outbox';

export interface AgentToolMeta {
  name: string;
  description: string;
  permission: string;
  riskLevel: 'read' | 'write' | 'destructive';
  inputSchema: Record<string, unknown>;
}

export function registerDecoupledTools() {
  // 1. analytics_tool
  if (!agentToolRegistry.get('analytics_tool')) {
    agentToolRegistry.register({
      name: 'analytics_tool',
      description: 'Reads business sales performance, order counts, revenue, and channel mix. Strictly read-only for financial data.',
      risk: 'read',
      requiredPermission: 'orders:read',
      action: 'analytics.read',
      timeoutMs: 15_000,
      inputSchema: z.object({
        period: z.enum(['today', 'week']).default('today'),
      }),
      modelInputSchema: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['today', 'week'] } },
        required: ['period'],
      },
      async execute(input, ctx) {
        const data = await getSalesSummary(ctx, input.period);
        return { ok: true, data };
      },
    });
  }

  // 2. reviews_tool
  if (!agentToolRegistry.get('reviews_tool')) {
    agentToolRegistry.register({
      name: 'reviews_tool',
      description: 'Reads customer review ratings, sentiment trends, and negative review feedback.',
      risk: 'read',
      requiredPermission: 'reviews:read',
      action: 'reviews.read',
      timeoutMs: 15_000,
      inputSchema: z.object({}),
      modelInputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        const data = await getNegativeReviewTrend(ctx);
        return { ok: true, data };
      },
    });
  }

  // 3. customer_tool
  if (!agentToolRegistry.get('customer_tool')) {
    agentToolRegistry.register({
      name: 'customer_tool',
      description: 'Reads customer churn probability ratings and high-risk customer segments.',
      risk: 'read',
      requiredPermission: 'customers:read',
      action: 'customers.read',
      timeoutMs: 15_000,
      inputSchema: z.object({}),
      modelInputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        const data = await getCustomerRiskSummary(ctx);
        return { ok: true, data };
      },
    });
  }

  // 4. inventory_tool
  if (!agentToolRegistry.get('inventory_tool')) {
    agentToolRegistry.register({
      name: 'inventory_tool',
      description: 'Reads raw ingredient and menu stock items currently below safety thresholds.',
      risk: 'read',
      requiredPermission: 'inventory:read',
      action: 'inventory.read',
      timeoutMs: 15_000,
      inputSchema: z.object({}),
      modelInputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        const data = await getLowStockItems(ctx);
        return { ok: true, data };
      },
    });
  }

  // 5. marketing_tool
  if (!agentToolRegistry.get('marketing_tool')) {
    agentToolRegistry.register({
      name: 'marketing_tool',
      description: 'Creates a draft marketing campaign requiring owner approval before dispatch.',
      risk: 'write',
      requiredPermission: 'manage',
      action: 'marketing.create_draft',
      timeoutMs: 15_000,
      inputSchema: z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        brief: z.string().optional(),
      }),
      modelInputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          brief: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      async execute(input, ctx) {
        const res = await createPendingApproval({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          actionType: 'marketing.create_draft_campaign',
          title: `Marketing Campaign Draft: ${input.title}`,
          description: input.brief || input.title,
          payload: input as Record<string, unknown>,
        });
        if (!res.ok) return { ok: false, error: { code: 'approval_error', message: res.error } };
        return { ok: true, data: { status: 'waiting_approval', approvalId: res.approvalId } };
      },
    });
  }

  // 6. report_tool
  if (!agentToolRegistry.get('report_tool')) {
    agentToolRegistry.register({
      name: 'report_tool',
      description: 'Generates structured AI executive briefing report or anomaly diagnostic summary.',
      risk: 'read',
      requiredPermission: 'dashboard:read',
      action: 'report.generate',
      timeoutMs: 15_000,
      inputSchema: z.object({
        topic: z.string().default('daily_summary'),
      }),
      modelInputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
      },
      async execute(input, ctx) {
        const sales = await getSalesSummary(ctx, 'today');
        const reviews = await getNegativeReviewTrend(ctx);
        const inventory = await getLowStockItems(ctx);
        return {
          ok: true,
          data: {
            topic: input.topic,
            salesSummary: sales,
            reviewAlerts: reviews,
            lowStockCount: inventory.items.length,
            generatedAt: new Date().toISOString(),
          },
        };
      },
    });
  }

  // 7. notification_tool
  if (!agentToolRegistry.get('notification_tool')) {
    agentToolRegistry.register({
      name: 'notification_tool',
      description: 'Enqueues structured push notification to owner via notification outbox.',
      risk: 'write',
      requiredPermission: 'notifications:write',
      action: 'notification.enqueue',
      timeoutMs: 15_000,
      inputSchema: z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        priority: z.enum(['high', 'normal', 'low']).default('normal'),
        channel: z.enum(['web_push', 'email', 'telegram', 'whatsapp']).default('web_push'),
      }),
      modelInputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          channel: { type: 'string', enum: ['web_push', 'email', 'telegram', 'whatsapp'] },
        },
        required: ['title', 'content'],
      },
      async execute(input, ctx) {
        const notif = await enqueueNotification({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          channel: input.channel,
          notificationType: 'AGENT_DIRECTIVE',
          title: input.title,
          content: input.content,
          priority: input.priority,
          idempotencyKey: `direct_notif:${ctx.businessId}:${Date.now()}`,
        });
        return { ok: true, data: { notificationId: notif.id, status: 'queued' } };
      },
    });
  }
}
