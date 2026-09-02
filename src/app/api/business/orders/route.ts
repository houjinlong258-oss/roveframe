import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import { tenantTable, updateWithTenant } from '@/lib/tenant-db';

// 订单管理（P0-S2 完整版：tenant 过滤 + tenant_id 注入）
export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const status = request.nextUrl.searchParams.get('status');
  const table = request.nextUrl.searchParams.get('table');

  const ordersQ = tenantTable(
    ctx.tenantId,
    'orders',
    'id, order_no, customer_id, items, total, tip, tip_percent, channel, status, source, external_id, table_no, notes, created_at',
  ).order('created_at', { ascending: false }).limit(100);
  // 链式 .eq / .is 在 FilterBuilder 上
  // 注意：FilterBuilder 的 .order/.limit 返回值，调用时按 type 收敛
  const chained = (() => {
    if (status && status !== 'all') {
      return (ordersQ as unknown as { eq: (c: string, v: unknown) => typeof ordersQ }).eq('status', status);
    }
    return ordersQ;
  })();
  const chained2 = (() => {
    if (table === '_none') {
      return (chained as unknown as { is: (c: string, v: unknown) => typeof chained }).is('table_no', null);
    }
    if (table && table !== 'all') {
      return (chained as unknown as { eq: (c: string, v: unknown) => typeof chained }).eq('table_no', table);
    }
    return chained;
  })();
  const { data, error } = await chained2;
  if (error) throw new Error(error.message);

  // 有桌号的订单涉及的桌位列表（供筛选器）
  const tableRowsRes = await tenantTable(ctx.tenantId, 'orders', 'table_no').not('table_no', 'is', null);
  const tables = Array.from(
    new Set(((tableRowsRes.data ?? []) as { table_no: string | null }[]).map((r) => r.table_no as string)),
  ).sort();

  // 客户名映射
  const customerIds = Array.from(
    new Set(((data ?? []) as { customer_id: string | null }[]).map((o) => o.customer_id).filter(Boolean) as string[]),
  );
  let nameMap: Record<string, string> = {};
  if (customerIds.length > 0) {
    const custsRes = await tenantTable(ctx.tenantId, 'customers', 'id, name').in('id', customerIds);
    nameMap = Object.fromEntries(
      ((custsRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
    );
  }

  const orders = ((data ?? []) as { customer_id: string | null; [k: string]: unknown }[]).map((o) => ({
    ...o,
    customer_name: o.customer_id ? (nameMap[o.customer_id] ?? null) : null,
  }));

  // 小费统计（今日 / 本周，排除已取消）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  const tipRowsRes = await tenantTable(ctx.tenantId, 'orders', 'tip, table_no, created_at')
    .gte('created_at', weekStart.toISOString())
    .neq('status', 'cancelled');
  const tipList = (tipRowsRes.data ?? []) as { tip: string | number; table_no: string | null; created_at: string }[];
  const todayTip =
    Math.round(
      tipList.filter((r) => r.created_at >= todayStart.toISOString()).reduce((s, r) => s + Number(r.tip ?? 0), 0) * 100,
    ) / 100;
  const weekTip = Math.round(tipList.reduce((s, r) => s + Number(r.tip ?? 0), 0) * 100) / 100;

  // 按桌位归因（本周）
  const byTable = new Map<string, number>();
  for (const r of tipList) {
    if (r.table_no) byTable.set(r.table_no, (byTable.get(r.table_no) ?? 0) + Number(r.tip ?? 0));
  }
  const tipByTable = Array.from(byTable.entries())
    .map(([table_no, tip]) => ({ table_no, tip: Math.round(tip * 100) / 100 }))
    .sort((a, b) => b.tip - a.tip)
    .slice(0, 8);

  return NextResponse.json({ orders, tables, tipStats: { todayTip, weekTip, tipByTable } });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const allowed = ['pending', 'preparing', 'done', 'cancelled'];
  if (!allowed.includes(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }
  const ctx = getTenantContext(request);
  const { error } = await updateWithTenant(ctx.tenantId, 'orders', body.id, { status: body.status });
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
