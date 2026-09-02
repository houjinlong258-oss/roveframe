import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import { tenantTable } from '@/lib/tenant-db';

export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const id = request.nextUrl.searchParams.get('id');

  if (id) {
    const customerRes = await tenantTable(ctx.tenantId, 'customers').eq('id', id).maybeSingle();
    if (customerRes.error) throw new Error(customerRes.error.message);
    const customer = customerRes.data as Record<string, unknown> | null;
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    const ordersRes = await tenantTable(
      ctx.tenantId,
      'orders',
      'id, order_no, items, total, status, channel, created_at',
    )
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (ordersRes.error) throw new Error(ordersRes.error.message);
    return NextResponse.json({ customer, orders: ordersRes.data ?? [] });
  }

  const rowsRes = await tenantTable(ctx.tenantId, 'customers')
    .order('total_spent', { ascending: false });
  if (rowsRes.error) throw new Error(rowsRes.error.message);
  const list = (rowsRes.data ?? []) as { created_at: string; churn_risk: string; total_spent: string; visit_count: number }[];

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
