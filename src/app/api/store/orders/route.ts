import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isValidIdempotencyKey, resolvePublicStore } from '@/lib/storefront';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';

interface CartItem { product_id: string; qty: number }
type StoreOrderBody = { token?: unknown; note?: unknown; items?: unknown; tip_amount?: unknown; tip_percent?: unknown };

/** Creates a QR order with server-side prices and strict tenant scope. */
export async function POST(request: NextRequest) {
  let body: StoreOrderBody;
  try { body = await request.json() as StoreOrderBody; } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const store = await resolvePublicStore(typeof body.token === 'string' ? body.token : null);
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });

  // P0-1：公开下单限流 —— 每桌码链接 30 次/分钟。
  const limit = checkFixedWindow(
    `store:orders:${store.tenantId}:${store.businessId}:${store.tableNo}`,
    { limit: 30, windowMs: 60_000 },
  );
  if (!limit.ok) return rateLimitResponse(limit);

  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: 'Invalid Idempotency-Key' }, { status: 400 });
  }
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((item): item is CartItem => typeof item?.product_id === 'string' && Number(item?.qty) > 0)
    .map((item) => ({ product_id: item.product_id, qty: Math.min(Math.floor(Number(item.qty)), 99) }));
  if (items.length === 0) return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
  const tipAmount = typeof body.tip_amount === 'number' && Number.isFinite(body.tip_amount) && body.tip_amount >= 0 ? Math.round(body.tip_amount * 100) / 100 : 0;
  const tipPercent = typeof body.tip_percent === 'number' && Number.isFinite(body.tip_percent) ? Math.round(body.tip_percent * 100) / 100 : null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
  const supabase = getSupabaseClient();
  if (idempotencyKey) {
    const { data: existing, error: lookupError } = await supabase
      .from('orders')
      .select('id, order_no, total, tip, tip_percent, table_no, created_at')
      .eq('tenant_id', store.tenantId)
      .eq('business_id', store.businessId)
      .eq('source', 'qr')
      .eq('external_id', idempotencyKey)
      .maybeSingle();
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    if (existing) return NextResponse.json({ order: existing, idempotent: true });
  }
  const ids = Array.from(new Set(items.map((item) => item.product_id)));
  const { data: products, error } = await supabase.from('products').select('id, name, price, status').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).in('id', ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const byId = new Map((products ?? []).map((product) => [product.id, product]));
  const orderItems: { name: string; qty: number; price: number }[] = [];
  let subtotal = 0;
  for (const item of items) {
    const product = byId.get(item.product_id);
    if (!product || product.status !== 'active') return NextResponse.json({ error: 'Some items are no longer available' }, { status: 409 });
    const price = Number(product.price);
    subtotal += price * item.qty;
    orderItems.push({ name: product.name, qty: item.qty, price });
  }
  const total = Math.round((subtotal + tipAmount) * 100) / 100;
  const orderNo = `RF-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const { data: order, error: insertError } = await supabase.from('orders').insert({
    tenant_id: store.tenantId,
    business_id: store.businessId,
    order_no: orderNo,
    items: orderItems,
    total,
    tip: tipAmount,
    tip_percent: tipPercent,
    channel: 'dine_in',
    status: 'pending',
    source: 'qr',
    ...(idempotencyKey ? { external_id: idempotencyKey } : {}),
    table_no: store.tableNo,
    notes: note,
  }).select('id, order_no, total, tip, tip_percent, table_no, created_at').single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  for (const item of items) {
    const { error: salesError } = await supabase.rpc('increment_product_sales', { target_tenant_id: store.tenantId, target_product_id: item.product_id, increment_by: item.qty });
    if (salesError) console.warn('[store/orders] sale counter update failed:', salesError.message);
  }
  return NextResponse.json({ order });
}

/** Attributes a QR tip only to a staff member in the same tenant and table. */
export async function PATCH(request: NextRequest) {
  let body: { token?: unknown; order_id?: unknown; tip_staff_id?: unknown };
  try { body = await request.json() as { token?: unknown; order_id?: unknown; tip_staff_id?: unknown }; } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const store = await resolvePublicStore(typeof body.token === 'string' ? body.token : null);
  const orderId = typeof body.order_id === 'string' ? body.order_id : null;
  const staffId = typeof body.tip_staff_id === 'string' ? body.tip_staff_id : null;
  if (!store || !orderId || !staffId) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const supabase = getSupabaseClient();
  const [{ data: order }, { data: staff }] = await Promise.all([
    supabase.from('orders').select('id').eq('id', orderId).eq('tenant_id', store.tenantId).eq('business_id', store.businessId).eq('table_no', store.tableNo).eq('source', 'qr').maybeSingle(),
    supabase.from('staff').select('id').eq('id', staffId).eq('tenant_id', store.tenantId).eq('business_id', store.businessId).eq('is_active', true).maybeSingle(),
  ]);
  if (!order || !staff) return NextResponse.json({ error: 'Order or staff member not found' }, { status: 404 });
  const { error } = await supabase.from('orders').update({ tip_staff_id: staffId }).eq('id', orderId).eq('tenant_id', store.tenantId).eq('business_id', store.businessId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
