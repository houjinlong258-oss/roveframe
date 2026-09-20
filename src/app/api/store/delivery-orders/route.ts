import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isValidIdempotencyKey, resolvePublicStore } from '@/lib/storefront';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';
import { enqueueNotification } from '@/lib/notifications/outbox';
import { MAX_ORDER_TOTAL, storeOrderSchema } from '@/lib/store-order';
import {
  deliveryContentFingerprint,
  getDeliveryRules,
  promisedAtFrom,
  quoteDelivery,
} from '@/lib/delivery';

/**
 * 外卖下单（公开，顾客端 PWA）。
 *
 * ## 与堂食下单的关系
 *
 * 计价、幂等、限流三条纪律与 `src/app/api/store/orders/route.ts` 完全一致，
 * 但**不复用那个路由**：堂食的 `table_no` 语义、小费归属、二维码计数在外卖场景
 * 都不成立，硬塞进去会给两个流程都加上条件分支。
 *
 * 一致的部分是纪律，不是代码：
 *   · 价格一律按 `products` 表服务端计算（第 145-156 行的同一条做法）
 *   · 幂等键走 header + 指纹，冲突显式 409 而不静默返回别人的单
 *   · 限流按 token 与 IP 两条线
 *
 * ## 与堂食的三处不同
 *
 *   1. `source = 'web'`（不是 'qr'），因此走的是新加的
 *      `orders_web_idempotency_idx` 唯一索引（scripts/migrate-delivery-orders.sql）
 *   2. `channel = 'delivery'`，无 `table_no`
 *   3. 额外校验配送规则（是否开启、是否达起送价），配送费由服务端加进总额
 */

const MAX_DELIVERY_ITEMS = 50;

