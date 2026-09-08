import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 点餐二维码管理（一桌一码，商家可备注）
export async function GET(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('store_qr_codes')
    .select('id, table_no, public_token, remark, is_active, scan_count, created_at')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .order('table_no', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ codes: data ?? [] });
}

async function createQrCode(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'products:write');
  const body = await request.json();
  const tableNo = String(body.table_no ?? '').trim();
  const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 128) : '';
  if (!/^[A-Za-z0-9-]{1,10}$/.test(tableNo)) {
    return NextResponse.json({ error: 'Invalid table number' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('store_qr_codes')
    .upsert({
      tenant_id: context.tenantId,
      business_id: context.businessId,
      table_no: tableNo,
      remark,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,business_id,table_no' })
    .select('id, table_no, public_token, remark, is_active, scan_count, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ code: data });
}

async function updateQrCode(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'products:write');
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.remark !== undefined) update.remark = String(body.remark).slice(0, 128);
  if (body.is_active !== undefined) update.is_active = Boolean(body.is_active);

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('store_qr_codes').update(update).eq('id', body.id).eq('tenant_id', context.tenantId).eq('business_id', context.businessId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function deleteQrCode(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'products:write');
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('store_qr_codes').delete().eq('id', id).eq('tenant_id', context.tenantId).eq('business_id', context.businessId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'products:write', action: 'store_qr_codes.create', entity: 'store_qr_codes' },
  createQrCode,
);
export const PATCH = protectBusinessMutation(
  { permission: 'products:write', action: 'store_qr_codes.update', entity: 'store_qr_codes' },
  updateQrCode,
);
export const DELETE = protectBusinessMutation(
  { permission: 'products:write', action: 'store_qr_codes.delete', entity: 'store_qr_codes' },
  deleteQrCode,
);
