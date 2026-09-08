import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type SubscribeBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

/** Register a Web Push Notification subscription for the authenticated user. */
async function subscribe(request: NextRequest) {
  const auth = requireBusinessContext(await getTenantContext(request));

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : null;
  const authKey = typeof body.keys?.auth === 'string' ? body.keys.auth : null;

  if (!endpoint || !p256dh || !authKey) {
    return NextResponse.json({ error: 'Invalid push subscription object' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: existing } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', endpoint)
    .eq('tenant_id', auth.tenantId)
    .eq('business_id', auth.businessId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('push_subscriptions')
      .update({
        tenant_id: auth.tenantId,
        business_id: auth.businessId,
        user_id: auth.userId,
        keys: { p256dh, auth: authKey },
      })
      .eq('id', existing.id)
      .eq('tenant_id', auth.tenantId)
      .eq('business_id', auth.businessId);
    return NextResponse.json({ ok: true, id: existing.id, updated: true });
  }

  const { data, error } = await supabase
    .from('push_subscriptions')
    .insert({
      tenant_id: auth.tenantId,
      business_id: auth.businessId,
      user_id: auth.userId,
      endpoint,
      keys: { p256dh, auth: authKey },
    })
    .select('id')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to save push subscription' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id });
}

/** Unsubscribe from Web Push notifications. */
async function unsubscribe(request: NextRequest) {
  const auth = requireBusinessContext(await getTenantContext(request));

  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get('endpoint');
  if (!endpoint) {
    return NextResponse.json({ error: 'Endpoint parameter is required' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('tenant_id', auth.tenantId)
    .eq('business_id', auth.businessId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'notifications:write', action: 'push_subscriptions.subscribe', entity: 'push_subscriptions' },
  subscribe,
);

export const DELETE = protectBusinessMutation(
  { permission: 'notifications:write', action: 'push_subscriptions.unsubscribe', entity: 'push_subscriptions' },
  unsubscribe,
);
