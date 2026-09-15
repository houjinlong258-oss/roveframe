/**
 * RoveFrame Model Registry —— Agent Workspace 输入框（Model Composer）的唯一数据源。
 *
 * 契约（不要破坏）：
 * - 只读 `model_configs` 的**白名单列**，绝不 `select('*')`；凭据列只用来判断
 *   「是否已配置 Key」，解密结果永远不进入本模块的返回值。
 * - 健康度来自两个**真实**来源：① 设置页连接测试结果（last_test_ok/last_tested_at）
 *   ② 最近 N 条 `ai_usage_ledger` 真实调用（延迟分位 + 失败率）。没有数据时返回
 *   `unknown`，**绝不假装在线**。
 * - `tier`（能力分级）是基于模型命名模式的**启发式推断**，只用于排序与默认推荐，
 *   不代表官方基准分；UI 必须如实标注。
 * - 未接入（无 Key 或 is_enabled=false）的服务商 health 恒为 `offline`，不可选。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { PROVIDER_CATALOG, getCatalogEntry, runtimeProtocolOf } from '@/lib/ai/provider-catalog';
import { AUTO_ROUTE } from '@/lib/ai/providers';
import type { Capability } from '@/lib/ai/providers';

/**
 * 推理强度相关的类型与常量定义在 `@/lib/ai/reasoning`（纯模块）。
 * 这里只做再导出，方便服务端代码从一处 import；**浏览器端必须直接引用
 * `@/lib/ai/reasoning`**，否则会把 supabase 客户端打进前端 bundle。
 */
export {
  AGENT_DEFAULT_REASONING,
  REASONING_LEVELS,
  defaultReasoningForAgent,
  resolveReasoningLevel,
} from '@/lib/ai/reasoning';
export type { ModelPreference, ReasoningLevel, ReasoningProfile } from '@/lib/ai/reasoning';

export type ModelHealth = 'online' | 'slow' | 'degraded' | 'error' | 'offline' | 'unknown';
export type CapabilityTier = 'high' | 'medium' | 'low';

/**
 * 模型能力分类。**这是修一个真实故障**：
 * 用户的服务商 /models 里同时有 `agnes-image-2.0-flash`、`agnes-video-2.5-flash`。
 * 之前 Composer 把它们和聊天模型混在一起列出，用户把图像模型选了当聊天模型，
 * 每次请求必然 400，白白触发一次故障切换（真实账本里连续 4 条 provider_error）。
 * 现在只有 `chat` 能进 Composer 的聊天模型列表。
 */
export type ModelCapability = 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'other';

/** UI 分组标签（🧠 推理 / 💻 编码 / 👁 视觉 / ⚡ 快速 / ⚙️ 通用） */
export type ModelStrength = 'reasoning' | 'coding' | 'vision' | 'fast' | 'general';

const IMAGE_PATTERN = /(^|[-_/.])(image|img|t2i|dall-?e|flux|stable-?diffusion|sd[-_]?\d|midjourney|imagen|kolors|seedream|wanx|photogen)([-_/.]|$)/i;
const VIDEO_PATTERN = /(^|[-_/.])(video|t2v|i2v|sora|kling|runway|seedance|hunyuan-video|veo)([-_/.]|$)/i;
const AUDIO_PATTERN = /(^|[-_/.])(audio|tts|asr|whisper|speech|voice|music|sound|realtime)([-_/.]|$)/i;
const EMBEDDING_PATTERN = /(^|[-_/.])(embed|embedding|bge|gte|rerank|text-embedding)([-_/.]|$)/i;

export function classifyModelCapability(modelId: string): ModelCapability {
  const id = modelId ?? '';
  if (EMBEDDING_PATTERN.test(id)) return 'embedding';
  if (IMAGE_PATTERN.test(id)) return 'image';
  if (VIDEO_PATTERN.test(id)) return 'video';
  if (AUDIO_PATTERN.test(id)) return 'audio';
  return 'chat';
}

const REASONING_STRENGTH = /(reasoner|thinking|\bo[1-9]\b|gpt-5|opus|deepseek-r|qwq|\br1\b|\bpro\b)/i;
const CODING_STRENGTH = /(coder|codestral|codex|devstral|sonnet)/i;
const FAST_STRENGTH = /(mini|flash|haiku|lite|nano|small|turbo|instant)/i;
const VISION_STRENGTH = /(vision|\bvl\b|multimodal|gpt-4o|gemini|claude-3|omni)/i;

