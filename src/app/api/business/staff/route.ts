import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { deleteWithScope, insertWithScope, scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 员工管理：列表（含单人小费聚合）/ 新增或更新 / 删除
// （P0-S2 完整版：tenant 过滤 + tenant_id 注入）
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await scopedTable(ctx, 'staff', 'id, name, role, photo_url, is_active, created_at')
    .order('created_at');
  if (error) throw new Error(error.message);

  const tipRowsRes = await scopedTable(ctx, 'orders', 'tip_staff_id, tip')
    .not('tip_staff_id', 'is', null);
  const tipByStaff = new Map<string, number>();
  for (const r of (tipRowsRes.data ?? []) as { tip_staff_id: string; tip: string | number }[]) {
    tipByStaff.set(r.tip_staff_id, (tipByStaff.get(r.tip_staff_id) ?? 0) + Number(r.tip ?? 0));
  }

  const staffList = ((data ?? []) as { id: string; [k: string]: unknown }[]).map((s) => ({
    ...s,
    tipTotal: Math.round((tipByStaff.get(s.id) ?? 0) * 100) / 100,
  }));
  return NextResponse.json({ staff: staffList });
}

async function upsertStaff(request: NextRequest) {
  const body = await request.json();
  const ctx = requireBusinessContext(await getTenantContext(request));
  const record: Record<string, unknown> = {
    name: String(body.name ?? '').trim(),
    role: body.role ? String(body.role).trim() : null,
    photo_url: body.photo_url ? String(body.photo_url) : null,
    is_active: body.is_active !== false,
  };
  if (!record.name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  if (body.id) {
    const { error } = await updateWithScope(ctx, 'staff', body.id, record);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await insertWithScope(ctx, 'staff', record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

async function deleteStaff(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { error } = await deleteWithScope(ctx, 'staff', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'staff:write', action: 'staff.upsert', entity: 'staff' },
  upsertStaff,
);
export const DELETE = protectBusinessMutation(
  { permission: 'staff:delete', action: 'staff.delete', entity: 'staff' },
  deleteStaff,
);
