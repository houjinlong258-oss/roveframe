import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import {
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 产品管理（P0-S2 完整版：tenant 过滤 + tenant_id 注入）
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await scopedTable(ctx, 'products')
    .order('sales_count', { ascending: false });
  if (error) throw new Error(error.message);

  // 本周销量/营收（近 7 天订单明细聚合）
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: weekOrders, error: oErr } = await scopedTable(ctx, 'orders', 'items')
    .gte('created_at', weekAgo)
    .neq('status', 'cancelled');
  if (oErr) throw new Error(oErr.message);

  const weekly: Record<string, { qty: number; revenue: number }> = {};
  for (const o of weekOrders ?? []) {
    const items = (o as { items: { name: string; qty: number; price: number }[] }).items;
    for (const item of items) {
      const key = item.name.split(' ')[0];
      if (!weekly[key]) weekly[key] = { qty: 0, revenue: 0 };
      weekly[key].qty += item.qty;
      weekly[key].revenue += item.qty * item.price;
    }
  }

  const products = (data ?? []).map((p) => {
    const product = p as { name: string; category: string };
    const key = product.name.split(' ')[0];
    const w = weekly[key] ?? { qty: 0, revenue: 0 };
    return { ...product, week_qty: w.qty, week_revenue: Math.round(w.revenue * 100) / 100 };
  });

  const categories = Array.from(new Set(products.map((p) => p.category)));
  return NextResponse.json({ products, categories });
}

async function createProduct(request: NextRequest) {
  const body = await request.json();
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await insertWithScope(ctx, 'products', {
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
  return NextResponse.json({ id: (data as { id: string }).id });
}

async function updateProduct(request: NextRequest) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ctx = requireBusinessContext(await getTenantContext(request));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of [
    'name',
    'category',
    'price',
    'cost',
    'stock',
    'status',
    'description',
    'image_url',
    'video_url',
  ] as const) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { error } = await updateWithScope(ctx, 'products', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'products:write', action: 'products.create', entity: 'products' },
  createProduct,
);
export const PATCH = protectBusinessMutation(
  { permission: 'products:write', action: 'products.update', entity: 'products' },
  updateProduct,
);
