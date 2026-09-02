import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 员工管理：列表（含单人小费聚合）/ 新增或更新 / 删除
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, role, photo_url, is_active, created_at')
    .order('created_at');
  if (error) throw new Error(error.message);

  const { data: tipRows } = await supabase
    .from('orders')
    .select('tip_staff_id, tip')
    .not('tip_staff_id', 'is', null);
  const tipByStaff = new Map<string, number>();
  for (const r of (tipRows ?? []) as { tip_staff_id: string; tip: string | number }[]) {
    tipByStaff.set(r.tip_staff_id, (tipByStaff.get(r.tip_staff_id) ?? 0) + Number(r.tip ?? 0));
  }

  const staffList = (data ?? []).map((s) => ({
    ...s,
    tipTotal: Math.round((tipByStaff.get(s.id) ?? 0) * 100) / 100,
  }));
  return NextResponse.json({ staff: staffList });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const record = {
    name: String(body.name ?? '').trim(),
    role: body.role ? String(body.role).trim() : null,
    photo_url: body.photo_url ? String(body.photo_url) : null,
    is_active: body.is_active !== false,
  };
  if (!record.name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  if (body.id) {
    const { error } = await supabase.from('staff').update(record).eq('id', body.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('staff').insert(record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('staff').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}