import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt, decrypt, mask } from '@/lib/crypto';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';
import { PROVIDER_CATALOG, getCatalogEntry, catalogSummary } from '@/lib/ai/provider-catalog';
import { classifyModelCapability, classifyModelStrength } from '@/lib/ai/model-registry';
import { checkBaseUrl } from '@/lib/ai/url-utils';
import { testProviderConnection } from '@/lib/ai/connection-test';
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

/**
 * 供 UI 按能力分组的模型清单。
 *
 * 为什么要服务端算：分类函数在 `model-registry.ts`，而那个模块引入了
 * `getSupabaseClient`（服务端专用）—— 客户端组件直接 import 它会把
 * 数据库客户端拖进浏览器包。服务端算好、客户端只管展示，是唯一干净的做法。
 *
 * 顺序：先用真实发现的 models_cache，再补目录里的静态提示，最后补当前默认模型，
 * 去重。分类是命名模式启发式（见 classifyModelCapability），不是官方元数据。
 */
function modelsCatalogFor(
  stored: ReturnType<typeof toConnectionView> | undefined,
  models: ReadonlyArray<{ id: string }>,
): Array<{ id: string; capability: string; strength: string }> {
  const ids = new Set<string>();
  for (const id of stored?.modelsCache ?? []) ids.add(id);
  for (const m of models) ids.add(m.id);
  if (stored?.defaultModel) ids.add(stored.defaultModel);
  return [...ids].map((id) => ({
    id,
    capability: classifyModelCapability(id),
    strength: classifyModelStrength(id),
  }));
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
      // 已分类的模型清单，供「模型分流」按能力挑选（只列 chat，见前端 chatModelOptions）
      modelsCatalog: modelsCatalogFor(stored, entry.models),
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
    .select('id, api_key_encrypted')
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

  // ---- 保存即拉取该供应商的模型列表 ----
  //
  // 老板的心智模型是「填完 key 就应该看到这家有哪些模型，再按用途挑」。
  // 而原先只有手动点「测试连接」才会打 /models 并落 models_cache —— 保存后
  // 弹窗里的「默认模型」下拉仍是空的，看起来像"没识别到模型"。
  //
  // 这里保存后自动拉一次。**失败不影响保存结果**：保存是写配置，拉列表是增强；
  // 把两者绑死会让网络抖动变成"配置存不进去"。拉取失败的原因仍可由
  // 「测试连接」给出（它返回结构化 error）。
  const keyForProbe = typeof body.apiKey === 'string' && body.apiKey.trim()
    ? body.apiKey.trim()
    : (() => {
        const stored = (existing as { api_key_encrypted?: string | null } | null)?.api_key_encrypted;
        if (!stored) return null;
        try {
          return decrypt(stored);
        } catch {
          return null;
        }
      })();

  let discovered: string[] | null = null;
  try {
    const probe = await testProviderConnection({
      provider,
      apiKey: keyForProbe,
      baseUrl,
      model: (record.default_model as string | null) ?? null,
      timeoutMs: (record.timeout_ms as number | null) ?? undefined,
      allowLocal,
    });
    if (probe.models && probe.models.length > 0) {
      discovered = probe.models;
      await supabase
        .from('model_configs')
        .update({ models_cache: probe.models, models_updated_at: new Date().toISOString() })
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .eq('provider', provider);
    }
  } catch {
    // 拉取失败不阻断保存；旧表缺 models_cache 列时也会走到这里
  }

  return NextResponse.json({ ok: true, models: discovered });
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
