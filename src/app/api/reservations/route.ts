import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import {
  insertWithTenant,
  tenantTable,
  updateWithTenant,
} from '@/lib/tenant-db';

function dayRange(dateStr: string): { start: string; end: string } {
  // 按服务器本地时区解释自然日
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const date = request.nextUrl.searchParams.get('date') ?? localToday;
  const { start, end } = dayRange(date);

  const listRes = await tenantTable(ctx.tenantId, 'reservations')
    .gte('reserved_at', start)
    .lt('reserved_at', end)
    .order('reserved_at', { ascending: true });
  if (listRes.error) throw new Error(listRes.error.message);
  const list = (listRes.data ?? []) as { status: string; [k: string]: unknown }[];

  // 本周取消率
  const weekStart = new Date(start);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const weekRes = await tenantTable(ctx.tenantId, 'reservations', 'status')
    .gte('reserved_at', weekStart.toISOString());
  if (weekRes.error) throw new Error(weekRes.error.message);
  const week = (weekRes.data ?? []) as { status: string }[];
  const cancelRate = week.length > 0 ? Math.round((week.filter((r) => r.status === 'cancelled').length / week.length) * 100) : 0;

  // 未来 6 天每日占用
  const occupancy: { date: string; count: number }[] = [];
  const startMs = new Date(start).getTime();
  for (let i = 0; i < 7; i++) {
    const d = new Date(startMs + i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    const { start: s2, end: e2 } = dayRange(ds);
    const dayRes = await tenantTable(ctx.tenantId, 'reservations', 'id')
      .gte('reserved_at', s2)
      .lt('reserved_at', e2)
      .neq('status', 'cancelled');
    occupancy.push({ date: ds, count: (dayRes.data ?? []).length });
  }

  return NextResponse.json({
    reservations: list,
    stats: {
      today: list.filter((r) => r.status !== 'cancelled').length,
      pending: list.filter((r) => r.status === 'pending').length,
      arrived: list.filter((r) => r.status === 'arrived').length,
      cancelRate,
    },
    occupancy,
  });
}

export async function POST(request: NextRequest) {
  const ctx = getTenantContext(request);
  const body = await request.json();
  const { data, error } = await insertWithTenant(ctx.tenantId, 'reservations', {
    customer_name: body.customer_name,
    phone: body.phone,
    party_size: body.party_size ?? 2,
    table_no: body.table_no ?? null,
    reserved_at: body.reserved_at,
    source: body.source ?? 'phone',
    notes: body.notes ?? null,
    status: 'pending',
  })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ id: (data as { id: string }).id });
}

export async function PATCH(request: NextRequest) {
  const ctx = getTenantContext(request);
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.table_no !== undefined) update.table_no = body.table_no;
  const { error } = await updateWithTenant(ctx.tenantId, 'reservations', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
