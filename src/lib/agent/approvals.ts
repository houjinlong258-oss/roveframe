import { createHash, randomUUID } from 'node:crypto';
import type { RoleKey } from '@/lib/rbac';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { writeAuditEvent } from '@/lib/agent/audit';

export type ActionType =
  | 'purchase.create_draft'
  | 'marketing.create_draft_campaign'
  | 'reviews.reply'
  | 'stripe.refund'
  | 'roveagent.tool_call'
  | 'roveagent.task_step';

export type ApprovalStatus = 'pending' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';
export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalRole = 'manager' | 'owner' | 'admin';

export interface PendingApprovalItem {
  id: string;
  tenant_id: string;
  business_id: string;
  user_id?: string | null;
  requester?: string | null;
  agent: string;
  tool_name?: string | null;
  arguments: Record<string, unknown>;
  arguments_hash?: string | null;
  risk_level: ApprovalRisk;
  required_role: ApprovalRole;
  invocation_id: string;
  execution_id?: string | null;
  approved_by?: string | null;
  action_type: ActionType;
  title: string;
  description?: string | null;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  expires_at?: string | null;
  consumed_at?: string | null;
  execution_result?: unknown;
  last_error?: string | null;
  created_at: string;
}

type ApprovalResult =
  | { ok: true; status: ApprovalStatus; executionId?: string; executedData?: unknown }
  | { ok: false; error: string };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function hashApprovalArguments(argumentsValue: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(argumentsValue))).digest('hex');
}

const ROLE_RANK: Record<RoleKey | ApprovalRole, number> = {
  staff: 1,
  manager: 2,
  owner: 3,
  admin: 4,
};

export function canApprove(role: RoleKey, requiredRole: ApprovalRole): boolean {
  // Platform-admin approval is deliberately outside the merchant RBAC domain.
  if (requiredRole === 'admin') return false;
  return ROLE_RANK[role] >= ROLE_RANK[requiredRole];
}

async function findByInvocation(
  tenantId: string,
  businessId: string,
  invocationId: string,
): Promise<PendingApprovalItem | null> {
  const { data } = await getSupabaseClient()
    .from('agent_approvals')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('invocation_id', invocationId)
    .maybeSingle();
  return data ? data as PendingApprovalItem : null;
}

