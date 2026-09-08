import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext } from '@/lib/tenant';
import { writeAudit } from '@/lib/audit';
import { onboardingDraftSchema, onboardingIdempotencyKey } from '@/lib/onboarding/parse';
import { protectTenantMutation } from '@/lib/mutation-guard';

/**
 * POST /api/onboarding/confirm
 * 用户确认草稿后创建/补全工作区：business profile、Agent 初始配置、
 * 知识库占位。幂等：同一租户 + 同一规范化业务名重复提交返回既有记录，
 * 不产生重复 workspace。
 *
 * 只创建内部占位记录；不连接 POS、不发邮件、不做外部写操作。
 */
async function confirmOnboarding(request: Request) {
  const ctx = await getTenantContext(request);
  const body = await request.json().catch(() => ({}));
  const parsed = onboardingDraftSchema.safeParse(body.draft);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid draft', issues: parsed.error.issues }, { status: 400 });
  }
  const draft = parsed.data;
  const idemKey = onboardingIdempotencyKey(ctx.tenantId, draft.businessName);

  const client = getSupabaseClient();

  // 幂等检查：同租户同名 business 已存在 → 直接返回
  const { data: existing } = await client
    .from('businesses')
    .select('id, name, industry')
    .eq('tenant_id', ctx.tenantId)
    .ilike('name', draft.businessName.trim())
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, idempotent: true, businessId: existing.id, idempotencyKey: idemKey });
  }

  // 创建 business（沿用现有表结构，行业/地点写入 profile 字段）
  const { data: business, error } = await client
    .from('businesses')
    .insert({
      tenant_id: ctx.tenantId,
      name: draft.businessName.trim(),
      industry: draft.industry,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  // 每个新 business 拥有独立设置；不得复用同租户其他门店的配置。
  const mergedBusiness = {
    location: draft.location ?? undefined,
    timezone: draft.timezone ?? undefined,
    currency: draft.currency ?? undefined,
    language: draft.language,
    goals: draft.goals,
    posSystem: draft.posSystem,
    onboardingCompletedAt: new Date().toISOString(),
    onboardingIdempotencyKey: idemKey,
  };
  const { error: settingsError } = await client.from('settings').insert({
    tenant_id: ctx.tenantId,
    business_id: business.id,
    business: mergedBusiness,
  });
  if (settingsError) throw new Error(settingsError.message);

  // 知识库占位文档（让用户首日就有可编辑入口；不含编造内容）
  await client.from('knowledge_docs').insert({
    tenant_id: ctx.tenantId,
    business_id: business.id,
    title: `${draft.businessName} — 经营知识库（待补充）`,
    content: '',
    status: 'draft',
  }).select('id').maybeSingle();

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: 'onboarding.workspace_created',
    entity: 'business',
    entityId: business.id,
    after: {
      name: draft.businessName,
      industry: draft.industry,
      location: draft.location,
      posSystem: draft.posSystem,
      idempotencyKey: idemKey,
    },
  });

  return NextResponse.json({ ok: true, idempotent: false, businessId: business.id, idempotencyKey: idemKey }, { status: 201 });
}

export const POST = protectTenantMutation(
  { permission: 'settings:write', action: 'onboarding.confirm', entity: 'businesses' },
  confirmOnboarding,
);