interface DeliveryBody {
  token?: unknown;
  items?: unknown;
  recipient_name?: unknown;
  recipient_phone?: unknown;
  address_line?: unknown;
  address_note?: unknown;
  notes?: unknown;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function notifyNewDelivery(input: {
  tenantId: string;
  businessId: string;
  orderId: string;
  orderNo: string;
  addressLine: string;
  total: number;
  itemCount: number;
}): Promise<void> {
  try {
    await enqueueNotification({
      tenantId: input.tenantId,
      businessId: input.businessId,
      channel: 'web_push',
      notificationType: 'delivery.created',
      title: `New delivery order ${input.orderNo}`,
      content: `${input.itemCount} item(s), total ${input.total.toFixed(2)}, to ${input.addressLine}`,
      priority: 'high',
      // 幂等键含订单 id：同一单重复入队不会重复打扰员工。
      idempotencyKey: `delivery.created:${input.orderId}`,
    });
  } catch (error) {
    // 通知失败不影响下单结果 —— 订单已经落库。但必须留日志，不能静默
    // （AGENTS.md 与 Phase 15 都记过这条）。
    console.error('[store/delivery-orders] notify failed:', error instanceof Error ? error.message : error);
  }
}

export async function POST(request: NextRequest) {
  let raw: DeliveryBody;
  try {
    raw = (await request.json()) as DeliveryBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = storeOrderSchema.safeParse({
    token: typeof raw.token === 'string' ? raw.token : undefined,
    note: text(raw.notes, 500) || undefined,
    items: raw.items,
    tip_amount: 0,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid order payload' }, { status: 400 });
  }
  const items = parsed.data.items.map((item) => ({ product_id: item.product_id, qty: item.qty }));
  if (items.length > MAX_DELIVERY_ITEMS) {
    return NextResponse.json({ error: 'Too many items' }, { status: 400 });
  }

  const recipientName = text(raw.recipient_name, 80);
  const recipientPhone = text(raw.recipient_phone, 40);
  const addressLine = text(raw.address_line, 240);
  const addressNote = text(raw.address_note, 240);
  const notes = text(raw.notes, 500);

  if (!recipientName) return NextResponse.json({ error: 'recipient_name is required' }, { status: 400 });
  // 至少 5 位数字：与公开预约接口同一口径（src/app/api/site/reservations/route.ts）。
  if (recipientPhone.replace(/[^0-9]/g, '').length < 5) {
    return NextResponse.json({ error: 'a valid recipient_phone is required' }, { status: 400 });
  }
  if (addressLine.length < 4) {
    return NextResponse.json({ error: 'address_line is required' }, { status: 400 });
  }

  const store = await resolvePublicStore(typeof raw.token === 'string' ? raw.token : null);
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });

  const limit = checkFixedWindow(
    `store:delivery:${store.tenantId}:${store.businessId}:${store.tableNo}`,
    { limit: 30, windowMs: 60_000 },
  );
  if (!limit.ok) return rateLimitResponse(limit);

  const rules = await getDeliveryRules(store.tenantId, store.businessId);
  if (!rules.enabled) {
    return NextResponse.json({ error: 'This store does not offer delivery' }, { status: 409 });
  }

  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: 'Invalid Idempotency-Key' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const ids = Array.from(new Set(items.map((item) => item.product_id)));
  const { data: products, error: productError } = await supabase
    .from('products')
    .select('id, name, price, status')
    .eq('tenant_id', store.tenantId)
    .eq('business_id', store.businessId)
    .in('id', ids);
  if (productError) return NextResponse.json({ error: productError.message }, { status: 500 });

  const byId = new Map((products ?? []).map((product) => [product.id, product]));
  const orderItems: { name: string; qty: number; price: number }[] = [];
  let subtotal = 0;
  for (const item of items) {
    const product = byId.get(item.product_id);
    if (!product || product.status !== 'active') {
      return NextResponse.json({ error: 'Some items are no longer available' }, { status: 409 });
    }
    const price = Number(product.price);
    subtotal += price * item.qty;
    orderItems.push({ name: product.name, qty: item.qty, price });
  }

  const quote = quoteDelivery(rules, subtotal);
  if (!quote.meetsMinimum) {
    return NextResponse.json(
      {
        error: 'order_below_minimum',
        detail: `This store requires a minimum of ${quote.minOrderAmount} for delivery.`,
        shortfall: quote.shortfall,
      },
      { status: 400 },
    );
  }

  // 指纹在商品解析**之后**计算 —— 此时 id 与价格都已核验，因此是权威值。
  const fingerprint = deliveryContentFingerprint({
    items,
    subtotal,
    fee: quote.fee,
    addressLine,
    recipientPhone,
  });

  if (idempotencyKey) {
    const { data: existing, error: lookupError } = await supabase
      .from('orders')
      .select('id, order_no, total, created_at, idempotency_fingerprint')
      .eq('tenant_id', store.tenantId)
      .eq('business_id', store.businessId)
      .eq('source', 'web')
      .eq('external_id', idempotencyKey)
      .maybeSingle();
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    if (existing) {
      const stored = (existing as { idempotency_fingerprint?: string | null }).idempotency_fingerprint ?? null;
      if (stored !== null && stored !== fingerprint) {
        return NextResponse.json(
          {
            error: 'idempotency_key_conflict',
            detail: 'This Idempotency-Key was already used for a different order.',
            existing_order_no: String((existing as { order_no?: string }).order_no ?? ''),
          },
          { status: 409 },
        );
      }
      const { data: delivery } = await supabase
        .from('delivery_orders')
        .select('id, fee, rider_status, promised_at')
        .eq('order_id', (existing as { id: string }).id)
        .maybeSingle();
      const { idempotency_fingerprint: _fp, ...order } = existing as Record<string, unknown>;
      return NextResponse.json({ order, delivery, idempotent: true });
    }
  }

  const total = Math.round((subtotal + quote.fee) * 100) / 100;
  if (total > MAX_ORDER_TOTAL) {
    return NextResponse.json({ error: `order total exceeds the ${MAX_ORDER_TOTAL} cap` }, { status: 400 });
  }

  const orderNo = `RF-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const promisedAt = promisedAtFrom(new Date(), quote.prepMinutes);

  const { data: order, error: insertError } = await supabase
    .from('orders')
    .insert({
      tenant_id: store.tenantId,
      business_id: store.businessId,
      order_no: orderNo,
      items: orderItems,
      total,
      tip: 0,
      tip_percent: null,
      channel: 'delivery',
      status: 'pending',
      source: 'web',
      ...(idempotencyKey ? { external_id: idempotencyKey, idempotency_fingerprint: fingerprint } : {}),
      table_no: null,
      notes: notes || null,
    })
    .select('id, order_no, total, created_at')
    .single();

  if (insertError || !order) {
    // 并发同 key 双插：靠 orders_web_idempotency_idx 冲突(23505)兜底。
    // 没有那条索引，这里就永远进不来，会落两张单。
    if (idempotencyKey && insertError?.code === '23505') {
      const { data: raced } = await supabase
        .from('orders')
        .select('id, order_no, total, created_at, idempotency_fingerprint')
        .eq('tenant_id', store.tenantId)
        .eq('business_id', store.businessId)
        .eq('source', 'web')
        .eq('external_id', idempotencyKey)
        .maybeSingle();
      if (raced) {
        const racedFp = (raced as { idempotency_fingerprint?: string | null }).idempotency_fingerprint ?? null;
        if (racedFp !== null && racedFp !== fingerprint) {
          return NextResponse.json(
            { error: 'idempotency_key_conflict', detail: 'This Idempotency-Key was already used for a different order.' },
            { status: 409 },
          );
        }
        const { data: delivery } = await supabase
          .from('delivery_orders')
          .select('id, fee, rider_status, promised_at')
          .eq('order_id', (raced as { id: string }).id)
          .maybeSingle();
        const { idempotency_fingerprint: _fp2, ...existingOrder } = raced as Record<string, unknown>;
        return NextResponse.json({ order: existingOrder, delivery, idempotent: true });
      }
    }
    return NextResponse.json({ error: insertError?.message ?? 'order insert failed' }, { status: 500 });
  }

  const orderId = String((order as { id: string }).id);
  const { data: delivery, error: deliveryError } = await supabase
    .from('delivery_orders')
    .insert({
      tenant_id: store.tenantId,
      business_id: store.businessId,
      order_id: orderId,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      address_line: addressLine,
      address_note: addressNote || null,
      // 规则快照：商家事后改配送费不应改写这一单的金额。
      fee: quote.fee,
      min_order_amount: quote.minOrderAmount,
      promised_at: promisedAt,
      rider_status: 'pending',
    })
    .select('id, fee, rider_status, promised_at')
    .single();

  if (deliveryError || !delivery) {
    // 订单已落库但配送单没建起来 —— 这是一张**无法配送的外卖单**。
    // 不能假装成功：标记订单取消并如实报错，让顾客重下、让老板看得见。
    await supabase
      .from('orders')
      .update({ status: 'cancelled', notes: `delivery record failed: ${deliveryError?.message ?? 'unknown'}` })
      .eq('id', orderId)
      .eq('tenant_id', store.tenantId)
      .eq('business_id', store.businessId);
    console.error('[store/delivery-orders] delivery row insert failed:', deliveryError?.message);
    return NextResponse.json({ error: 'delivery could not be created' }, { status: 500 });
  }

  await notifyNewDelivery({
    tenantId: store.tenantId,
    businessId: store.businessId,
    orderId,
    orderNo,
    addressLine,
    total,
    itemCount: orderItems.reduce((sum, item) => sum + item.qty, 0),
  });

  return NextResponse.json(
    {
      order_id: orderId,
      order_no: orderNo,
      subtotal: quote.subtotal,
      fee: quote.fee,
      total,
      promised_at: promisedAt,
      delivery_id: (delivery as { id: string }).id,
    },
    { status: 201 },
  );
}
