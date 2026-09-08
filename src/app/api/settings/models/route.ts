import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt, decrypt, mask } from '@/lib/crypto';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';
import { PROVIDER_CATALOG, getCatalogEntry, catalogSummary } from '@/lib/ai/provider-catalog';
import { checkBaseUrl } from '@/lib/ai/url-utils';
import { writeAudit } from '@/lib/audit';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * Settings → AI Providers：Provider 连接管理。
 *
 * 安全契约：
 * - API Key 只在输入时提交一次；GET 永远只返回掩码值。
 * - 修改 model/base URL/超时等不要求重发密钥（body.apiKey 缺省时保留已存密钥）。
 * - 所有写操作写脱敏审计摘要。
 */

interface ModelConfigRow {
  id: string;
  provider: string;
  api_key_encrypted: string | null;
  base_url: string | null;
  default_model: string | null;
  is_enabled: boolean;
  last_test_ok: boolean | null;
  last_tested_at: string | null;
  display_name?: string | null;
  timeout_ms?: number | null;
  max_retries?: number | null;
  last_test_error?: string | null;
  models_cache?: string[] | null;
  models_updated_at?: string | null;
  opt_in_local?: boolean | null;
  tenant_id: string;
  business_id: string;
}

function toConnectionView(row: ModelConfigRow) {
  let plain = '';
  if (row.api_key_encrypted) {
    try {
      plain = decrypt(row.api_key_encrypted);
    } catch {
      plain = '';
    }
  }
  return {
    maskedKey: mask(plain),
    hasKey: Boolean(plain),
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    isEnabled: row.is_enabled,
    lastTestOk: row.last_test_ok,
    lastTestedAt: row.last_tested_at,
    lastTestError: row.last_test_error ?? null, // 写入时已脱敏
    displayName: row.display_name ?? null,
    timeoutMs: row.timeout_ms ?? null,
    maxRetries: row.max_retries ?? null,
    modelsCache: row.models_cache ?? null,
    modelsUpdatedAt: row.models_updated_at ?? null,
    optInLocal: row.opt_in_local ?? false,
  };
}

export async function GET(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:read');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('model_configs')
    .select('*')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
  if (error) throw new Error(error.message);

  const byProvider = new Map<string, ReturnType<typeof toConnectionView>>();
  for (const row of (data ?? []) as ModelConfigRow[]) {
    byProvider.set(row.provider, toConnectionView(row));
  }

  // 以 Catalog 为唯一 Provider Universe；旧预设中不在 Catalog 的 id 做别名归并
  const alias: Record<string, string> = { claude: 'anthropic', kimi: 'moonshot_cn' };
  const connections = PROVIDER_CATALOG.map((entry) => {
    const stored = byProvider.get(entry.id) ?? byProvider.get(
      Object.keys(alias).find((k) => alias[k] === entry.id) ?? '',
    );
    return {
      id: entry.id,
      displayName: entry.displayName,
      category: entry.category,
      protocol: entry.protocol,
      authType: entry.authType,
      runtime: entry.runtime,
      modelDiscovery: entry.modelDiscovery,
      keyHint: entry.keyHint,
      defaultBaseUrl: entry.defaultBaseUrl,
      catalogModels: entry.models,
      capabilities: {
        streaming: entry.supportsStreaming,
        tools: entry.supportsTools,
        vision: entry.supportsVision,
        embeddings: entry.supportsEmbeddings,
        reasoning: entry.supportsReasoning,
      },
      connection: stored ?? null,
    };
  });

  return NextResponse.json({
    connections,
    catalog: catalogSummary(),
    legacyPresets: Object.keys(PROVIDER_PRESETS),
  });
}

async function saveModel(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const body = await request.json();
  const provider: string = body.provider;
  const entry = getCatalogEntry(provider);
  const legacyPreset = PROVIDER_PRESETS[provider];
  if (!entry && !legacyPreset) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }

  const allowLocal = Boolean(body.optInLocal) || entry?.category === 'local';
  const baseUrl: string | null = body.baseUrl ?? entry?.defaultBaseUrl ?? legacyPreset?.baseUrl ?? null;
  if (baseUrl) {
    const check = checkBaseUrl(baseUrl, { allowLocal });
    if (!check.ok) {
      await writeAudit({
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'ai_provider.rejected',
        entity: 'model_config',
        entityId: provider,
        after: { reason: check.reason },
      });
      return NextResponse.json({ error: `base URL 未通过安全校验: ${check.reason}` }, { status: 400 });
    }
  }

  const supabase = getSupabaseClient();
  const record: Record<string, unknown> = {
    provider,
    base_url: baseUrl,
    default_model: body.defaultModel ?? entry?.models[0]?.id ?? legacyPreset?.models[0] ?? null,
    is_enabled: body.isEnabled ?? true,
    display_name: body.displayName ?? null,
    timeout_ms: typeof body.timeoutMs === 'number' ? Math.min(Math.max(body.timeoutMs, 1000), 300000) : null,
    max_retries: typeof body.maxRetries === 'number' ? Math.min(Math.max(body.maxRetries, 0), 5) : null,
    opt_in_local: Boolean(body.optInLocal),
  };
  let rotated = false;
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    if (body.apiKey.length > 512) {
      return NextResponse.json({ error: 'api key too long' }, { status: 400 });
    }
    record.api_key_encrypted = encrypt(body.apiKey.trim());
    rotated = true;
  }
  // apiKey 缺省时保留已存密钥：允许仅修改 model/base URL，不重发密钥

  record.tenant_id = context.tenantId;
  record.business_id = context.businessId;
  const { data: existing } = await supabase
    .from('model_configs')
    .select('id')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .eq('provider', provider)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase.from('model_configs')
      .update(record)
      .eq('id', existing.id)
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('model_configs').insert(record);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: rotated ? 'ai_provider.key_rotated' : 'ai_provider.updated',
    entity: 'model_config',
    entityId: provider,
    after: {
      baseUrl,
      defaultModel: record.default_model,
      isEnabled: record.is_enabled,
      keyProvided: rotated,
      maskedKey: rotated ? mask(body.apiKey.trim()) : undefined,
    },
  });
  return NextResponse.json({ ok: true });
}

async function deleteModel(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('model_configs')
    .delete()
    .eq('provider', provider)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
  if (error) throw new Error(error.message);
  await writeAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: 'ai_provider.deleted',
    entity: 'model_config',
    entityId: provider,
  });
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'settings:write', action: 'models.save', entity: 'model_configs' },
  saveModel,
);
export const DELETE = protectBusinessMutation(
  { permission: 'settings:write', action: 'models.delete', entity: 'model_configs' },
  deleteModel,
);
