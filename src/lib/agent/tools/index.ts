import { z } from 'zod';
import { agentToolRegistry, type AgentToolRegistry } from '@/lib/agent/registry';
import { getCustomerRiskSummary, getLowStockItems, getNegativeReviewTrend, getSalesSummary } from '@/lib/agent/business-data';
import { registerDefaultWriteTools } from '@/lib/agent/tools/write-tools';
import { registerDecoupledTools } from '@/lib/agent/tools/decoupled-registry';

export function registerDefaultTools(registry: AgentToolRegistry = agentToolRegistry): AgentToolRegistry {
  registerDefaultReadTools(registry);
  registerDefaultWriteTools();
  registerDecoupledTools();
  return registry;
}

export function registerDefaultReadTools(registry: AgentToolRegistry = agentToolRegistry): AgentToolRegistry {
  if (!registry.get('analytics.get_sales_summary')) {
    registry.register({
      name: 'analytics.get_sales_summary',
      description: 'Read revenue, order count, average order value, and channel mix for the current business.',
      action: 'analytics:read',
      risk: 'read',
      requiredPermission: 'orders:read',
      timeoutMs: 15_000,
      modelInputSchema: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['today', 'week'] } },
        required: ['period'],
        additionalProperties: false,
      },
      inputSchema: z.object({ period: z.enum(['today', 'week']) }),
      execute: async (input, context) => ({ ok: true, data: await getSalesSummary(context, input.period) }),
    });
  }

  if (!registry.get('reviews.get_negative_trend')) {
    registry.register({
      name: 'reviews.get_negative_trend',
      description: 'Read recent review sentiment indicators and bounded negative-review samples.',
      action: 'reviews:read',
      risk: 'read',
      requiredPermission: 'reviews:read',
      timeoutMs: 15_000,
      modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
      inputSchema: z.object({}),
      execute: async (_input, context) => ({ ok: true, data: await getNegativeReviewTrend(context) }),
    });
  }

  if (!registry.get('customers.get_risk_summary')) {
    registry.register({
      name: 'customers.get_risk_summary',
      description: 'Read customer churn-risk counts and a bounded list of high-risk customer names.',
      action: 'customers:read',
      risk: 'read',
      requiredPermission: 'customers:read',
      timeoutMs: 15_000,
      modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
      inputSchema: z.object({}),
      execute: async (_input, context) => ({ ok: true, data: await getCustomerRiskSummary(context) }),
    });
  }

  if (!registry.get('inventory.get_low_stock')) {
    registry.register({
      name: 'inventory.get_low_stock',
      description: 'Read inventory items below their configured safety stock threshold.',
      action: 'inventory:read',
      risk: 'read',
      requiredPermission: 'inventory:read',
      timeoutMs: 15_000,
      modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
      inputSchema: z.object({}),
      execute: async (_input, context) => ({ ok: true, data: await getLowStockItems(context) }),
    });
  }

  registerDefaultWriteTools();
  return registry;
}

