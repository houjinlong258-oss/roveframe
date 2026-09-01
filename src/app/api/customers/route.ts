import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET(request: NextRequest) {
  const supabase = getSupabaseClient();
  const id = request.nextUrl.searchParams.get('id');

  if (id) {
    const { data: customer, error } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    const { data: customerOrders, error: oErr } = await supabase
      .from('orders')
      .select('id, order_no, items, total, status, channel, created_at')
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (oErr) throw new Error(oErr.message);
    return NextResponse.json({ customer, orders: customerOrders ?? [] });
  }

  const { data: rows, error } = await supabase.from('customers').select('*').order('total_spent', { ascending: false });
  if (error) throw new Error(error.message);
  const list = rows ?? [];

  const now = Date.now();
  const monthAgo = new Date(now - 30 * 86400000).toISOString();
  const newThisMonth = list.filter((c) => c.created_at >= monthAgo).length;
  const highRisk = list.filter((c) => c.churn_risk === 'high').length;
  const totalSpent = list.reduce((s, c) => s + Number(c.total_spent), 0);
  const totalVisits = list.reduce((s, c) => s + c.visit_count, 0);

  return NextResponse.json({
    customers: list,
    stats: {
      total: list.length,
      newThisMonth,
      avgTicket: totalVisits > 0 ? Math.round((totalSpent / totalVisits) * 100) / 100 : 0,
      highRisk,
    },
  });
}