/** 强度标签仅用于 UI 分组，是命名模式启发式，不代表官方基准。 */
export function classifyModelStrength(modelId: string): ModelStrength {
  const id = modelId ?? '';
  if (REASONING_STRENGTH.test(id)) return 'reasoning';
  if (CODING_STRENGTH.test(id)) return 'coding';
  if (FAST_STRENGTH.test(id)) return 'fast';
  if (VISION_STRENGTH.test(id)) return 'vision';
  return 'general';
}

/** 健康度汇总样本窗口（真实调用条数） */
const LEDGER_SAMPLE_SIZE = 200;
/** 判定「慢」的 p50 延迟阈值（毫秒） */
const SLOW_LATENCY_MS = 6_000;

export interface RegistryModel {
  id: string;
  label: string;
  tier: CapabilityTier;
  /** 能力分类：只有 chat 能被选来聊天 */
  capability: ModelCapability;
  /** UI 分组标签 */
  strength: ModelStrength;
  contextLength: number | null;
  vision: boolean;
  reasoning: boolean;
  deprecated: boolean;
  /** 是否来自 provider 的真实 /models 探测结果（false = 来自内置目录） */
  discovered: boolean;
}

export interface RegistryProvider {
  id: string;
  displayName: string;
  description: string;
  category: string;
  protocol: string;
  /** adapter 支持级别：declared 表示协议已建模但未通过真实验收，不可路由 */
  runtime: 'native' | 'openai_compat' | 'declared';
  configured: boolean;
  isEnabled: boolean;
  hasKey: boolean;
  baseUrl: string | null;
  defaultModel: string | null;
  health: ModelHealth;
  latencyMs: number | null;
  successRate: number | null;
  callCount: number;
  lastTestedAt: string | null;
  /** 已脱敏的连接错误（写入时即脱敏） */
  lastError: string | null;
  models: RegistryModel[];
}

export interface PlatformFallbackModel {
  provider: 'platform';
  model: string;
  label: string;
}

export interface ModelRegistry {
  providers: RegistryProvider[];
  /** 当前 model_assign.agent 指向的默认目标（provider:model），auto 时为 null */
  defaultProvider: string | null;
  defaultModel: string | null;
  /** 未接入任何外部服务商时永远可用的平台内置模型 */
  platformFallback: PlatformFallbackModel;
  /** 有 Key、已启用、adapter 可路由 —— 可进入故障切换链的服务商 */
  routableProviderIds: string[];
  generatedAt: string;
}


/**
 * 能力分级启发式。**仅供排序/推荐**，不是官方基准。
 *
 * 两个踩过的坑（有单测兜底）：
 * - 必须带词边界：无边界时 `mini` 会命中 `ge**mini**-2.5-pro`，把旗舰模型降档；
 * - `o3`/`o4` 也要带边界，否则会误伤 `gpt-4o` 之类的普通模型。
 * 先判低档再判高档，避免 `gpt-5-mini` 被 `gpt-5` 规则误升档。
 */
const LOW_TIER_PATTERN =
  /\b(mini|flash|haiku|small|lite|nano|air|instant|abab|turbo-preview)\b|\b[1-9]b\b/i;
const HIGH_TIER_PATTERN =
  /(opus|gpt-5|gpt-4\.5|\bo[34]\b|sonnet-4|reasoner|thinking|-pro\b|max\b|\b(70|72|405)b\b|large|ultra)/i;

/** 显式覆盖：命名模式会误判、但已知属于高能力的模型 */
const TIER_OVERRIDES: Record<string, CapabilityTier> = {
  'minimax-m1': 'high',
};

export function tierForModel(modelId: string): CapabilityTier {
  const override = TIER_OVERRIDES[modelId.toLowerCase()];
  if (override) return override;
  if (LOW_TIER_PATTERN.test(modelId)) return 'low';
  if (HIGH_TIER_PATTERN.test(modelId)) return 'high';
  return 'medium';
}

/**
 * 是否为「原生推理模型」：这类模型拒绝显式 temperature，
 * 且接受 reasoning_effort。判定错误会导致上游 400 → 误触发故障切换，
 * 因此只匹配明确的命名模式。
 */
