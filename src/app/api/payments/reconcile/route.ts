import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { mapStripePaymentStatus, retrieveStripePaymentIntent } from '@/lib/payments/stripe';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';

async function reconcilePayments(request: NextRequest): Promise<NextResponse> {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'payments:write');
  if (context.role !== 'owner') return NextResponse.json({ error: 'payment reconciliation requires the owner role' }, { status: 403 });
  const integration = await scopedTable(context, 'integration_configs', 'config_encrypted')
    .eq('provider', 'stripe').eq('is_enabled', true).maybeSingle();
  if (integration.error) return NextResponse.json({ error: integration.error.message }, { status: 500 });
  if (!integration.data) return NextResponse.json({ error: 'stripe is not connected' }, { status: 409 });
  let secretKey = '';
  try {
    const config = JSON.parse(decrypt(String((integration.data as { config_encrypted?: string }).config_encrypted ?? ''))) as Record<string, unknown>;
    secretKey = typeof config.secretKey === 'string' ? config.secretKey : '';
  } catch {
    return NextResponse.json({ error: 'invalid stripe configuration' }, { status: 500 });
  }
  if (!secretKey) return NextResponse.json({ error: 'stripe secret key is missing' }, { status: 409 });

  const rows = await scopedTable(context, 'payments', 'id, provider_payment_id, amount_minor, currency, status')
    .eq('provider', 'stripe').not('provider_payment_id', 'is', null)
    .order('updated_at', { ascending: true }).limit(100);
  if (rows.error) return NextResponse.json({ error: rows.error.message }, { status: 500 });
  let reconciled = 0;
  const errors: { payment_id: string; error: string }[] = [];
  for (const raw of rows.data ?? []) {
    const payment = raw as { id: string; provider_payment_id: string; amount_minor: number; currency: string; status: string };
    try {
      const intent = await retrieveStripePaymentIntent(secretKey, payment.provider_payment_id);
      if (intent.amount !== Number(payment.amount_minor) || intent.currency.toUpperCase() !== payment.currency.toUpperCase()) {
        throw new Error('provider amount or currency does not match the local payment');
      }
      const update = await updateWithScope(context, 'payments', payment.id, {
        status: mapStripePaymentStatus(intent.status),
        reconciled_at: new Date().toISOString(),
        failure_reason: null,
        updated_at: new Date().toISOString(),
      });
      if (update.error) throw new Error(update.error.message);
      reconciled += 1;
    } catch (error) {
      errors.push({ payment_id: payment.id, error: error instanceof Error ? error.message : 'reconciliation failed' });
    }
  }
  return NextResponse.json({ ok: errors.length === 0, reconciled, total: rows.data?.length ?? 0, errors });
}

export const POST = protectBusinessMutation(
  { permission: 'payments:write', action: 'payments.reconcile', entity: 'payments' },
  reconcilePayments,
);
