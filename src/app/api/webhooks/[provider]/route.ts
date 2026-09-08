import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { mapSquareOrder, verifySquareSignature } from '@/lib/connectors/square';
import { verifyStripeSignature } from '@/lib/payments/stripe';

/** Unified, signed provider webhook entry point with an exact business scope. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  const tenantId = request.nextUrl.searchParams.get('tenant');
  const businessId = request.nextUrl.searchParams.get('business');
  if (!tenantId || !businessId) {
    return NextResponse.json({ error: 'tenant and business are required' }, { status: 400 });
  }
  const rawBody = await request.text();
  if (provider === 'stripe') return handleStripeWebhook(request, tenantId, businessId, rawBody);
  if (provider !== 'square') return NextResponse.json({ error: `webhook not implemented for ${provider}` }, { status: 400 });

  const supabase = getSupabaseClient();
  const { data: cfgRow, error: cfgError } = await supabase.from('integration_configs')
    .select('config_encrypted').eq('tenant_id', tenantId).eq('business_id', businessId)
    .eq('provider', 'square').eq('is_enabled', true).maybeSingle();
  if (cfgError) return NextResponse.json({ error: cfgError.message }, { status: 500 });
  let signatureKey = '';
  let notificationUrl = '';
  try {
    const cfg = JSON.parse(decrypt(String((cfgRow as { config_encrypted?: string } | null)?.config_encrypted ?? ''))) as Record<string, unknown>;
    signatureKey = typeof cfg.signatureKey === 'string' ? cfg.signatureKey : '';
    notificationUrl = typeof cfg.webhookUrl === 'string' ? cfg.webhookUrl : '';
  } catch { return NextResponse.json({ error: 'config error' }, { status: 500 }); }
  if (!signatureKey) return NextResponse.json({ error: 'webhook not configured' }, { status: 409 });
  if (!notificationUrl && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'exact Square webhook URL is not configured' }, { status: 409 });
  }
  if (!verifySquareSignature(rawBody, request.headers.get('x-square-hmacsha256-signature') ?? '', signatureKey, notificationUrl || request.nextUrl.toString())) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }
  let event: { event_id?: string; type?: string; data?: { object?: { order?: Record<string, unknown> } } };
  try { event = JSON.parse(rawBody) as typeof event; } catch { return NextResponse.json({ error: 'invalid payload' }, { status: 400 }); }
  if (!event.event_id || !event.type) return NextResponse.json({ error: 'invalid Square event' }, { status: 400 });
  const receipt = await supabase.from('integration_events').insert({
    tenant_id: tenantId,
    business_id: businessId,
    provider: 'square',
    external_event_id: event.event_id,
    event_type: event.type,
    payload: event,
  }).select('id').single();
  if (receipt.error?.code === '23505') {
    const previous = await supabase.from('integration_events').select('processed_at')
      .eq('tenant_id', tenantId).eq('business_id', businessId).eq('provider', 'square')
      .eq('external_event_id', event.event_id).maybeSingle();
    return previous.data && (previous.data as { processed_at: string | null }).processed_at
      ? NextResponse.json({ ok: true, duplicate: true })
      : NextResponse.json({ error: 'event is already being processed' }, { status: 503 });
  }
  if (receipt.error || !receipt.data) return NextResponse.json({ error: receipt.error?.message ?? 'event receipt failed' }, { status: 500 });
  const receiptId = (receipt.data as { id: string }).id;
  const failReceipt = async (message: string): Promise<NextResponse> => {
    await supabase.from('integration_events').delete().eq('id', receiptId)
      .eq('tenant_id', tenantId).eq('business_id', businessId).is('processed_at', null);
    return NextResponse.json({ error: message }, { status: 500 });
  };
  const completeReceipt = async (): Promise<string | null> => {
    const result = await supabase.from('integration_events').update({ processed_at: new Date().toISOString() })
      .eq('id', receiptId).eq('tenant_id', tenantId).eq('business_id', businessId).is('processed_at', null);
    return result.error?.message ?? null;
  };
  if (event.type !== 'order.created' && event.type !== 'order.updated') {
    const completionError = await completeReceipt();
    return completionError ? failReceipt(completionError) : NextResponse.json({ ok: true, ignored: event.type });
  }
  const order = event.data?.object?.order;
  if (!order?.id) {
    const completionError = await completeReceipt();
    return completionError ? failReceipt(completionError) : NextResponse.json({ ok: true, ignored: 'no order payload' });
  }
  const mapped = mapSquareOrder(order as never);
  const write = await supabase.from('orders').upsert(
    { tenant_id: tenantId, business_id: businessId, ...mapped, channel: 'dine_in', source: 'square' },
    { onConflict: 'tenant_id,business_id,source,external_id' },
  );
  if (write.error) return failReceipt(write.error.message);
  const completionError = await completeReceipt();
  if (completionError) return failReceipt(completionError);
  return NextResponse.json({ ok: true, order_no: mapped.order_no });
}

async function handleStripeWebhook(
  request: NextRequest,
  tenantId: string,
  businessId: string,
  rawBody: string,
): Promise<NextResponse> {
  const supabase = getSupabaseClient();
  const { data: configRow, error: configError } = await supabase.from('integration_configs')
    .select('config_encrypted').eq('tenant_id', tenantId).eq('business_id', businessId)
    .eq('provider', 'stripe').eq('is_enabled', true).maybeSingle();
  if (configError) return NextResponse.json({ error: configError.message }, { status: 500 });
  let webhookSecret = '';
  try {
    const config = JSON.parse(decrypt(String((configRow as { config_encrypted?: string } | null)?.config_encrypted ?? '')));
    webhookSecret = typeof config.webhookSecret === 'string' ? config.webhookSecret : '';
  } catch { return NextResponse.json({ error: 'invalid stripe configuration' }, { status: 500 }); }
  if (!webhookSecret) return NextResponse.json({ error: 'stripe webhook is not configured' }, { status: 409 });
  if (!verifyStripeSignature(rawBody, request.headers.get('stripe-signature') ?? '', webhookSecret)) return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(rawBody) as typeof event; } catch { return NextResponse.json({ error: 'invalid payload' }, { status: 400 }); }
  if (!event.id || !event.type) return NextResponse.json({ error: 'invalid event' }, { status: 400 });
  const eventReceipt = await supabase.from('payment_events').insert({
    tenant_id: tenantId,
    business_id: businessId,
    provider: 'stripe',
    external_event_id: event.id,
    event_type: event.type,
    payload: event,
  }).select('id').single();
  if (eventReceipt.error?.code === '23505') {
    const previous = await supabase.from('payment_events').select('processed_at')
      .eq('tenant_id', tenantId).eq('business_id', businessId).eq('provider', 'stripe')
      .eq('external_event_id', event.id).maybeSingle();
    return previous.data && (previous.data as { processed_at: string | null }).processed_at
      ? NextResponse.json({ ok: true, duplicate: true })
      : NextResponse.json({ error: 'event is already being processed' }, { status: 503 });
  }
  if (eventReceipt.error || !eventReceipt.data) {
    return NextResponse.json({ error: eventReceipt.error?.message ?? 'event receipt failed' }, { status: 500 });
  }
  const eventReceiptId = (eventReceipt.data as { id: string }).id;
  const failPaymentEvent = async (message: string): Promise<NextResponse> => {
    await supabase.from('payment_events').delete().eq('id', eventReceiptId)
      .eq('tenant_id', tenantId).eq('business_id', businessId).is('processed_at', null);
    return NextResponse.json({ error: message }, { status: 500 });
  };
  const completePaymentEvent = async (): Promise<string | null> => {
    const result = await supabase.from('payment_events').update({ processed_at: new Date().toISOString(), last_error: null })
      .eq('id', eventReceiptId).eq('tenant_id', tenantId).eq('business_id', businessId).is('processed_at', null);
    return result.error?.message ?? null;
  };
  const object = event.data?.object ?? {};
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const paymentId = typeof metadata.payment_id === 'string' ? metadata.payment_id : null;
  const externalId = typeof object.id === 'string' ? object.id : null;
  const providerPaymentId = typeof object.payment_intent === 'string'
    ? object.payment_intent
    : event.type.startsWith('payment_intent.') ? externalId : null;
  const paymentQuery = paymentId
    ? supabase.from('payments').select('id').eq('id', paymentId).eq('tenant_id', tenantId).eq('business_id', businessId).maybeSingle()
    : providerPaymentId
      ? supabase.from('payments').select('id').eq('tenant_id', tenantId).eq('business_id', businessId)
        .eq('provider', 'stripe').eq('provider_payment_id', providerPaymentId).maybeSingle()
      : externalId ? supabase.from('payments').select('id').eq('tenant_id', tenantId).eq('business_id', businessId)
        .eq('provider', 'stripe').eq('external_id', externalId).maybeSingle() : null;
  if (!paymentQuery) {
    const completionError = await completePaymentEvent();
    return completionError ? failPaymentEvent(completionError) : NextResponse.json({ ok: true, ignored: 'no payment reference' });
  }
  const paymentResult = await paymentQuery;
  if (paymentResult.error) return failPaymentEvent(paymentResult.error.message);
  if (!paymentResult.data) {
    const completionError = await completePaymentEvent();
    return completionError ? failPaymentEvent(completionError) : NextResponse.json({ ok: true, ignored: 'payment not found' });
  }
  const status = event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded' ? 'paid'
    : event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed' ? 'failed'
      : event.type === 'charge.refunded' ? 'refunded' : null;
  if (!status) {
    const completionError = await completePaymentEvent();
    return completionError ? failPaymentEvent(completionError) : NextResponse.json({ ok: true, ignored: event.type });
  }
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (event.type.startsWith('checkout.session.') && externalId) patch.external_id = externalId;
  if (providerPaymentId) patch.provider_payment_id = providerPaymentId;
  if (event.type === 'charge.refunded' && typeof object.amount_refunded === 'number') {
    patch.refunded_amount_minor = object.amount_refunded;
  }
  const paymentRowId = (paymentResult.data as { id: string }).id;
  const { error: updateError } = await supabase.from('payments').update(patch)
    .eq('id', paymentRowId).eq('tenant_id', tenantId).eq('business_id', businessId);
  if (updateError) return failPaymentEvent(updateError.message);
  const completionError = await completePaymentEvent();
  if (completionError) return failPaymentEvent(completionError);
  return NextResponse.json({ ok: true, payment_id: paymentRowId, status });
}
