import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createPendingApproval } from '@/lib/agent/approvals';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';

type RefundBody = { payment_id?: unknown; amount_minor?: unknown };

async function requestRefund(request: NextRequest): Promise<NextResponse> {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'payments:write');
  if (context.role !== 'owner') return NextResponse.json({ error: 'Stripe refunds require the owner role' }, { status: 403 });

  // P0-1：退款申请限流 —— 每商户 10 次/分钟（高敏感资金操作）。
  const limit = checkFixedWindow(
    `payments:refund:${context.tenantId}:${context.businessId}`,
    { limit: 10, windowMs: 60_000 },
  );
  if (!limit.ok) return rateLimitResponse(limit);

  const body = await request.json() as RefundBody;
  const paymentId = typeof body.payment_id === 'string' ? body.payment_id : '';
  const amountMinor = body.amount_minor === undefined || body.amount_minor === null ? null : Number(body.amount_minor);
  if (!paymentId || (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0))) {
    return NextResponse.json({ error: 'payment_id and a positive integer amount_minor are required' }, { status: 400 });
  }
  const result = await scopedTable(context, 'payments', 'id, provider, provider_payment_id, amount_minor, refunded_amount_minor, currency, status')
    .eq('id', paymentId).eq('provider', 'stripe').maybeSingle();
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return NextResponse.json({ error: 'payment not found' }, { status: 404 });
  const payment = result.data as { provider_payment_id: string | null; amount_minor: number; refunded_amount_minor: number | null; currency: string; status: string };
  if (!payment.provider_payment_id || !['paid', 'partially_refunded'].includes(payment.status)) {
    return NextResponse.json({ error: 'payment is not refundable' }, { status: 409 });
  }
  const remaining = Number(payment.amount_minor) - Number(payment.refunded_amount_minor ?? 0);
  if ((amountMinor ?? remaining) > remaining) return NextResponse.json({ error: 'refund exceeds remaining amount' }, { status: 409 });
  const invocationId = request.headers.get('idempotency-key')?.trim().slice(0, 128) || randomUUID();
  const args = { payment_id: paymentId, provider_payment_id: payment.provider_payment_id, amount_minor: amountMinor };
  const approval = await createPendingApproval({
    tenantId: context.tenantId,
    businessId: context.businessId,
    userId: context.userId,
    requester: context.userId,
    agent: 'payments-api',
    toolName: 'stripe.refund',
    arguments: args,
    riskLevel: 'high',
    requiredRole: 'owner',
    invocationId: `stripe-refund:${invocationId}`,
    actionType: 'stripe.refund',
    title: 'Approve Stripe refund',
    description: `Refund ${amountMinor ?? remaining} minor units in ${payment.currency}`,
    payload: args,
    expiresInHours: 24,
  });
  if (!approval.ok) return NextResponse.json({ error: approval.error }, { status: 409 });
  return NextResponse.json({ ok: true, approval_id: approval.approvalId, created: approval.created }, { status: approval.created ? 202 : 200 });
}

export const POST = protectBusinessMutation(
  { permission: 'payments:write', action: 'payments.refund.request', entity: 'payments' },
  requestRefund,
);
