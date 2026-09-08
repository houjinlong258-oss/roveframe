import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import {
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { errorResponse } from '@/lib/api-helpers';
import { getSettings } from '@/lib/settings';
import {
  businessDayRange,
  localDateInTimeZone,
  resolveBusinessTimeZone,
} from '@/lib/time';

export async function GET(request: NextRequest) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    // P0-4：读接口 RBAC —— staff 无 reservations:read（电话/备注含 PII）。
    requirePermission(ctx, 'reservations:read');
    // P0-8：按业务时区取本地零点切日（进程时区不参与口径）
    const settings = await getSettings(ctx.tenantId, ctx.businessId);
    const timeZone = resolveBusinessTimeZone(settings.locale?.timezone);
    const localToday = localDateInTimeZone(new Date(), timeZone);
    const date = request.nextUrl.searchParams.get('date') ?? localToday;
    const { start, end } = businessDayRange(date, timeZone);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const listRes = await scopedTable(ctx, 'reservations')
      .gte('reserved_at', startIso)
      .lt('reserved_at', endIso)
      .order('reserved_at', { ascending: true });
    if (listRes.error) throw new Error(listRes.error.message);
    const list = (listRes.data ?? []) as { status: string; [k: string]: unknown }[];

    // 本周取消率（自然周起点：业务时区本周日零点）
    const weekStart = new Date(start.getTime() - start.getUTCDay() * 86_400_000);
    const weekRes = await scopedTable(ctx, 'reservations', 'status')
      .gte('reserved_at', weekStart.toISOString());
    if (weekRes.error) throw new Error(weekRes.error.message);
    const week = (weekRes.data ?? []) as { status: string }[];
    const cancelRate = week.length > 0 ? Math.round((week.filter((r) => r.status === 'cancelled').length / week.length) * 100) : 0;

    // 未来 6 天每日占用（业务时区切日）
    const occupancy: { date: string; count: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(start.getTime() + i * 86_400_000);
      const ds = localDateInTimeZone(dayStart, timeZone);
      const { start: s2, end: e2 } = businessDayRange(ds, timeZone);
      const dayRes = await scopedTable(ctx, 'reservations', 'id')
        .gte('reserved_at', s2.toISOString())
        .lt('reserved_at', e2.toISOString())
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
  } catch (error) {
    return errorResponse(error);
  }
}

async function createReservation(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const body = await request.json();
  const { data, error } = await insertWithScope(ctx, 'reservations', {
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

async function updateReservation(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.table_no !== undefined) update.table_no = body.table_no;
  const { error } = await updateWithScope(ctx, 'reservations', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'reservations:write', action: 'reservations.create', entity: 'reservations' },
  createReservation,
);
export const PATCH = protectBusinessMutation(
  { permission: 'reservations:write', action: 'reservations.update', entity: 'reservations' },
  updateReservation,
);