export async function createPendingApproval(opts: {
  tenantId: string;
  businessId: string;
  userId?: string;
  requester?: string;
  agent?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  riskLevel?: ApprovalRisk;
  requiredRole?: ApprovalRole;
  invocationId?: string;
  actionType: ActionType;
  title: string;
  description?: string;
  payload: Record<string, unknown>;
  expiresInHours?: number;
}): Promise<{ ok: true; approvalId: string; created: boolean } | { ok: false; error: string }> {
  const supabase = getSupabaseClient();
  const expiresInHours = opts.expiresInHours ?? 48;
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
  const invocationId = opts.invocationId ?? randomUUID();
  const argumentsValue = opts.arguments ?? opts.payload;
  const argumentsHash = hashApprovalArguments(argumentsValue);

  const { data, error } = await supabase
    .from('agent_approvals')
    .insert({
      tenant_id: opts.tenantId,
      business_id: opts.businessId,
      user_id: opts.userId ?? null,
      requester: opts.requester ?? opts.userId ?? null,
      agent: opts.agent ?? 'business-agent',
      tool_name: opts.toolName ?? opts.actionType,
      arguments: argumentsValue,
      arguments_hash: argumentsHash,
      risk_level: opts.riskLevel ?? 'medium',
      required_role: opts.requiredRole ?? 'manager',
      invocation_id: invocationId,
      action_type: opts.actionType,
      title: opts.title,
      description: opts.description ?? null,
      payload: opts.payload,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (!error && data) {
    await writeAuditEvent({
      tenantId: opts.tenantId, businessId: opts.businessId,
      userId: opts.userId, agentId: opts.agent,
      toolName: opts.toolName, action: 'approval.created',
      argumentsHash, approvalId: data.id,
      actorRole: opts.requiredRole, status: 'pending',
    });
    return { ok: true, approvalId: data.id, created: true };
  }
  if (error?.code === '23505') {
    const existing = await findByInvocation(opts.tenantId, opts.businessId, invocationId);
    if (existing && existing.arguments_hash === argumentsHash
      && existing.tool_name === (opts.toolName ?? opts.actionType)) {
      return { ok: true, approvalId: existing.id, created: false };
    }
    return { ok: false, error: 'Approval invocation conflicts with a different frozen tool call' };
  }
  return { ok: false, error: error?.message ?? 'Failed to create approval item' };
}

async function executeFrozenApproval(item: PendingApprovalItem, approver: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const args = item.arguments;
  const payload = item.payload;

  if (item.action_type === 'roveagent.task_step') {
    const { roveAgentExecuteTask } = await import('@/lib/roveagent/client');
    const taskId = String(args.task_id ?? payload.task_id ?? '');
    if (!taskId) throw new Error('Missing task_id in frozen approval arguments');
    return roveAgentExecuteTask(item.tenant_id, item.business_id, taskId, true, approver);
  }

  if (item.action_type === 'roveagent.tool_call') {
    const { roveAgentResolveTool } = await import('@/lib/roveagent/client');
    const tool = item.tool_name || String(payload.tool ?? '');
    if (!tool) throw new Error('Missing tool in frozen approval invocation');
    return roveAgentResolveTool({
      tenantId: item.tenant_id,
      businessId: item.business_id,
      tool,
      args,
      approved: true,
      approver,
      auditEventId: String(payload.audit_event_id ?? ''),
      invocationId: item.invocation_id,
      executionId: item.execution_id ?? '',
      argumentsHash: item.arguments_hash ?? '',
      userId: String(payload.user_id ?? item.user_id ?? ''),
      agentId: String(payload.agent_id ?? item.agent),
      role: String(payload.role ?? ''),
      permissions: Array.isArray(payload.permissions)
        ? payload.permissions.filter((value): value is string => typeof value === 'string')
        : [],
      requestId: String(payload.request_id ?? ''),
      taskId: String(payload.task_id ?? ''),
    });
  }

  if (item.action_type === 'purchase.create_draft') {
    const { data, error } = await supabase.from('inventory_items').insert({
      tenant_id: item.tenant_id,
      business_id: item.business_id,
      name: String(args.name ?? 'Restock Item'),
      category: String(args.category ?? '食材'),
      unit: String(args.unit ?? 'kg'),
      current_stock: Number(args.current_stock ?? 0),
      safety_stock: Number(args.safety_stock ?? 10),
      supplier: args.supplier ? String(args.supplier) : null,
    }).select('id, name').single();
    if (error) throw new Error(`Restock draft execution failed: ${error.message}`);
    return data;
  }

  if (item.action_type === 'marketing.create_draft_campaign') {
    const { data, error } = await supabase.from('marketing_contents').insert({
      tenant_id: item.tenant_id,
      business_id: item.business_id,
      type: 'campaign',
      title: String(args.title ?? 'AI Promoted Campaign'),
      brief: String(args.brief ?? ''),
      content: String(args.content ?? ''),
      status: 'draft',
    }).select('id, title').single();
    if (error) throw new Error(`Campaign draft execution failed: ${error.message}`);
    return data;
  }

  if (item.action_type === 'reviews.reply') {
    const reviewId = String(args.review_id ?? '');
    const replyContent = String(args.reply_content ?? '');
    if (!reviewId || !replyContent) throw new Error('Frozen review reply arguments are incomplete');
    const { error } = await supabase.from('reviews')
      .update({ reply_content: replyContent, reply_status: 'replied', status: 'processed' })
      .eq('id', reviewId).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id);
    if (error) throw new Error(`Review reply execution failed: ${error.message}`);
    return { reviewId, replyContent };
  }

  if (item.action_type === 'stripe.refund') {
    const paymentId = String(args.payment_id ?? '');
    const frozenProviderPaymentId = String(args.provider_payment_id ?? '');
    const requestedAmountMinor = args.amount_minor === null || args.amount_minor === undefined
      ? undefined : Number(args.amount_minor);
    if (!paymentId || !frozenProviderPaymentId
      || (requestedAmountMinor !== undefined && (!Number.isSafeInteger(requestedAmountMinor) || requestedAmountMinor <= 0))) {
      throw new Error('Frozen Stripe refund arguments are incomplete');
    }
    const { data: payment, error: paymentError } = await supabase.from('payments').select('*')
      .eq('id', paymentId).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('provider', 'stripe').maybeSingle();
    if (paymentError || !payment) throw new Error('Scoped Stripe payment was not found');
    const row = payment as { provider_payment_id?: string | null; amount_minor: number; refunded_amount_minor?: number | null; status: string };
    if (row.provider_payment_id !== frozenProviderPaymentId) throw new Error('Stripe payment reference changed after approval');
    if (!['paid', 'partially_refunded'].includes(row.status)) throw new Error(`Payment cannot be refunded from ${row.status}`);
    const refunded = Number(row.refunded_amount_minor ?? 0);
    const remaining = Number(row.amount_minor) - refunded;
    const amountMinor = requestedAmountMinor ?? remaining;
    if (amountMinor <= 0 || amountMinor > remaining) throw new Error('Refund amount exceeds the remaining captured amount');

    const { data: configRow, error: configError } = await supabase.from('integration_configs')
      .select('config_encrypted').eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('provider', 'stripe').eq('is_enabled', true).maybeSingle();
    if (configError || !configRow) throw new Error('Scoped Stripe configuration was not found');
    const { decrypt } = await import('@/lib/crypto');
    const { createStripeRefund } = await import('@/lib/payments/stripe');
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(decrypt(String((configRow as { config_encrypted?: string }).config_encrypted ?? ''))) as Record<string, unknown>;
    } catch {
      throw new Error('Stripe configuration could not be decrypted');
    }
    const secretKey = typeof config.secretKey === 'string' ? config.secretKey : '';
    if (!secretKey) throw new Error('Stripe secret key is missing');
    const refund = await createStripeRefund({
      secretKey,
      paymentIntentId: frozenProviderPaymentId,
      amountMinor,
      idempotencyKey: `refund:${item.invocation_id}`,
      metadata: { approval_id: item.id, payment_id: paymentId, business_id: item.business_id },
    });
    const nextRefunded = refunded + refund.amount;
    const { error: updateError } = await supabase.from('payments').update({
      refunded_amount_minor: nextRefunded,
      status: nextRefunded >= Number(row.amount_minor) ? 'refunded' : 'partially_refunded',
      reconciled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', paymentId).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('provider_payment_id', frozenProviderPaymentId);
    if (updateError) throw new Error(`Stripe refund persistence failed: ${updateError.message}`);
    return { paymentId, refundId: refund.id, amountMinor: refund.amount, status: refund.status };
  }
  throw new Error(`Unsupported approval action: ${item.action_type}`);
}

/** P0-21：executing 租约（与 claim RPC 一致的 15 分钟）。 */
export const EXECUTING_LEASE_MS = 15 * 60_000;

/** 纯判定：executing 行是否超过租约（崩溃残留 → 可回收重放）。 */
export function executingLeaseExpired(
  item: { status: string; consumed_at?: string | null },
  nowMs: number,
  leaseMs: number = EXECUTING_LEASE_MS,
): boolean {
  if (item.status !== 'executing' || !item.consumed_at) return false;
  const consumedAt = new Date(item.consumed_at).getTime();
  if (Number.isNaN(consumedAt)) return false;
  return nowMs - consumedAt >= leaseMs;
}

/**
 * P0-21：租约过期后 CAS 回收 executing → pending（重放）。
 * 重放安全性依赖执行层的幂等键（Stripe refund idempotency key 使用 invocation_id；
 * roveagent 回调由 execution_id 单次 claim）；见 executeFrozenApproval。
 */
async function recoverExecutingApproval(
  item: PendingApprovalItem,
  role: RoleKey,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!canApprove(role, item.required_role)) {
    return { ok: false, error: `Approval requires ${item.required_role} role` };
  }
  const cutoffIso = new Date(Date.now() - EXECUTING_LEASE_MS).toISOString();
  const { data: recovered, error } = await supabase.from('agent_approvals')
    .update({
      status: 'pending',
      consumed_at: null,
      last_error: 'executing lease expired (recovered for replay)',
      updated_at: new Date().toISOString(),
    })
    .eq('id', item.id)
    .eq('tenant_id', item.tenant_id)
    .eq('business_id', item.business_id)
    .eq('status', 'executing')
    .lte('consumed_at', cutoffIso)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!recovered) return { ok: false, error: 'Approval is currently executing' };
  await writeAuditEvent({
    tenantId: item.tenant_id, businessId: item.business_id,
    userId, agentId: item.agent,
    toolName: item.tool_name, action: 'approval.lease_recovered',
    argumentsHash: item.arguments_hash, approvalId: item.id,
    actorRole: role, status: 'pending',
  });
  return { ok: true };
}

