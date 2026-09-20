import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { ensureWebOrderToken, getSiteForBusiness, normalizeSlug } from '@/lib/public-site';

/**
 * 商户后台的官网管理接口（需要登录）。
 *
 * 与公开面严格分离：
 *   /api/website/*  —— 本文件，会话鉴权 + 权限 + 审计
 *   /api/site/*     —— 公开（仅 authorize 与 reservations 两条，见 auth-guard）
 */

const MAX_SECTIONS = 8;
const MAX_SECTION_BODY = 4000;

export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    const site = await getSiteForBusiness(context.tenantId, context.businessId);
    return NextResponse.json({
      site,
      orderToken: site?.web_order_token ?? null,
    });
  } catch (e) {
    const status = e instanceof Error && e.name === 'AuthorizationError' ? 403 : 401;
    return NextResponse.json({ error: 'unauthorized' }, { status });
  }
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function updateSite(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'customization:write');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.slug !== undefined) {
    const slug = normalizeSlug(String(body.slug));
    if (!slug) {
      return NextResponse.json(
        { error: 'invalid slug: use 2-63 lowercase letters, digits or hyphens, and avoid reserved words' },
        { status: 400 },
      );
    }
    patch.slug = slug;
  }
  if (body.tagline !== undefined) patch.tagline = boundedString(body.tagline, 200);
  if (body.about !== undefined) patch.about = boundedString(body.about, 4000);

  if (body.sections !== undefined) {
    if (!Array.isArray(body.sections)) {
      return NextResponse.json({ error: 'sections must be an array' }, { status: 400 });
    }
    patch.sections = body.sections.slice(0, MAX_SECTIONS).map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        id: boundedString(row.id, 24) || boundedString(row.kind, 24),
        kind: boundedString(row.kind, 24),
        heading: boundedString(row.heading, 160),
        body: boundedString(row.body, MAX_SECTION_BODY),
      };
    });
  }
  if (body.theme !== undefined && typeof body.theme === 'object' && body.theme !== null) {
    patch.theme = body.theme;
  }
  if (body.seo !== undefined && typeof body.seo === 'object' && body.seo !== null) {
    patch.seo = body.seo;
  }
  if (body.contact !== undefined && typeof body.contact === 'object' && body.contact !== null) {
    patch.contact = body.contact;
  }

  if (body.custom_domain !== undefined) {
    const raw = boundedString(body.custom_domain, 253).toLowerCase().replace(/\.$/, '');
    if (!raw) {
      patch.custom_domain = null;
      patch.domain_status = 'none';
      patch.domain_error = null;
    } else if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) {
      return NextResponse.json({ error: 'invalid domain' }, { status: 400 });
    } else {
      patch.custom_domain = raw;
      // 只标记为"等待 DNS/签发"，绝不在这里直接写 active ——
      // active 是证书签发询问端点的放行依据，必须由真实签发结果驱动。
      patch.domain_status = 'pending_dns';
      patch.domain_error = null;
    }
  }

  const client = getSupabaseClient();
  const existing = await getSiteForBusiness(context.tenantId, context.businessId);

  if (!existing) {
    // 首次创建：slug 必填（后台页面会先调用生成，正常路径不会走到这里）。
    const slug = (patch.slug as string | undefined) ?? null;
    if (!slug) return NextResponse.json({ error: 'slug required to create the site' }, { status: 400 });
    const { data, error } = await client
      .from('public_sites')
      .insert({
        tenant_id: context.tenantId,
        business_id: context.businessId,
        ...patch,
        generated_by: 'manual',
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'that address is already taken' }, { status: 409 });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, id: (data as { id: string }).id });
  }

  if (body.enabled !== undefined) {
    const enabled = body.enabled === true;
    patch.enabled = enabled;
    if (enabled) {
      // 发布前置条件：必须先有可用的点单入口，否则官网上的"立即下单"是死链。
      const token = existing.web_order_token ?? await ensureWebOrderToken(context.tenantId, context.businessId);
      if (!token) {
        return NextResponse.json(
          { error: 'cannot publish: the online ordering link could not be prepared' },
          { status: 409 },
        );
      }
      patch.web_order_token = token;
      patch.published_at = existing.published_at ?? new Date().toISOString();
    }
  }

  const { error } = await client
    .from('public_sites')
    .update(patch)
    .eq('id', existing.id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'that address is already taken' }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: existing.id });
}

export const PATCH = protectBusinessMutation(
  { permission: 'customization:write', action: 'public_sites.update', entity: 'public_sites' },
  updateSite,
);
