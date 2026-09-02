import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

interface CartItem {
  product_id: string;
  qty: number;
}

// H5 商城下单接口：价格以服务端商品表为准，不信任客户端金额
export async function POST(request: NextRequest) {
  const body = await request.json();
  const tableNo = typeof body.table_no === 'string' ? body.table_no.slice(0, 20) : null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
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

  // 生成订单号：#RF-序列
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true });
  const orderNo = `#RF-${10241 + (count ?? 0)}`;

  const { data: order, error: insErr } = await supabase
    .from('orders')
    .insert({
      order_no: orderNo,
      items: orderItems,
      total,
      channel: 'dine_in',
      status: 'pending',
      source: 'qr',
      table_no: tableNo,
      notes: note,
    })
    .select('id, order_no, total, table_no, created_at')
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
