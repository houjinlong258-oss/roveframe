import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublishedSiteBySlug, normalizeSlug } from '@/lib/public-site';
import { normalizeDeliveryRules } from '@/lib/delivery';

/**
 * 顾客端 PWA 的商家级配置（公开，按 slug）。
 *
 * 前端用它决定四个模式里显示哪些 tab、配送门槛与配送费怎么显示。
 * 放在**一个**接口里而不是让前端并发打四个：模式可见性、配送规则、主题
 * 三者必须来自同一份读取，否则会出现"外卖 tab 显示出来了但规则没拿到"的中间态。
 *
 * 只暴露渲染必需的字段。tenant_id / business_id / 内部状态一律不出现在响应里。
 */
export async function GET(request: NextRequest) {
  const slugParam = request.nextUrl.searchParams.get('slug') ?? '';
  const slug = normalizeSlug(slugParam);
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const { data: settingsRow, error } = await getSupabaseClient()
    .from('settings')
    .select('business, locale, delivery')
    .eq('tenant_id', site.tenant_id)
    .eq('business_id', site.business_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'configuration unavailable' }, { status: 500 });

  const business = ((settingsRow?.business ?? {}) as Record<string, string>);
  const locale = ((settingsRow?.locale ?? {}) as Record<string, string>);
  const rules = normalizeDeliveryRules(settingsRow?.delivery);

  // 堂食入口依赖商家存在一个可用的桌码；没有桌码就不显示堂食 tab，
  // 而不是让顾客点进去拿到 404。
  const { data: webToken } = await getSupabaseClient()
    .from('store_qr_codes')
    .select('public_token')
    .eq('tenant_id', site.tenant_id)
    .eq('business_id', site.business_id)
    .eq('table_no', 'WEB')
    .eq('is_active', true)
    .maybeSingle();

  return NextResponse.json({
    store: {
      name: business.name ?? site.seo.title ?? site.slug,
      intro: business.intro ?? '',
      hours: business.hours ?? site.contact.hours ?? '',
      currency: locale.currency ?? 'USD',
    },
    modes: {
      dine_in: Boolean(webToken?.public_token) || Boolean(site.web_order_token),
      delivery: rules.enabled,
      booking: true,
      menu: true,
    },
    delivery: {
      minOrderAmount: rules.minOrderAmount,
      fee: rules.fee,
      freeDeliveryAbove: rules.freeDeliveryAbove,
      prepMinutes: rules.prepMinutes,
    },
    theme: site.theme,
    orderToken: site.web_order_token ?? (webToken?.public_token as string | undefined) ?? null,
  });
}
