import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 订单管理
export async function GET(request: NextRequest) {
  const supabase = getSupabaseClient();
  const status = request.nextUrl.searchParams.get('status');
  const table = request.nextUrl.searchParams.get('table');

  let q = supabase
    .from('orders')
    .select('id, order_no, customer_id, items, total, channel, status, source, external_id, table_no, notes, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (status && status !== 'all') q = q.eq('status', status);
  if (table === '_none') q = q.is('table_no', null);
  else if (table && table !== 'all') q = q.eq('table_no', table);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  // 有桌号的订单涉及的桌位列表（供筛选器）
  const { data: tableRows } = await supabase
    .from('orders')
    .select('table_no')
    .not('table_no', 'is', null);
  const tables = Array.from(new Set((tableRows ?? []).map((r) => r.table_no as string))).sort();

  // 客户名映射
  const customerIds = Array.from(new Set((data ?? []).map((o) => o.customer_id).filter(Boolean)));
  let nameMap: Record<string, string> = {};
  if (customerIds.length > 0) {
    const { data: custs } = await supabase.from('customers').select('id, name').in('id', customerIds);
    nameMap = Object.fromEntries((custs ?? []).map((c) => [c.id, c.name]));
  }

  const orders = (data ?? []).map((o) => ({ ...o, customer_name: o.customer_id ? (nameMap[o.customer_id] ?? null) : null }));
  return NextResponse.json({ orders, tables });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const allowed = ['pending', 'preparing', 'done', 'cancelled'];
  if (!allowed.includes(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('orders').update({ status: body.status }).eq('id', body.id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
