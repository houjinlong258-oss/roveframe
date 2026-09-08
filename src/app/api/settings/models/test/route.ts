import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import { getCatalogEntry } from '@/lib/ai/provider-catalog';
import { testProviderConnection } from '@/lib/ai/connection-test';
import { writeAudit } from '@/lib/audit';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * POST /api/settings/models/test
 * 使用服务端已保存的密钥重新测试连接（密钥不从浏览器发送）。
 * 也支持在保存前用 body.apiKey 做一次性的预检（不持久化）。
 */
async function testModel(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const body = await request.json();
  const provider: string = body.provider;
  if (!provider || !getCatalogEntry(provider)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: rows } = await supabase
    .from('model_configs')
    .select('*')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .eq('provider', provider)
    .limit(1);
  const cfg = rows?.[0] as {
    api_key_encrypted: string | null;
    base_url: string | null;
    default_model: string | null;
    timeout_ms?: number | null;
    opt_in_local?: boolean | null;
  } | undefined;

  // 密钥来源：优先已保存密钥（服务端解密）；仅允许显式传入的一次性预检密钥
  let apiKey: string | null = null;
  if (cfg?.api_key_encrypted) {
    try {
      apiKey = decrypt(cfg.api_key_encrypted);
    } catch {
      apiKey = null;
    }
  }
  if (!apiKey && typeof body.apiKey === 'string' && body.apiKey.trim()) {
    apiKey = body.apiKey.trim();
  }
  if (!apiKey && getCatalogEntry(provider)?.authType === 'api_key') {
    return NextResponse.json({ error: 'no saved key; save a connection first' }, { status: 400 });
  }

  const result = await testProviderConnection({
    provider,
    apiKey,
    baseUrl: body.baseUrl ?? cfg?.base_url ?? null,
    model: body.model ?? cfg?.default_model ?? null,
    timeoutMs: cfg?.timeout_ms ?? undefined,
    allowLocal: Boolean(cfg?.opt_in_local) || getCatalogEntry(provider)?.category === 'local',
  });

  // 更新连接状态与模型缓存（best-effort；列不存在时忽略）
  if (cfg) {
    try {
      await supabase
        .from('model_configs')
        .update({
          last_test_ok: result.ok,
          last_tested_at: new Date().toISOString(),
          last_test_error: result.error,
          ...(result.models ? { models_cache: result.models, models_updated_at: new Date().toISOString() } : {}),
        })
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .eq('provider', provider);
    } catch {
      // 旧表缺列时不阻断测试结果返回
    }
  }

  await writeAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: result.ok ? 'ai_provider.test_ok' : 'ai_provider.test_failed',
    entity: 'model_config',
    entityId: provider,
    after: { ok: result.ok, latencyMs: result.latencyMs, error: result.error ?? undefined },
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export const POST = protectBusinessMutation(
  { permission: 'settings:write', action: 'models.test', entity: 'model_configs' },
  testModel,
);