export async function processApproval(opts: {
  approvalId: string;
  tenantId: string;
  businessId: string;
  action: 'approve' | 'reject';
  userId: string;
  role: RoleKey;
}): Promise<ApprovalResult> {
  const supabase = getSupabaseClient();
  const { data, error: fetchError } = await supabase.from('agent_approvals')
    .select('*').eq('id', opts.approvalId).eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId).maybeSingle();
  if (fetchError || !data) return { ok: false, error: 'Approval item not found' };
  const item = data as PendingApprovalItem;

  if (item.status === 'executed') {
    return { ok: true, status: 'executed', executionId: item.execution_id ?? undefined, executedData: item.execution_result };
  }
  if (item.status !== 'pending') {
    // P0-21：executing 租约（15 分钟）超时 → 回收重放。副作用均带幂等键
    // （Stripe `refund:${invocation_id}`、roveagent execution_id 单次 claim），
    // 重放不会造成重复资金动作。
    if (item.status === 'executing' && executingLeaseExpired(item, Date.now())) {
      const recovered = await recoverExecutingApproval(item, opts.role, opts.userId);
      if (!recovered.ok) return { ok: false, error: recovered.error ?? 'Approval is currently executing' };
    } else {
      return { ok: false, error: `Approval item is already ${item.status}` };
    }
  }
  if (!canApprove(opts.role, item.required_role)) return { ok: false, error: `Approval requires ${item.required_role} role` };

  const now = new Date();
  const nowIso = now.toISOString();
  if (item.expires_at && new Date(item.expires_at).getTime() <= now.getTime()) {
    await supabase.from('agent_approvals').update({ status: 'expired', updated_at: nowIso })
      .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id).eq('status', 'pending');
    return { ok: false, error: 'Approval item has expired' };
  }

  if (opts.action === 'reject') {
    const { data: rejected, error } = await supabase.from('agent_approvals')
      .update({ status: 'rejected', rejected_at: nowIso, approved_by: opts.userId, updated_at: nowIso })
      .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('status', 'pending').select('id').maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!rejected) return { ok: false, error: 'Approval decision lost a concurrent race' };
    await writeAuditEvent({
      tenantId: item.tenant_id, businessId: item.business_id,
      userId: opts.userId, agentId: item.agent,
      toolName: item.tool_name, action: 'approval.rejected',
      argumentsHash: item.arguments_hash, approvalId: item.id,
      actorRole: opts.role, status: 'rejected',
    });
    if (item.action_type === 'roveagent.tool_call') {
      try {
        const { roveAgentResolveTool } = await import('@/lib/roveagent/client');
        await roveAgentResolveTool({
          tenantId: item.tenant_id, businessId: item.business_id,
          tool: item.tool_name ?? '', args: item.arguments, approved: false,
          approver: opts.userId, auditEventId: String(item.payload.audit_event_id ?? ''),
          invocationId: item.invocation_id, executionId: '', argumentsHash: item.arguments_hash ?? '',
          userId: String(item.payload.user_id ?? item.user_id ?? ''), agentId: String(item.payload.agent_id ?? item.agent),
          role: String(item.payload.role ?? ''), permissions: [], requestId: String(item.payload.request_id ?? ''),
          taskId: String(item.payload.task_id ?? ''),
        });
      } catch (callbackError) {
        await supabase.from('agent_approvals')
          .update({ last_error: callbackError instanceof Error ? callbackError.message : String(callbackError), updated_at: new Date().toISOString() })
          .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id);
      }
    }
    return { ok: true, status: 'rejected' };
  }

  if (!item.arguments_hash || hashApprovalArguments(item.arguments) !== item.arguments_hash) {
    return { ok: false, error: 'Frozen approval arguments failed integrity verification' };
  }

  const executionId = randomUUID();
  const { data: claimed, error: claimError } = await supabase.from('agent_approvals')
    .update({ status: 'executing', execution_id: executionId, approved_by: opts.userId,
      approved_at: nowIso, consumed_at: nowIso, updated_at: nowIso })
    .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
    .eq('status', 'pending').select('*').maybeSingle();
  if (claimError) return { ok: false, error: claimError.message };
  if (!claimed) {
    const latest = await findByInvocation(item.tenant_id, item.business_id, item.invocation_id);
    if (latest?.status === 'executed') {
      return { ok: true, status: 'executed', executionId: latest.execution_id ?? undefined, executedData: latest.execution_result };
    }
    return { ok: false, error: `Approval is already ${latest?.status ?? 'being processed'}` };
  }

  const frozen = claimed as PendingApprovalItem;
  await writeAuditEvent({
    tenantId: item.tenant_id, businessId: item.business_id,
    userId: opts.userId, agentId: item.agent,
    toolName: item.tool_name, action: 'approval.approved',
    argumentsHash: item.arguments_hash, approvalId: item.id,
    executionId, actorRole: opts.role, status: 'executing',
  });
  try {
    const executedData = await executeFrozenApproval(frozen, opts.userId);
    const completedAt = new Date().toISOString();
    const { error } = await supabase.from('agent_approvals')
      .update({ status: 'executed', executed_at: completedAt, execution_result: executedData, updated_at: completedAt })
      .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('execution_id', executionId).eq('status', 'executing');
    if (error) throw new Error(`Approval result persistence failed: ${error.message}`);
    await writeAuditEvent({
      tenantId: item.tenant_id, businessId: item.business_id,
      userId: opts.userId, agentId: item.agent,
      toolName: item.tool_name, action: 'approval.executed',
      argumentsHash: item.arguments_hash, approvalId: item.id,
      executionId, result: executedData, actorRole: opts.role, status: 'executed',
    });
    return { ok: true, status: 'executed', executionId, executedData };
  } catch (executionError) {
    const message = executionError instanceof Error ? executionError.message : String(executionError);
    const failedAt = new Date().toISOString();
    await supabase.from('agent_approvals')
      .update({ status: 'failed', failed_at: failedAt, last_error: message, updated_at: failedAt })
      .eq('id', item.id).eq('tenant_id', item.tenant_id).eq('business_id', item.business_id)
      .eq('execution_id', executionId).eq('status', 'executing');
    await writeAuditEvent({
      tenantId: item.tenant_id, businessId: item.business_id,
      userId: opts.userId, agentId: item.agent,
      toolName: item.tool_name, action: 'approval.failed',
      argumentsHash: item.arguments_hash, approvalId: item.id,
      executionId, result: { error: message }, actorRole: opts.role, status: 'failed',
    });
    return { ok: false, error: message };
  }
}
