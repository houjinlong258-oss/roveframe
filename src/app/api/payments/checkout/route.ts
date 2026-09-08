import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable, insertWithScope, updateWithScope } from '@/lib/tenant-db';
import { createStripeCheckoutSession, currencyExponent, toMinorUnits, validateStripeRuntime } from '@/lib/payments/stripe';
import { protectBusinessMutation } from '@/lib/mutation-guard';

type CheckoutBody = {
  amount?: unknown;
  currency?: unknown;
  description?: unknown;
  reservation_id?: unknown;
  order_id?: unknown;
  success_url?: unknown;
  cancel_url?: unknown;
};

/** Creates a Stripe hosted payment session; money is recorded before redirect. */
async function createCheckout(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'payments:write');
    const body = (await request.json()) as CheckoutBody;
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    const currency = typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency) ? body.currency.toUpperCase() : 'USD';
    const amountMinor = toMinorUnits(amount, currency);
    const description = typeof body.description === 'string' ? body.description.slice(0, 200) : 'RoveFrame payment';
    const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (process.env.NODE_ENV === 'production' && !configuredAppUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is required for production checkout' }, { status: 500 });
    }
    const configuredOrigin = configuredAppUrl || new URL(request.url).origin;
    let appOrigin: string;
    try {
      appOrigin = new URL(configuredOrigin).origin;
    } catch {
      return NextResponse.json({ error: 'invalid application origin configuration' }, { status: 500 });
    }
    const redirectValues = [
      typeof body.success_url === 'string' ? body.success_url : `${appOrigin}/payments/success`,
      typeof body.cancel_url === 'string' ? body.cancel_url : `${appOrigin}/payments/cancelled`,
    ];
    let successUrl: string;
    let cancelUrl: string;
    try {
      const parsed = redirectValues.map((value) => new URL(value));
      if (parsed.some((url) => !['http:', 'https:'].includes(url.protocol) || url.origin !== appOrigin)) throw new Error('redirect origin is not allowed');
      [successUrl, cancelUrl] = parsed.map((url) => url.toString()) as [string, string];
    } catch {
      return NextResponse.json({ error: 'success_url and cancel_url must use the configured application origin' }, { status: 400 });
    }

    const integration = await scopedTable(context, 'integration_configs', 'config_encrypted')
      .eq('provider', 'stripe').eq('is_enabled', true).maybeSingle();
    if (integration.error) return NextResponse.json({ error: integration.error.message }, { status: 500 });
    if (!integration.data) return NextResponse.json({ error: 'stripe is not connected' }, { status: 409 });
    let secretKey = '';
    try {
      const config = JSON.parse(decrypt(String((integration.data as { config_encrypted?: string }).config_encrypted ?? '')));
      secretKey = typeof config.secretKey === 'string' ? config.secretKey : '';
    } catch {
      return NextResponse.json({ error: 'invalid stripe configuration' }, { status: 500 });
    }
    if (!secretKey) return NextResponse.json({ error: 'stripe secret key is missing' }, { status: 409 });
    try {
      validateStripeRuntime(secretKey, appOrigin);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid Stripe runtime' }, { status: 409 });
    }

    const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : null;
    const orderId = typeof body.order_id === 'string' ? body.order_id : null;
    if ((!reservationId && !orderId) || (reservationId && orderId)) {
      return NextResponse.json({ error: 'checkout must reference exactly one reservation or order' }, { status: 400 });
    }
    if (reservationId) {
      const check = await scopedTable(context, 'reservations', 'id').eq('id', reservationId).maybeSingle();
      if (check.error) return NextResponse.json({ error: check.error.message }, { status: 500 });
      if (!check.data) return NextResponse.json({ error: 'reservation not found' }, { status: 404 });
    }
    if (orderId) {
      const check = await scopedTable(context, 'orders', 'id, total').eq('id', orderId).maybeSingle();
      if (check.error) return NextResponse.json({ error: check.error.message }, { status: 500 });
      if (!check.data) return NextResponse.json({ error: 'order not found' }, { status: 404 });
      const orderTotalMinor = toMinorUnits(Number((check.data as { total: string | number }).total), currency);
      if (orderTotalMinor !== amountMinor) {
        return NextResponse.json({ error: 'checkout amount does not match the scoped order total' }, { status: 409 });
      }
    }

    const payment = await insertWithScope(context, 'payments', {
      provider: 'stripe', amount: amount.toFixed(currencyExponent(currency)), amount_minor: amountMinor,
      currency, status: 'pending', reservation_id: reservationId, order_id: orderId,
      description, created_by: context.userId,
    }).select('id').single();
    if (payment.error || !payment.data) return NextResponse.json({ error: payment.error?.message ?? 'payment create failed' }, { status: 500 });
    const paymentId = (payment.data as { id: string }).id;

    try {
      const session = await createStripeCheckoutSession({
        secretKey, amount, currency, description, successUrl, cancelUrl,
        metadata: { payment_id: paymentId, tenant_id: context.tenantId, business_id: context.businessId },
        idempotencyKey: `checkout:${paymentId}`,
      });
      const updated = await updateWithScope(context, 'payments', paymentId, {
        external_id: session.id, provider_payment_id: session.payment_intent ?? null,
        checkout_url: session.url, status: 'requires_payment_method',
      });
      if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 500 });
      return NextResponse.json({ payment_id: paymentId, checkout_url: session.url, session_id: session.id });
    } catch (error) {
      await updateWithScope(context, 'payments', paymentId, { status: 'failed', failure_reason: error instanceof Error ? error.message : String(error) });
      return NextResponse.json({ error: error instanceof Error ? error.message : 'stripe checkout failed' }, { status: 502 });
    }
  } catch (error) {
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid checkout request' }, { status });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'payments:write', action: 'payments.checkout', entity: 'payments' },
  createCheckout,
);
