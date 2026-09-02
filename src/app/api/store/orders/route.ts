import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

interface CartItem {
  product_id: string;
  qty: number;
}

// H5 商城下单接口：价格以服务端商品表为准，不信任客户端金额
export async function POST(request: NextRequest) {
  let body: { table_no?: unknown; note?: unknown; items?: unknown; tip_amount?: unknown; tip_percent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const tableNo = typeof body.table_no === 'string' ? body.table_no.slice(0, 20) : null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
  // 小费：服务端校验，tip_amount 非负，tip_percent 可选（记录比例）
  const tipAmount =
    typeof body.tip_amount === 'number' && Number.isFinite(body.tip_amount) && body.tip_amount >= 0
      ? Math.round(body.tip_amount * 100) / 100
      : 0;
  const tipPercent =
    typeof body.tip_percent === 'number' && Number.isFinite(body.tip_percent)
      ? Math.round(body.tip_percent * 100) / 100
      : null;
  const rawItems: CartItem[] = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .filter((i) => typeof i?.product_id === 'string' && Number(i?.qty) > 0)
    .map((i) => ({ product_id: i.product_id, qty: Math.min(Math.floor(Number(i.qty)), 99) }));

  if (items.length === 0) {
    return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const ids = Array.from(new Set(items.map((i) => i.product_id)));
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, price, status, sales_count')
    .in('id', ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  const orderItems: { name: string; qty: number; price: number }[] = [];
  let total = 0;
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (!p || p.status !== 'active') {
      return NextResponse.json({ error: 'Some items are no longer available' }, { status: 409 });
    }
    const price = Number(p.price);
    total += price * item.qty;
    orderItems.push({ name: p.name, qty: item.qty, price });
  }
  total = Math.round(total * 100) / 100;
  const grandTotal = Math.round((total + tipAmount) * 100) / 100;

  // 生成订单号：#RF-序列
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true });
  const orderNo = `#RF-${10241 + (count ?? 0)}`;

  const { data: order, error: insErr } = await supabase
    .from('orders')
    .insert({
      order_no: orderNo,
      items: orderItems,
      total: grandTotal,
      tip: tipAmount,
      tip_percent: tipPercent,
      channel: 'dine_in',
      status: 'pending',
      source: 'qr',
      table_no: tableNo,
      notes: note,
    })
    .select('id, order_no, total, tip, tip_percent, table_no, created_at')
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 销量累计（失败不影响下单结果）
  for (const item of items) {
    const p = byId.get(item.product_id)!;
    try {
      await supabase
        .from('products')
        .update({ sales_count: (p.sales_count ?? 0) + item.qty, updated_at: new Date().toISOString() })
        .eq('id', p.id);
    } catch {
      // 忽略累计失败
    }
  }

  return NextResponse.json({ order });
}

// 顾客下单后选择服务员工：把已下的订单小费归属到某位员工
export async function PATCH(request: NextRequest) {
  let body: { order_id?: unknown; tip_staff_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const orderId = typeof body.order_id === 'string' ? body.order_id : null;
  const staffId = typeof body.tip_staff_id === 'string' ? body.tip_staff_id : null;
  if (!orderId || !staffId) {
    return NextResponse.json({ error: 'order_id and tip_staff_id required' }, { status: 400 });
  }
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('orders').update({ tip_staff_id: staffId }).eq('id', orderId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
