import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublicStore } from '@/lib/storefront';

/**
 * Public menu, scoped exclusively by an opaque active QR token.
 *
 * Phase 16 任务 3：门店名不再回落成字面量 "Store"。
 *
 * 原实现读 `settings.business.name`，拿不到就写 `'Store'` —— 而注册流程当时
 * **不建 settings 行**，于是每个新商家的顾客菜单上店名都是 "Store"。
 * 一个假店名比一个空值更糟：顾客看到的是一个不存在的品牌。
 *
 * 现在：
 *   - 注册时建 settings 行（`/api/auth/signup` 第 6 步），`business.name` 有真值；
 *   - settings 行缺失（老数据/迁移异常）⇒ 明确 409，而不是编一个名字。
 *     这里是公开接口，错误文案不泄漏内部结构，只说明店铺资料未配置。
 */
export async function GET(request: NextRequest) {
  const store = await resolvePublicStore(request.nextUrl.searchParams.get('token'));
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });
  const supabase = getSupabaseClient();
  const [{ data: settingsRow }, { data: products, error }] = await Promise.all([
    supabase.from('settings').select('business, locale').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).maybeSingle(),
    supabase.from('products').select('id, name, category, price, description, image_url, video_url, sales_count').eq('tenant_id', store.tenantId).eq('business_id', store.businessId).eq('status', 'active').order('sales_count', { ascending: false }),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!settingsRow) {
    console.warn(
      `[store/menu] settings row missing for tenant=${store.tenantId} business=${store.businessId}; ` +
      '店铺资料未配置，拒绝用占位店名响应',
    );
    return NextResponse.json(
      { error: 'Store profile is not configured yet', code: 'store_profile_missing' },
      { status: 409 },
    );
  }
  const { error: scanError } = await supabase.rpc('increment_store_qr_scan', { qr_code_id: store.qrCodeId });
  if (scanError) console.warn('[store/menu] scan counter update failed:', scanError.message);
  const list = products ?? [];
  const business = (settingsRow.business ?? {}) as Record<string, string>;
  const locale = (settingsRow.locale ?? {}) as Record<string, string>;
  return NextResponse.json({
    store: {
      name: business.name ?? null,
      intro: business.intro ?? '',
      hours: business.hours ?? '',
      currency: locale.currency ?? 'USD',
    },
    table: store.tableNo,
    categories: Array.from(new Set(list.map((product) => product.category))),
    products: list,
  });
}
