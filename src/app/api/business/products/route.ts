import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 产品管理
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('products').select('*').order('sales_count', { ascending: false });
  if (error) throw new Error(error.message);

  // 本周销量/营收（近 7 天订单明细聚合）
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: weekOrders, error: oErr } = await supabase
    .from('orders')
    .select('items')
    .gte('created_at', weekAgo)
    .neq('status', 'cancelled');
  if (oErr) throw new Error(oErr.message);

  const weekly: Record<string, { qty: number; revenue: number }> = {};
  for (const o of weekOrders ?? []) {
    for (const item of o.items as { name: string; qty: number; price: number }[]) {
      const key = item.name.split(' ')[0]; // 与产品名前缀匹配（含英文后缀的菜名）
      if (!weekly[key]) weekly[key] = { qty: 0, revenue: 0 };
      weekly[key].qty += item.qty;
      weekly[key].revenue += item.qty * item.price;
    }
  }

  const products = (data ?? []).map((p) => {
    const key = p.name.split(' ')[0];
    const w = weekly[key] ?? { qty: 0, revenue: 0 };
    return { ...p, week_qty: w.qty, week_revenue: Math.round(w.revenue * 100) / 100 };
  });

  const categories = Array.from(new Set(products.map((p) => p.category)));
  return NextResponse.json({ products, categories });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .insert({
      name: body.name,
      category: body.category ?? '招牌菜',
      price: body.price ?? 0,
      cost: body.cost ?? 0,
      stock: body.stock ?? 0,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      video_url: body.video_url ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ id: data.id });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ['name', 'category', 'price', 'cost', 'stock', 'status', 'description', 'image_url', 'video_url'] as const) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { error } = await supabase.from('products').update(update).eq('id', body.id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
