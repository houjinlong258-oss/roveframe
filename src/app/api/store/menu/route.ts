import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 店铺菜单公开 API —— 商家在后台维护商品（名称/价格/图片/视频）后，
// 此接口自动对外提供最新菜单，可供任意前端展示页面或 H5 商城直接对接。
export async function GET(request: NextRequest) {
  const supabase = getSupabaseClient();
  const table = request.nextUrl.searchParams.get('table');

  const [{ data: settingsRow }, { data: products, error }] = await Promise.all([
    supabase.from('settings').select('business, locale').limit(1).maybeSingle(),
    supabase
      .from('products')
      .select('id, name, category, price, description, image_url, video_url, sales_count')
      .eq('status', 'active')
      .order('sales_count', { ascending: false }),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 桌码扫码统计（有匹配桌码时累加，失败不影响菜单返回）
  if (table) {
    try {
      const { data: qr } = await supabase
        .from('store_qr_codes')
        .select('id, scan_count')
        .eq('table_no', table)
        .eq('is_active', true)
        .maybeSingle();
      if (qr) {
        await supabase
          .from('store_qr_codes')
          .update({ scan_count: (qr.scan_count ?? 0) + 1 })
          .eq('id', qr.id);
      }
    } catch {
      // 统计失败不影响菜单
    }
  }

  const list = products ?? [];
  const categories = Array.from(new Set(list.map((p) => p.category)));
  const business = (settingsRow?.business ?? {}) as Record<string, string>;
  const locale = (settingsRow?.locale ?? {}) as Record<string, string>;

  return NextResponse.json({
    store: {
      name: business.name ?? 'Store',
      intro: business.intro ?? '',
      hours: business.hours ?? '',
      currency: locale.currency ?? 'USD',
    },
    table: table ?? null,
    categories,
    products: list,
  });
}
