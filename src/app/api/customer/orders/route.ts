import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession } from '@/lib/customer-auth';

/**
 * GET /api/customer/orders —— 当前顾客的订单。
 *
 * ## 为什么用手机号匹配，而不是外键
 *
 * `orders.customer_id` 指的是**商家侧的 CRM 客户**（`customers` 表，商家自己
 * 维护的名单），顾客注册时不会自动落进那张表。因此顾客与订单之间当前**没有**
 * 外键可用，唯一天然的关联键是下单时填的收货手机号
 * （`delivery_orders.recipient_phone`）。
 *
 * 匹配是**精确相等**：不做 +86 / 空格 / 连字符归一化。归一化需要一条唯一规则，
 * 而在"猜两边格式"的路径上误配的后果是把**别人的订单**返回给这个顾客；
 * 宁可漏（顾客重新下单/联系商家）也不能错。
 *
 * 只用邮箱注册（没有手机号）的账号目前匹配不到任何订单：一条都不返回，
 * 而不是"返回该租户的全部订单"。
 *
 * ## 不是自己的单为什么是 404 而不是 403
 *
 * 403 等于确认"这个订单 id 存在，只是不属于你"。订单 id 是可枚举的短标识，
 * 那会把接口变成订单存在性的探针。因此非本人单一律 404，与"订单不存在"同一响应。
 *
 * ## 查询上界
 *
 * 列表按最近 100 条外卖记录取（`delivery_orders` 是匹配键所在的表）。
 * 这个上限是有意的：把全部历史订单 id 拼进 PostgREST 的 `in.(...)` 会让 URL
 * 随订单数无界增长。**被截断时本接口不会伪装成完整列表** —— 需要翻页时应改为
 * 带游标的实现，而不是悄悄放宽这里。
 */

/** 列表上界（见文件头"查询上界"）。 */
const MAX_ORDERS = 100;

interface OrderRow {
  id: string;
  order_no: string;
  channel: string;
  status: string;
  total: string | number;
  created_at: string;
}

const ORDER_COLUMNS = 'id, order_no, channel, status, total, created_at';

/** 统一出口形态：total 从 numeric（字符串）转成数字。 */
function toOrder(row: OrderRow, riderStatus: string | null) {
  return {
    id: row.id,
    order_no: row.order_no,
    channel: row.channel,
    status: row.status,
    total: Number(row.total),
    created_at: row.created_at,
    rider_status: riderStatus,
  };
}

export async function GET(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const client = getSupabaseClient();
  const { data: accountRow, error: accountError } = await client
    .from('customer_accounts')
    .select('phone')
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();
  if (accountError) {
    console.error('[customer/orders] account lookup failed:', accountError.message);
    return jsonError('orders could not be loaded', 500);
  }
  if (!accountRow) return jsonError('unauthorized', 401);

  const phone = (accountRow as { phone: string | null }).phone;
  const requestedId = new URL(request.url).searchParams.get('id');

  if (!phone) {
    // 没有手机号 ⇒ 没有任何可证明归属的订单。单一查询返回 404（不是 403）。
    if (requestedId) return jsonError('order not found', 404);
    return json({ orders: [] });
  }

  // -------------------------------------------------------------------------
  // 单条：先证明这张单的收货手机号就是本账号的，再取订单本身
  // -------------------------------------------------------------------------
  if (requestedId) {
    const { data: delivery, error: deliveryError } = await client
      .from('delivery_orders')
      .select('order_id, rider_status')
      .eq('order_id', requestedId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .eq('recipient_phone', phone)
      .maybeSingle();
    if (deliveryError) {
      console.error('[customer/orders] delivery lookup failed:', deliveryError.message);
      return jsonError('orders could not be loaded', 500);
    }
    if (!delivery) return jsonError('order not found', 404);

    const { data: order, error: orderError } = await client
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', requestedId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .maybeSingle();
    if (orderError) {
      console.error('[customer/orders] order lookup failed:', orderError.message);
      return jsonError('orders could not be loaded', 500);
    }
    if (!order) return jsonError('order not found', 404);

    const riderStatus = (delivery as { rider_status: string | null }).rider_status;
    return json({ order: toOrder(order as OrderRow, riderStatus) });
  }

  // -------------------------------------------------------------------------
  // 列表：手机号 → 外卖记录 → 订单
  // -------------------------------------------------------------------------
  const { data: deliveries, error: deliveriesError } = await client
    .from('delivery_orders')
    .select('order_id, rider_status')
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .eq('recipient_phone', phone)
    .order('created_at', { ascending: false })
    .limit(MAX_ORDERS);
  if (deliveriesError) {
    console.error('[customer/orders] delivery list failed:', deliveriesError.message);
    return jsonError('orders could not be loaded', 500);
  }

  const riderByOrderId = new Map<string, string | null>();
  for (const row of (deliveries ?? []) as { order_id: string; rider_status: string | null }[]) {
    riderByOrderId.set(row.order_id, row.rider_status);
  }
  const orderIds = [...riderByOrderId.keys()];
  if (orderIds.length === 0) return json({ orders: [] });

  const { data: orders, error: ordersError } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .in('id', orderIds)
    .order('created_at', { ascending: false });
  if (ordersError) {
    console.error('[customer/orders] order list failed:', ordersError.message);
    return jsonError('orders could not be loaded', 500);
  }

  return json({
    orders: ((orders ?? []) as OrderRow[]).map((row) =>
      toOrder(row, riderByOrderId.get(row.id) ?? null)),
  });
}
