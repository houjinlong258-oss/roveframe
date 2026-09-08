import { z } from 'zod';
import { agentToolRegistry } from '@/lib/agent/registry';
import { createPendingApproval } from '@/lib/agent/approvals';

export function registerDefaultWriteTools() {
  // 1. Inventory / Purchase Restock Order Draft Tool
  if (!agentToolRegistry.get('purchase.create_draft')) {
    agentToolRegistry.register({
      name: 'purchase.create_draft',
      description: 'Creates a draft inventory restock purchase request requiring user approval.',
      risk: 'write',
      requiredPermission: 'manage',
      action: 'inventory.purchase_draft',
      timeoutMs: 15_000,
      inputSchema: z.object({
        name: z.string().min(1, 'Item name is required'),
        category: z.string().default('食材'),
        unit: z.string().default('kg'),
        current_stock: z.number().nonnegative().default(0),
        safety_stock: z.number().positive().default(10),
        supplier: z.string().optional(),
      }),
      modelInputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name to restock' },
          category: { type: 'string', description: 'Item category' },
          unit: { type: 'string', description: 'Unit of measurement (e.g. kg, pcs)' },
          current_stock: { type: 'number', description: 'Current stock count' },
          safety_stock: { type: 'number', description: 'Minimum safety threshold' },
          supplier: { type: 'string', description: 'Supplier name' },
        },
        required: ['name'],
      },
      async execute(input, ctx) {
        if (!ctx.businessId) {
          return { ok: false, error: { code: 'missing_business_scope', message: 'Business scope required' } };
        }
        const res = await createPendingApproval({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          actionType: 'purchase.create_draft',
          title: `Purchase Draft: ${input.name}`,
          description: `Restock request for ${input.name} (${input.current_stock} ${input.unit}).`,
          payload: input as Record<string, unknown>,
        });
        if (!res.ok) {
          return { ok: false, error: { code: 'approval_creation_failed', message: res.error } };
        }
        return {
          ok: true,
          data: {
            status: 'pending_approval',
            approval_id: res.approvalId,
            message: `Purchase draft for ${input.name} created. User approval required before updating stock.`,
          },
        };
      },
    });
  }

  // 2. Marketing Campaign Draft Tool
  if (!agentToolRegistry.get('marketing.create_draft_campaign')) {
    agentToolRegistry.register({
      name: 'marketing.create_draft_campaign',
      description: 'Creates a draft marketing campaign requiring user approval before dispatch.',
      risk: 'write',
      requiredPermission: 'manage',
      action: 'marketing.campaign_draft',
      timeoutMs: 15_000,
      inputSchema: z.object({
        title: z.string().min(1, 'Campaign title is required'),
        brief: z.string().optional(),
        content: z.string().min(1, 'Campaign content is required'),
      }),
      modelInputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Campaign title' },
          brief: { type: 'string', description: 'Campaign objective summary' },
          content: { type: 'string', description: 'Marketing copy text' },
        },
        required: ['title', 'content'],
      },
      async execute(input, ctx) {
        if (!ctx.businessId) {
          return { ok: false, error: { code: 'missing_business_scope', message: 'Business scope required' } };
        }
        const res = await createPendingApproval({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          actionType: 'marketing.create_draft_campaign',
          title: `Marketing Draft: ${input.title}`,
          description: input.brief || input.title,
          payload: input as Record<string, unknown>,
        });
        if (!res.ok) {
          return { ok: false, error: { code: 'approval_creation_failed', message: res.error } };
        }
        return {
          ok: true,
          data: {
            status: 'pending_approval',
            approval_id: res.approvalId,
            message: `Marketing campaign draft "${input.title}" created. User approval required before launching.`,
          },
        };
      },
    });
  }

  // 3. Review Reply Draft Tool
  if (!agentToolRegistry.get('reviews.draft_reply')) {
    agentToolRegistry.register({
      name: 'reviews.draft_reply',
      description: 'Drafts a public reply to a customer review requiring user approval before posting.',
      risk: 'write',
      requiredPermission: 'manage',
      action: 'reviews.reply_draft',
      timeoutMs: 15_000,
      inputSchema: z.object({
        review_id: z.string().min(1, 'Review ID is required'),
        reply_content: z.string().min(1, 'Reply content is required'),
      }),
      modelInputSchema: {
        type: 'object',
        properties: {
          review_id: { type: 'string', description: 'Review ID to reply to' },
          reply_content: { type: 'string', description: 'Draft response text' },
        },
        required: ['review_id', 'reply_content'],
      },
      async execute(input, ctx) {
        if (!ctx.businessId) {
          return { ok: false, error: { code: 'missing_business_scope', message: 'Business scope required' } };
        }
        const res = await createPendingApproval({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          actionType: 'reviews.reply',
          title: 'Review Reply Approval',
          description: `Draft reply for review ${input.review_id}`,
          payload: input as Record<string, unknown>,
        });
        if (!res.ok) {
          return { ok: false, error: { code: 'approval_creation_failed', message: res.error } };
        }
        return {
          ok: true,
          data: {
            status: 'pending_approval',
            approval_id: res.approvalId,
            message: `Draft reply created for review ${input.review_id}. User approval required before posting.`,
          },
        };
      },
    });
  }
}
