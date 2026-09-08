import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublicStore } from '@/lib/storefront';

/** Public menu, scoped exclusively by an opaque active QR token. */
export async function GET(request: NextRequest) {
  const store = await resolvePublicStore(request.nextUrl.searchParams.get('token'));
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });
  const supabase = getSupabaseClient();
  const [{ data: settingsRow }, { data: products, error }] = await Promise.all([
    supabase.from('settings').select('business, locale').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).maybeSingle(),
    supabase.from('products').select('id, name, category, price, description, image_url, video_url, sales_count').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).eq('status', 'active').order('sales_count', { ascending: false }),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { error: scanError } = await supabase.rpc('increment_store_qr_scan', { qr_code_id: store.qrCodeId });
  if (scanError) console.warn('[store/menu] scan counter update failed:', scanError.message);
  const list = products ?? [];
  const business = (settingsRow?.business ?? {}) as Record<string, string>;
  const locale = (settingsRow?.locale ?? {}) as Record<string, string>;
  return NextResponse.json({
    store: { name: business.name ?? 'Store', intro: business.intro ?? '', hours: business.hours ?? '', currency: locale.currency ?? 'USD' },
    table: store.tableNo,
    categories: Array.from(new Set(list.map((product) => product.category))),
    products: list,
  });
}
