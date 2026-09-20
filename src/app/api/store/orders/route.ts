import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isValidIdempotencyKey, resolvePublicStore } from '@/lib/storefront';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';
import { enqueueNotification } from '@/lib/notifications/outbox';
import {
  MAX_ORDER_TOTAL,
  storeOrderSchema,
} from '@/lib/store-order';

/**
 * 新订单通知商户（Phase 16 任务 5）。
 *
 * 修的问题：扫码下单成功后**没有任何通知**，"能下单但叫不动厨房"。
 * 复用既有的 `notification_outbox` + scheduler worker，不新建通道：
 * 邮件是老板一定有的通道，Web Push 是即时通道（未订阅推送时 worker 会记失败，
 * 不影响邮件那条）。
 *
 * 幂等键含订单 id：同一订单的通知重复入队不会重复打扰。
 * 通知失败**不影响下单结果** —— 订单已经落库，顾客不该因为通知发不出去而看到报错；
 * 但必须留日志，不能静默（本项目 Phase 15 的教训）。
 */
async function notifyNewOrder(input: {
  tenantId: string;
  businessId: string;
  orderId: string;
  orderNo: string;
  tableNo: string | null;
  total: number;
  itemCount: number;
}): Promise<void> {
  const title = `New QR order ${input.orderNo}`;
  const content =
    `Table ${input.tableNo ?? '-'} placed an order: ${input.itemCount} item(s), ` +
    `total ${input.total.toFixed(2)}. Open the dashboard to confirm and prepare.`;
  const channels = ['email', 'web_push'] as const;
  for (const channel of channels) {
    try {
      await enqueueNotification({
        tenantId: input.tenantId,
        businessId: input.businessId,
        channel,
        notificationType: 'QR_ORDER_PLACED',
        title,
        content,
        priority: 'high',
        idempotencyKey: `qr-order:${input.orderId}:${channel}`,
      });
    } catch (error) {
      console.error(
        `[store/orders] notification enqueue failed channel=${channel} order=${input.orderId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** 销售计数 RPC 有界重试（3 次，指数间隔）；彻底失败仅告警不阻断下单主链路。 */
async function bumpSalesCounterWithRetry(
  tenantId: string,
  productId: string,
  incrementBy: number,
): Promise<void> {
  const supabase = getSupabaseClient();
  let delayMs = 300;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.rpc('increment_product_sales', {
      target_tenant_id: tenantId,
      target_product_id: productId,
      increment_by: incrementBy,
    });
    if (!error) return;
    if (attempt === 3) {
      console.warn(`[store/orders] sale counter failed after ${attempt} attempts:`, error.message);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs *= 2;
  }
}

/**
 * 订单内容的指纹（用于判断"同一个 Idempotency-Key 是不是同一张单"）。
 *
 * ## 为什么不用商品名
 *
 * 初版用 `item.name` 拼指纹 —— 但**请求里的 items 只有 `{product_id, qty}`**，
 * 没有 `name`（名字要查商品表才知道）。于是请求侧拼出一串 `?x2`，
 * 与库里的 `Phase16 Test Dishx2` 永不相等，**同一个 key 的合法重试被误判为冲突**。
 * 实测（`_verify_phase16_core.mts`）：第二次同内容请求返回 409 而不是幂等命中 ——
 * 那比"重复下单"更糟：顾客永远下不了这一单。
 *
 * 现在用**已按商品表核验过的 product_id**，它本身就是内容的一部分：
 * 换菜必然换 id，改数量必然改 qty，价格变了必然改 subtotal。
 *
 * 指纹在商品解析**之后**计算，因此是权威值，不是猜测值。
 */
export function orderContentFingerprint(input: {
  items: readonly { product_id: string; qty: number }[];
  subtotal: number;
  tipAmount: number;
  tableNo: string | null;
}): string {
  const items = [...input.items]
    .map((item) => `${item.product_id}x${item.qty}`)
    .sort()
    .join(',');
  return `${items}|${input.subtotal.toFixed(2)}|${input.tipAmount.toFixed(2)}|${input.tableNo ?? ''}`;
}

/** Creates a QR order with server-side prices and strict tenant scope. */
export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const parsed = storeOrderSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_order', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const body = parsed.data;
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
  const items = body.items.map((item) => ({ product_id: item.product_id, qty: item.qty }));
  const tipAmount = Math.round(body.tip_amount * 100) / 100;
  const tipPercent = body.tip_percent === null || body.tip_percent === undefined
    ? null
    : Math.round(body.tip_percent * 100) / 100;
  const note = body.note ? body.note.slice(0, 500) : null;
  const supabase = getSupabaseClient();
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
  // 指纹在商品解析**之后**计算 —— 此时 items 的 id 与价格都已核验，
  // 因此这是权威值（初版在解析前用商品名拼指纹，拼不出来，见函数注释）。
  const requestFingerprint = orderContentFingerprint({
    items,
    subtotal,
    tipAmount,
    tableNo: store.tableNo,
  });
  if (idempotencyKey) {
    const { data: existing, error: lookupError } = await supabase
      .from('orders')
      .select('id, order_no, total, tip, tip_percent, table_no, created_at, idempotency_fingerprint')
      .eq('tenant_id', store.tenantId)
      .eq('business_id', store.businessId)
      .eq('source', 'qr')
      .eq('external_id', idempotencyKey)
      .maybeSingle();
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    if (existing) {
      // 同 key 同指纹 = 真的重试 ⇒ 返回既有订单；同 key 不同指纹 = 冲突，不能静默吞掉。
      // 老订单没有指纹（此列之前不存在）：按"同 key 即重试"处理，与改动前行为一致。
      const storedFingerprint = (existing as { idempotency_fingerprint?: string | null })
        .idempotency_fingerprint ?? null;
      if (storedFingerprint !== null && storedFingerprint !== requestFingerprint) {
        return NextResponse.json(
          {
            error: 'idempotency_key_conflict',
            detail: 'This Idempotency-Key was already used for a different order. Use a new key for a new order.',
            existing_order_no: String((existing as { order_no?: string }).order_no ?? ''),
          },
          { status: 409 },
        );
      }
      const { idempotency_fingerprint: _fp, ...order } = existing as Record<string, unknown>;
      return NextResponse.json({ order, idempotent: true });
    }
  }
  const total = Math.round((subtotal + tipAmount) * 100) / 100;
  if (total > MAX_ORDER_TOTAL) {
    return NextResponse.json({ error: `order total exceeds the ${MAX_ORDER_TOTAL} cap` }, { status: 400 });
  }
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
    ...(idempotencyKey ? { external_id: idempotencyKey, idempotency_fingerprint: requestFingerprint } : {}),
    table_no: store.tableNo,
    notes: note,
  }).select('id, order_no, total, tip, tip_percent, table_no, created_at').single();
  if (insertError) {
    // P0-6：并发同 key 双插竞态兜底 —— 部分唯一索引 orders_qr_idempotency_idx
    // 冲突(23505)时返回既有订单，保证同 key 幂等只落一行。
    if (idempotencyKey && insertError.code === '23505') {
      const { data: raced, error: raceError } = await supabase
        .from('orders')
        .select('id, order_no, total, tip, tip_percent, table_no, created_at, idempotency_fingerprint')
        .eq('tenant_id', store.tenantId)
        .eq('business_id', store.businessId)
        .eq('source', 'qr')
        .eq('external_id', idempotencyKey)
        .maybeSingle();
      if (!raceError && raced) {
        const racedFingerprint = (raced as { idempotency_fingerprint?: string | null }).idempotency_fingerprint ?? null;
        if (racedFingerprint !== null && racedFingerprint !== requestFingerprint) {
          // 并发插入的另一张不同内容的单：与顺序路径同样报冲突，不静默返回别人的单
          return NextResponse.json(
            {
              error: 'idempotency_key_conflict',
              detail: 'This Idempotency-Key was already used for a different order. Use a new key for a new order.',
            },
            { status: 409 },
          );
        }
        const { idempotency_fingerprint: _fp2, ...order } = raced as Record<string, unknown>;
        return NextResponse.json({ order, idempotent: true });
      }
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }
  for (const item of items) {
    await bumpSalesCounterWithRetry(store.tenantId, item.product_id, item.qty);
  }
  // 通知厨房/老板。await 而不是 fire-and-forget —— Next.js 路由里
  // 未 await 的 Promise 会被丢弃（AGENTS.md 陷阱 13）。
  // 失败已在函数内部留日志，不影响下单结果。
  await notifyNewOrder({
    tenantId: store.tenantId,
    businessId: store.businessId,
    orderId: String((order as { id: string }).id),
    orderNo,
    tableNo: store.tableNo,
    total,
    itemCount: orderItems.reduce((sum, item) => sum + item.qty, 0),
  });
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
