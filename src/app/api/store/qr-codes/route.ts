import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 点餐二维码管理（一桌一码，商家可备注）
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('store_qr_codes')
    .select('id, table_no, remark, is_active, scan_count, created_at')
    .order('table_no', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ codes: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const tableNo = String(body.table_no ?? '').trim();
  const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 128) : '';
  if (!/^[A-Za-z0-9-]{1,10}$/.test(tableNo)) {
    return NextResponse.json({ error: 'Invalid table number' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('store_qr_codes')
    .upsert(
      { table_no: tableNo, remark, is_active: true, updated_at: new Date().toISOString() },
      { onConflict: 'table_no' }
    )
    .select('id, table_no, remark, is_active, scan_count, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ code: data });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.remark !== undefined) update.remark = String(body.remark).slice(0, 128);
  if (body.is_active !== undefined) update.is_active = Boolean(body.is_active);

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('store_qr_codes').update(update).eq('id', body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('store_qr_codes').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