export function isNativeReasoningModel(modelId: string): boolean {
  return /(^|\/)(o[1-9](-mini|-pro)?|gpt-5(\.\d)?(-mini|-nano)?|deepseek-reasoner|.*-thinking|.*-reasoner)$/i
    .test(modelId) || /(^|\/)(o[1-9]|gpt-5)(-|$)/i.test(modelId);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

interface LedgerRow {
  provider: string;
  model: string;
  status: string;
  latency_ms: number | null;
}

interface ProviderStats {
  latencyMs: number | null;
  successRate: number | null;
  callCount: number;
}

/** 从真实调用账本聚合每个服务商的 p50 延迟与成功率 */
export function aggregateLedgerStats(rows: readonly LedgerRow[]): Map<string, ProviderStats> {
  const grouped = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.provider);
    if (list) list.push(row);
    else grouped.set(row.provider, [row]);
  }
  const stats = new Map<string, ProviderStats>();
  for (const [provider, list] of grouped) {
    const latencies = list
      .filter((row) => row.status === 'ok' && typeof row.latency_ms === 'number')
      .map((row) => row.latency_ms as number);
    const okCount = list.filter((row) => row.status !== 'error').length;
    stats.set(provider, {
      latencyMs: percentile(latencies, 50),
      successRate: list.length > 0 ? okCount / list.length : null,
      callCount: list.length,
    });
  }
  return stats;
}

export interface HealthInput {
  configured: boolean;
  lastTestOk: boolean | null;
  latencyMs: number | null;
  successRate: number | null;
  callCount: number;
}

/**
 * 健康度判定（顺序敏感，先排除硬失败）：
 * 未接入 → offline；连接测试失败 → error；真实失败率高 → error/degraded；
 * 延迟过高 → slow；无任何观测数据 → unknown（UI 显示灰点，不冒充在线）。
 */
export function healthOf(input: HealthInput): ModelHealth {
  if (!input.configured) return 'offline';
  if (input.lastTestOk === false) return 'error';
  if (input.callCount === 0) return input.lastTestOk === true ? 'online' : 'unknown';
  if (input.successRate !== null && input.successRate < 0.5) return 'error';
  if (input.successRate !== null && input.successRate < 0.75) return 'degraded';
  if (input.latencyMs !== null && input.latencyMs > SLOW_LATENCY_MS) return 'slow';
  return 'online';
}

export interface RegistryScope {
  tenantId: string;
  businessId: string;
}

interface ModelConfigRow {
  provider: string;
  api_key_encrypted: string | null;
  base_url: string | null;
  default_model: string | null;
  is_enabled: boolean;
  last_test_ok: boolean | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  models_cache: string[] | null;
  display_name: string | null;
}

/** model_configs 读取列白名单：凭据列只用于判断存在性，绝不解密返回。 */
const MODEL_CONFIG_COLUMNS =
  'provider, api_key_encrypted, base_url, default_model, is_enabled, last_test_ok, last_tested_at, last_test_error, models_cache, display_name';

/** 旧预设 id → Catalog id 兼容映射（与 router 保持一致） */
const PROVIDER_ALIAS: Record<string, string> = {
  claude: 'anthropic',
  kimi: 'moonshot_cn',
};

function emptyRegistry(): ModelRegistry {
  const fallback = AUTO_ROUTE.agent.model;
  return {
    providers: PROVIDER_CATALOG.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      description: entry.description,
      category: entry.category,
      protocol: entry.protocol,
      runtime: entry.runtime,
      configured: false,
      isEnabled: false,
      hasKey: false,
      baseUrl: entry.defaultBaseUrl || null,
      defaultModel: null,
      health: 'offline' as ModelHealth,
      latencyMs: null,
      successRate: null,
      callCount: 0,
      lastTestedAt: null,
      lastError: null,
      models: entry.models.map((m) => ({
        id: m.id,
        label: m.id,
        tier: tierForModel(m.id),
        capability: classifyModelCapability(m.id),
        strength: classifyModelStrength(m.id),
        contextLength: m.contextLength ?? null,
        vision: entry.supportsVision,
        reasoning: entry.supportsReasoning,
        deprecated: m.deprecated ?? false,
        discovered: false,
      })),
    })),
    defaultProvider: null,
    defaultModel: fallback,
    platformFallback: { provider: 'platform', model: fallback, label: fallback },
    routableProviderIds: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 构建 Model Registry。任何数据源失败都降级为「只有平台内置模型」的空注册表，
 * 不让设置页/数据库异常连带把 Composer 打崩。
 */
