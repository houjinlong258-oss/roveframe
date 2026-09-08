import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/subscriptions — 订阅列表 + 计划列表。
 * POST /api/admin/subscriptions — 登记订阅事件（幂等：event_key 唯一，重复事件不重复处理）。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.subscriptions.list' }, async () => {
    const client = getSupabaseClient();
    const [plans, subs, events, invoices] = await Promise.all([
      client.from('subscription_plans').select('*').eq('is_active', true).order('price_amount'),
      client.from('tenant_subscriptions').select('*').order('updated_at', { ascending: false }).limit(200),
      client.from('subscription_events').select('*').order('created_at', { ascending: false }).limit(100),
      client.from('invoices').select('*').order('issued_at', { ascending: false }).limit(100),
    ]);
    return NextResponse.json({
      plans: plans.data ?? [],
      subscriptions: subs.data ?? [],
      recentEvents: events.data ?? [],
      recentInvoices: invoices.data ?? [],
    });
  });
}

export async function POST(request: Request) {
  return adminHandler(request, { action: 'admin.subscriptions.event', roles: ['super_admin', 'admin'] }, async () => {
    const body = await request.json();
    const eventKey = typeof body.eventKey === 'string' ? body.eventKey.trim() : '';
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId : '';
    const type = typeof body.type === 'string' ? body.type : '';
    if (!eventKey || !tenantId || !type) {
      return NextResponse.json({ error: 'eventKey, tenantId, type required' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: inserted, error } = await client
      .from('subscription_events')
      .upsert({
        event_key: eventKey,
        tenant_id: tenantId,
        type,
        payload: typeof body.payload === 'object' && body.payload ? body.payload : {},
        processed_at: new Date().toISOString(),
      }, { onConflict: 'event_key', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(error.message);

    // ignoreDuplicates 时重复事件返回空数组 → 幂等命中
    const idempotent = Array.isArray(inserted) && inserted.length === 0;
    return NextResponse.json({ ok: true, idempotent }, { status: idempotent ? 200 : 201 });
  });
}
