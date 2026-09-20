import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { allocateSlug, getSiteForBusiness, slugify, ensureWebOrderToken } from '@/lib/public-site';
import { getForwardHeaders } from '@/lib/api-helpers';
import { generateSiteDraft } from '@/lib/site/generator';

/**
 * "让 AI 按我的店铺信息做一份官网"。
 *
 * 写入的永远是**草稿**：`enabled` 保持 false，商家在 /website 里预览、改文案、
 * 再显式发布。理由很实际 —— 模型输出直接对外，等于把没有人工过目的文案
 * 挂在商家的品牌上。
 *
 * 同理，模型给的电话/地址/邮箱在 src/lib/site/generator.ts 里会被**数据库值
 * 覆盖**：文案可以润色，联系方式不可以被改写。
 */

async function generate(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'customization:write');

  const body = await request.json().catch(() => ({})) as { locale?: unknown };
  const locale = typeof body.locale === 'string' && /^[a-z]{2}$/.test(body.locale) ? body.locale : 'en';

  const existing = await getSiteForBusiness(context.tenantId, context.businessId);
  const client = getSupabaseClient();

  let slug = existing?.slug ?? null;
  if (!slug) {
    const { data: business } = await client
      .from('businesses')
      .select('name')
      .eq('tenant_id', context.tenantId)
      .eq('id', context.businessId)
      .maybeSingle();
    const name = String((business as { name?: string } | null)?.name ?? 'store');
    slug = await allocateSlug(slugify(name), context.tenantId);
    if (!slug) {
      return NextResponse.json({ error: 'could not allocate a public address' }, { status: 500 });
    }
  }

  const result = await generateSiteDraft({
    tenantId: context.tenantId,
    businessId: context.businessId,
    locale,
    forwardHeaders: getForwardHeaders(request),
  });
  if (!result.ok) {
    // 明确区分"模型没配好"与"模型答得不合格式"：前者商家要去设置里加 Key，
    // 后者重试一次可能就好。原样返回，不吞成一句笼统的失败。
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const token = await ensureWebOrderToken(context.tenantId, context.businessId);
  const now = new Date().toISOString();
  const draft = result.draft;

  const row = {
    tenant_id: context.tenantId,
    business_id: context.businessId,
    slug,
    tagline: draft.tagline,
    about: draft.about,
    sections: draft.sections,
    theme: draft.theme,
    seo: draft.seo,
    contact: draft.contact,
    web_order_token: token,
    generated_by: 'agent',
    generated_at: now,
    updated_at: now,
  };

  if (!existing) {
    const { data, error } = await client
      .from('public_sites')
      .insert({ ...row, enabled: false })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'that address is already taken' }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      created: true,
      id: (data as { id: string }).id,
      orderTokenReady: Boolean(token),
    });
  }

  const { error } = await client
    .from('public_sites')
    .update(row)
    .eq('id', existing.id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, created: false, id: existing.id, orderTokenReady: Boolean(token) });
}

export const POST = protectBusinessMutation(
  { permission: 'customization:write', action: 'public_sites.generate', entity: 'public_sites' },
  generate,
);