export async function buildModelRegistry(scope: RegistryScope | null): Promise<ModelRegistry> {
  if (!scope?.tenantId || !scope.businessId) return emptyRegistry();
  try {
    const client = getSupabaseClient();
    const [configResult, settingsResult, ledgerResult] = await Promise.all([
      client
        .from('model_configs')
        .select(MODEL_CONFIG_COLUMNS)
        .eq('tenant_id', scope.tenantId)
        .eq('business_id', scope.businessId),
      client
        .from('settings')
        .select('model_assign')
        .eq('tenant_id', scope.tenantId)
        .eq('business_id', scope.businessId)
        .limit(1),
      client
        .from('ai_usage_ledger')
        .select('provider, model, status, latency_ms')
        .eq('tenant_id', scope.tenantId)
        .eq('business_id', scope.businessId)
        .order('created_at', { ascending: false })
        .limit(LEDGER_SAMPLE_SIZE),
    ]);

    const rows = (configResult.data ?? []) as ModelConfigRow[];
    const stats = aggregateLedgerStats((ledgerResult.data ?? []) as LedgerRow[]);
    const byProvider = new Map<string, ModelConfigRow>();
    for (const row of rows) byProvider.set(row.provider, row);

    const providers: RegistryProvider[] = PROVIDER_CATALOG.map((entry) => {
      const stored =
        byProvider.get(entry.id) ??
        byProvider.get(Object.keys(PROVIDER_ALIAS).find((k) => PROVIDER_ALIAS[k] === entry.id) ?? '');
      const hasKey = Boolean(stored?.api_key_encrypted);
      const routable = entry.runtime !== 'declared' && runtimeProtocolOf(entry) !== null;
      const configured = Boolean(stored?.is_enabled) && (hasKey || entry.authType === 'local') && routable;
      const providerStats = stats.get(entry.id) ?? { latencyMs: null, successRate: null, callCount: 0 };

      const discovered = stored?.models_cache ?? [];
      const modelIds = Array.from(
        new Set([
          ...(stored?.default_model ? [stored.default_model] : []),
          ...discovered,
          ...entry.models.map((m) => m.id),
        ].filter(Boolean)),
      );
      const knownModels = new Map(entry.models.map((m) => [m.id, m]));

      return {
        id: entry.id,
        displayName: stored?.display_name || entry.displayName,
        description: entry.description,
        category: entry.category,
        protocol: entry.protocol,
        runtime: entry.runtime,
        configured,
        isEnabled: Boolean(stored?.is_enabled),
        hasKey,
        baseUrl: stored?.base_url ?? entry.defaultBaseUrl ?? null,
        defaultModel: stored?.default_model ?? null,
        health: healthOf({
          configured,
          lastTestOk: stored?.last_test_ok ?? null,
          latencyMs: providerStats.latencyMs,
          successRate: providerStats.successRate,
          callCount: providerStats.callCount,
        }),
        latencyMs: providerStats.latencyMs,
        successRate: providerStats.successRate,
        callCount: providerStats.callCount,
        lastTestedAt: stored?.last_tested_at ?? null,
        lastError: stored?.last_test_error ?? null,
        models: modelIds.map((id) => {
          const known = knownModels.get(id);
          return {
            id,
            label: id,
            tier: tierForModel(id),
            capability: classifyModelCapability(id),
            strength: classifyModelStrength(id),
            contextLength: known?.contextLength ?? null,
            vision: entry.supportsVision,
            reasoning: entry.supportsReasoning,
            deprecated: known?.deprecated ?? false,
            discovered: discovered.includes(id),
          };
        }),
      };
    });

    const assign = ((settingsResult.data?.[0]?.model_assign ?? {}) as Record<string, string>);
    const agentTarget = assign.agent ?? 'auto';
    let defaultProvider: string | null = null;
    let defaultModel: string | null = null;
    if (agentTarget !== 'auto' && agentTarget.includes(':')) {
      const [rawProvider, model] = agentTarget.split(':');
      const provider = PROVIDER_ALIAS[rawProvider] ?? rawProvider;
      if (getCatalogEntry(provider)) {
        defaultProvider = provider;
        defaultModel = model || null;
      }
    }

    return {
      providers,
      defaultProvider,
      defaultModel,
      platformFallback: {
        provider: 'platform',
        model: AUTO_ROUTE.agent.model,
        label: AUTO_ROUTE.agent.model,
      },
      routableProviderIds: providers.filter((p) => p.configured).map((p) => p.id),
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return emptyRegistry();
  }
}

/** 平台内置模型在账本中的 provider 标识 */
export const PLATFORM_PROVIDER_ID = 'platform';

/** 按能力与健康度给可路由服务商排序，供故障切换链使用（越靠前越优先） */
export function rankRoutableProviders(
  registry: ModelRegistry,
  capability: Capability,
): RegistryProvider[] {
  const healthScore: Record<ModelHealth, number> = {
    online: 0,
    unknown: 1,
    slow: 2,
    degraded: 3,
    error: 4,
    offline: 5,
  };
  return registry.providers
    .filter((provider) => provider.configured)
    .filter((provider) => capability !== 'light' || provider.models.length > 0)
    .sort((a, b) => {
      const health = healthScore[a.health] - healthScore[b.health];
      if (health !== 0) return health;
      const aLatency = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
      const bLatency = b.latencyMs ?? Number.MAX_SAFE_INTEGER;
      return aLatency - bLatency;
    });
}
