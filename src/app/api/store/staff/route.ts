import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublicStore } from '@/lib/storefront';

/** Public staff list for a valid table token only. */
export async function GET(request: NextRequest) {
  const store = await resolvePublicStore(request.nextUrl.searchParams.get('token'));
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });
  const { data, error } = await getSupabaseClient().from('staff').select('id, name, role, photo_url').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).eq('is_active', true).order('created_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ staff: data ?? [] });
}
