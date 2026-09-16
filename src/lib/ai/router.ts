import { LLMClient, Config } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { decrypt } from "@/lib/crypto";
import { AUTO_ROUTE, PROVIDER_PRESETS, type Capability } from "@/lib/ai/providers";
import { REASONING_LEVELS, isNativeReasoningModel, type ModelPreference, type ReasoningLevel } from "@/lib/ai/model-registry";
import { getCatalogEntry, runtimeProtocolOf } from "@/lib/ai/provider-catalog";
import { AIError, classifyHTTPError } from "@/lib/ai/errors";
import { providerBreaker } from "@/lib/ai/circuit-breaker";
import { joinEndpoint, checkBaseUrl } from "@/lib/ai/url-utils";
import { recordAIUsage } from "@/lib/ai/usage-ledger";
import { assertSafeOutboundUrl, fetchWithOutboundGuard } from "@/lib/security/outbound-url";

/** 多模态内容块：text + image_url（url 可为 data URL 或 http(s) 地址） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export type AIToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AIToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type AIToolDecision =
  | { supported: false }
  | { supported: true; text: string; toolCalls: AIToolCall[] };

/**
 * AI 请求 scope：租户业务调用必须至少携带 tenantId；
 * businessId/userId/requestId 用于 business 级配置、审计与用量追踪。
 * 只有明确标记为平台级任务的调用才允许没有 scope。
 */
export type AIRequestScope = {
  tenantId: string;
  businessId?: string | null;
  userId?: string;
  requestId?: string;
};

/**
 * 平台级调用（无租户业务 scope）的显式标记。
 * 此类调用只允许走平台内置模型（AUTO_ROUTE），永不读取任何租户的
 * settings/model_configs，防止跨租户凭据滥用。
 */
export const PLATFORM_AI_SCOPE: null = null;

/**
 * 解析前校验 scope 形状（fail-closed）。导出供安全契约测试使用。
 * - scope 缺省 → 平台级路由（platform_scope）
 * - scope 存在但 tenant/business 缺失 → 拒绝（business_scope_required）
 */
export function validateModelResolutionScope(
  scope: AIRequestScope | null,
): { ok: true; tenantId: string; businessId: string } | { ok: false; reason: string } {
  if (!scope) return { ok: false, reason: 'platform_scope' };
  if (!scope.tenantId || !scope.businessId) {
    return { ok: false, reason: 'business_scope_required' };
  }
  return { ok: true, tenantId: scope.tenantId, businessId: scope.businessId };
}

export interface AICallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  /** 用量账本中的 agent 标记（如 ceo/operations/scheduler/daily-brief） */
  agent?: string;
  /**
   * 推理强度（Composer 的「思考强度」）。只影响 max_tokens / temperature /
   * reasoning_effort，绝不为不支持的服务商伪造私有参数。
   */
  reasoning?: ReasoningLevel;
}

/** 每次路由决策的诊断信息：实际 provider/model、是否 fallback、原因、request id */
export interface AIRouteDiagnostics {
  requestId: string;
  capability: Capability;
  kind: "platform" | "external";
  provider: string;
  model: string;
  usedFallback: boolean;
  fallbackReason: string | null;
}

export interface ResolvedModel {
  kind: "platform" | "external";
  model: string;
  temperature: number;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: "anthropic" | "openai";
  timeoutMs: number;
  maxRetries: number;
  allowLocal: boolean;
}

/** 旧预设 id → Catalog id 的兼容映射 */
const PROVIDER_ALIAS: Record<string, string> = {
  claude: "anthropic",
  kimi: "moonshot_cn",
};

const DEFAULT_TIMEOUT_MS = 60_000;
// 流式生成（agent 多轮工具 + 长回复）远超 60s，绝对超时只作为无限挂起的兜底
const STREAM_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;

/** 把多模态 content 降级为纯文本（提取 text 块），用于平台内置模型的兜底 */
function textOf(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n");
}

/** 图片拉取上限（防恶意超大响应占内存） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 从 URL 或 data URL 拿到 base64 图片数据（Anthropic 图片协议要求 base64） */
async function imageToBase64(url: string): Promise<{ media_type: string; data: string }> {
  const dataMatch = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (dataMatch) {
    return { media_type: dataMatch[1], data: dataMatch[2].replace(/\s/g, "") };
  }
  // SSRF：模型消息里的 image_url 是客户端可控输入，与模型 base URL 同等对待——
  // 仅公网 https（DNS 解析逐地址复检 + 重定向逐跳复检），禁止 metadata/loopback/私网。
  const safeUrl = await assertSafeOutboundUrl(url, {});
  const resp = await fetchWithOutboundGuard(
    safeUrl,
    { signal: AbortSignal.timeout(15000) },
    {},
  );
  if (!resp.ok) throw new Error(`图片拉取失败 (${resp.status})`);
  const mediaType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!/^image\//i.test(mediaType)) {
    throw new Error('图片地址返回的不是图片内容');
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 10MB 上限');
  }
  return { media_type: mediaType, data: buffer.toString("base64") };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

async function toAnthropicContent(content: ChatContent): Promise<string | AnthropicContentBlock[]> {
  if (typeof content === "string") return content;
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const { media_type, data } = await imageToBase64(part.image_url.url);
      blocks.push({ type: "image", source: { type: "base64", media_type, data } });
    }
  }
  return blocks;
}

interface ModelConfigRow {
  provider: string;
  api_key_encrypted: string | null;
  base_url: string | null;
  default_model: string | null;
  is_enabled: boolean;
  timeout_ms?: number | null;
  max_retries?: number | null;
}

/** model_configs 读取列白名单：绝不 select('*')，凭据列仅在路由层解密使用 */
const MODEL_CONFIG_COLUMNS =
  'provider, api_key_encrypted, base_url, default_model, is_enabled, timeout_ms, max_retries';

export interface ModelResolution {
  resolved: ResolvedModel;
  diagnostics: AIRouteDiagnostics;
}

function platformResolution(capability: Capability, requestId: string, usedFallback: boolean, fallbackReason: string | null): ModelResolution {
  const auto = AUTO_ROUTE[capability];
  return {
    resolved: {
      kind: "platform",
      model: auto.model,
      temperature: auto.temperature,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
      allowLocal: false,
    },
    diagnostics: {
      requestId,
      capability,
      kind: "platform",
      provider: "platform",
      model: auto.model,
      usedFallback,
      fallbackReason,
    },
  };
}

/**
 * 解析「指定 provider:model」的真实配置。
 * 服务商未接入（未启用 / 无 Key / 不在 Catalog）时返回 null，
 * 让故障切换链据此**跳过**该候选，而不是抛错中断整条链。
 */
export async function resolveExternalModel(
  rawProvider: string,
  model: string,
  capability: Capability,
  scope: AIRequestScope | null = null,
): Promise<ModelResolution | null> {
  const scopeCheck = validateModelResolutionScope(scope);
  if (!scopeCheck.ok) return null;
  const provider = PROVIDER_ALIAS[rawProvider] ?? rawProvider;
  if (!getCatalogEntry(provider) && !PROVIDER_PRESETS[provider]) return null;
  return resolveConfiguredProvider(
    provider,
    model,
    capability,
    scopeCheck.tenantId,
    scopeCheck.businessId,
    scope?.requestId ?? crypto.randomUUID(),
  );
}

/** 外部服务商的配置解析内核（不含「选哪个服务商」的决策）。 */
async function resolveConfiguredProvider(
  provider: string,
  model: string,
  capability: Capability,
  tenantId: string,
  businessId: string,
  requestId: string,
): Promise<ModelResolution | null> {
  const client = getSupabaseClient();
  const catalog = getCatalogEntry(provider);

  const { data: cfgRows, error: cErr } = await client
    .from("model_configs")
    .select(MODEL_CONFIG_COLUMNS)
    .eq("provider", provider)
    .eq("is_enabled", true)
    .eq("tenant_id", tenantId)
    .eq("business_id", businessId);
  if (cErr) throw new Error(`读取模型配置失败: ${cErr.message}`);

  const rows = (cfgRows ?? []) as ModelConfigRow[];
  const cfg = rows[0];

  const needsKey = catalog ? catalog.authType === "api_key" || catalog.authType === "oauth" : true;
  if (!cfg || (needsKey && !cfg.api_key_encrypted)) return null;

  const baseUrl = cfg.base_url || catalog?.defaultBaseUrl || PROVIDER_PRESETS[provider]?.baseUrl || "";
  const allowLocal = catalog?.category === "local" || catalog?.authType === "local";
  const urlCheck = checkBaseUrl(baseUrl, { allowLocal });
  if (!urlCheck.ok) {
    throw new AIError(
      { code: "ssrf_blocked", provider, model: model ?? undefined, requestId, retryable: false },
      `base URL 未通过安全校验 (${urlCheck.reason})`,
    );
  }

  const protocol = catalog ? runtimeProtocolOf(catalog) : (PROVIDER_PRESETS[provider]?.protocol ?? "openai");
  if (!protocol) {
    // 协议已建模但 adapter 未完成真实验收：结构化错误，绝不静默切换
    throw new AIError(
      { code: "provider_unavailable", provider, model: model ?? undefined, requestId, retryable: false },
      `provider ${provider} 的 adapter 已声明但尚未通过验收，拒绝静默降级`,
    );
  }

  return {
    resolved: {
      kind: "external",
      model: model || cfg.default_model || catalog?.models[0]?.id || PROVIDER_PRESETS[provider]?.models[0] || "",
      temperature: AUTO_ROUTE[capability].temperature,
      provider,
      apiKey: cfg.api_key_encrypted ? decrypt(cfg.api_key_encrypted) : undefined,
      baseUrl,
      protocol,
      timeoutMs: cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      maxRetries: cfg.max_retries ?? DEFAULT_MAX_RETRIES,
      allowLocal,
    },
    diagnostics: {
      requestId,
      capability,
      kind: "external",
      provider,
      model: model || cfg.default_model || "",
      usedFallback: false,
      fallbackReason: null,
    },
  };
}

/**
 * 解析某能力应使用的模型。
 * 选择顺序：business 显式配置 → tenant 默认配置 → 平台内置（可见 fallback）。
 * 配置存在但不可用（SSRF 拒绝、adapter 未验收）时抛结构化错误，
 * 不静默切换到平台模型。
 */
async function resolveModelDetailed(capability: Capability, scope: AIRequestScope | null = null): Promise<ModelResolution> {
  const requestId = scope?.requestId ?? crypto.randomUUID();
  const scopeCheck = validateModelResolutionScope(scope);
  if (!scopeCheck.ok) {
    if (scopeCheck.reason === 'platform_scope') {
      // 平台级任务：只允许平台内置模型，绝不读取任何租户的 settings/model_configs
      //（防止无 scope 时无过滤 select 命中任意租户并解密其付费 Key）。
      return platformResolution(capability, requestId, false, null);
    }
    throw new Error('business scope is required for model resolution');
  }
  const tenantId = scopeCheck.tenantId;
  const businessId = scopeCheck.businessId;
  const client = getSupabaseClient();
  const { data: settingsRows, error: sErr } = await client
    .from("settings")
    .select("model_assign")
    .eq("tenant_id", tenantId)
    .eq("business_id", businessId)
    .limit(1);
  if (sErr) throw new Error(`读取设置失败: ${sErr.message}`);
  const assign = (settingsRows?.[0]?.model_assign ?? {}) as Record<string, string>;
  const target = assign[capability] ?? "auto";

  if (target === "auto" || !target.includes(":")) {
    return platformResolution(capability, requestId, false, null);
  }

  const [rawProvider, model] = target.split(":");
  const configured = await resolveConfiguredProvider(
    PROVIDER_ALIAS[rawProvider] ?? rawProvider,
    model,
    capability,
    tenantId,
    businessId,
    requestId,
  );
  if (!configured) {
    // 配置了分配但服务商未接入 → 可见地回落平台内置
    return platformResolution(capability, requestId, true, "provider_not_configured");
  }
  return configured;
}

/** 组合超时与调用方取消信号 */
function composeSignal(resolved: ResolvedModel, opts?: AICallOptions): AbortSignal {
  const timeoutMs = opts?.timeoutMs ?? resolved.timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  return opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
}

/** 退避基数与上限（毫秒）。 */
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 8_000;

/**
 * 第 `attempt` 次重试前的等待时间。
 *
 * Phase 12 / P1-7。原实现是 `250 * 2 ** (attempt - 1)` —— **完全确定性**。
 * 当某个 provider 抖动时，所有并发请求会在同一毫秒一起重试，形成
 * 惊群（thundering herd），把一次短暂抖动放大成对方看到的尖峰。抖动让
 * 重试时刻分散开。
 *
 * 采用 equal jitter（一半固定 + 一半随机）而不是 full jitter：
 * full jitter 可能产生接近 0 的延迟，等于放弃退避；equal jitter 保留
 * 指数退避的下界，同时打散并发。上限 `RETRY_MAX_DELAY_MS` 防止
 * `maxRetries` 较大时延迟失控。
 *
 * 导出仅供契约测试使用。
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    RETRY_MAX_DELAY_MS,
  );
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

/**
 * 有界重试的外部 fetch：仅对 429/5xx/网络错误重试（maxRetries 次，指数退避 +
 * 抖动），4xx 不重试。最终失败抛结构化 AIError（脱敏）。
 *
 * Phase 12 / P1-7：接入按 provider 的熔断器。熔断打开时**立即失败**，把请求
 * 交给 failover 链，而不是先付满重试预算再换路。
 *
 * 导出仅供契约测试使用。
 */
export async function fetchWithResilience(
  url: string,
  init: RequestInit,
  resolved: ResolvedModel,
  requestId: string,
  opts?: AICallOptions,
): Promise<Response> {
  // 熔断按 provider 维度（一个 provider 宕机影响它的全部模型）。
  // ResolvedModel.provider 是可选字段，这里落到 model 再落到常量，
  // 保证 key 永远是 string —— 否则一个未命名的 provider 会绕过熔断。
  const breakerKey = resolved.provider ?? resolved.model ?? "unknown-provider";
  const gate = providerBreaker.canAttempt(breakerKey);
  if (!gate.allowed) {
    throw new AIError(
      {
        code: "provider_circuit_open",
        provider: resolved.provider,
        model: resolved.model,
        requestId,
        // 不可重试：交给 failover 换 provider 才有意义，原地重试只会继续压垮对方。
        retryable: false,
      },
      `${resolved.provider} 连续失败已熔断，${Math.ceil(gate.retryAfterMs / 1000)}s 后重试`,
    );
  }

  const maxRetries = opts?.maxRetries ?? resolved.maxRetries;
  let lastError: AIError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    }
    try {
      // 受控出站：重定向逐跳复检 + DNS 解析后逐地址拦截（allowLocal 仅非生产本地模型）
      const resp = await fetchWithOutboundGuard(
        url,
        { ...init, signal: composeSignal(resolved, opts) },
        resolved.allowLocal ? { allowHttp: true, allowPrivate: true } : {},
      );
      if (resp.ok) {
        // 成功即认为 provider 健康，清空该 provider 的连续失败计数。
        providerBreaker.recordSuccess(breakerKey);
        return resp;
      }
      const { code, retryable } = classifyHTTPError(resp.status);
      const body = await resp.text().catch(() => "");
      lastError = new AIError(
        { code, provider: resolved.provider, model: resolved.model, status: resp.status, requestId, retryable },
        `${resolved.provider} 调用失败 (${resp.status}): ${body}`,
      );
      if (!retryable) {
        // 4xx 是配置/请求问题，不是 provider 健康问题 —— 不计入熔断。
        throw lastError;
      }
    } catch (err) {
      if (err instanceof AIError && !err.retryable) throw err;
      if (err instanceof AIError) {
        lastError = err;
        continue;
      }
      // SSRF/重定向守卫拒绝：结构化不可重试错误，绝不换路重试绕过
      if (err instanceof Error && err.message.startsWith('outbound_url_rejected:')) {
        throw new AIError(
          {
            code: "ssrf_blocked",
            provider: resolved.provider,
            model: resolved.model,
            requestId,
            retryable: false,
          },
          err.message,
        );
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastError = new AIError(
        {
          code: isTimeout ? "provider_timeout" : "provider_unavailable",
          provider: resolved.provider,
          model: resolved.model,
          requestId,
          retryable: true,
        },
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 整个调用（含全部重试）失败一次 = 熔断器记一次失败。
  // 不按单次 attempt 计数：否则 maxRetries=3 时一次请求就能把阈值刷满。
  providerBreaker.recordFailure(breakerKey);

  throw lastError ?? new AIError(
    { code: "provider_unavailable", provider: resolved.provider, model: resolved.model, requestId, retryable: false },
    "provider 调用失败",
  );
}

interface UsageCapture {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 导出供故障切换链复用同一记账口径 */
export type { UsageCapture };

/**
 * 写一次用量账本。导出给故障切换链，保证「平台路径」与「切换路径」
 * 的记账字段完全一致（否则 Model Status Dashboard 的延迟/失败率会失真）。
 */
export async function trackUsage(
  diagnostics: AIRouteDiagnostics,
  scope: AIRequestScope | null,
  opts: AICallOptions | undefined,
  startedAt: number,
  status: "ok" | "error" | "fallback",
  usage: UsageCapture,
  errorCode?: string | null,
): Promise<void> {
  try {
    await recordAIUsage({
      tenantId: scope?.tenantId ?? null,
      businessId: scope?.businessId ?? null,
      userId: scope?.userId ?? null,
      agent: opts?.agent ?? diagnostics.capability,
      provider: diagnostics.provider,
      model: diagnostics.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: null, // 目录暂无可靠价格数据，不伪造精确成本
      status: diagnostics.usedFallback && status === "ok" ? "fallback" : status,
      errorCode: errorCode ?? null,
      correlationId: diagnostics.requestId,
      latencyMs: Date.now() - startedAt,
    });
  } catch {
    // 用量记录绝不阻断主链路
  }
}

/** 平台内置模型的解析结果（故障切换链的最后一级兜底）。 */
export function resolvePlatformModel(
  capability: Capability,
  requestId?: string,
): ModelResolution {
  return platformResolution(capability, requestId ?? crypto.randomUUID(), false, null);
}

/**
 * 已解析模型上的流式内核。抽出来供故障切换链复用，
 * 避免「解析一次、按候选逐个重试」时重复解析与重复记账。
 */
export async function* streamResolvedModel(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  forwardHeaders: Record<string, string> | undefined,
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  if (resolved.kind === "platform") {
    // 平台内置模型：降级为纯文本（视觉能力走接入的外部服务商）
    const client = new LLMClient(new Config(), forwardHeaders);
    const textMessages = messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
    const stream = client.stream(textMessages, { model: resolved.model, temperature: resolved.temperature });
    for await (const chunk of stream) {
      if (chunk.content) yield chunk.content.toString();
    }
    return;
  }
  yield* streamExternal(resolved, messages, requestId, usage, opts);
}

/** 流式对话：平台内置走 LLMClient，外部服务商按协议直连，统一产出文本增量 */
export async function* streamChat(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders?: Record<string, string>,
  scope: AIRequestScope | null = null,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  const startedAt = Date.now();
  const { resolved, diagnostics } = await resolveModelDetailed(capability, scope);
  const usage: UsageCapture = { inputTokens: null, outputTokens: null };
  let status: "ok" | "error" = "ok";
  let errorCode: string | null = null;

  try {
    yield* streamResolvedModel(resolved, messages, forwardHeaders, diagnostics.requestId, usage, opts);
  } catch (err) {
    status = "error";
    errorCode = err instanceof AIError ? err.code : "stream_error";
    throw err;
  } finally {
    await trackUsage(diagnostics, scope, opts, startedAt, status, usage, errorCode);
  }
}

/** 非流式调用：用于分类、评分等轻量任务 */
export async function invokeChat(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders?: Record<string, string>,
  scope: AIRequestScope | null = null,
  opts?: AICallOptions,
): Promise<string> {
  let result = "";
  for await (const chunk of streamChat(capability, messages, forwardHeaders, scope, opts)) {
    result += chunk;
  }
  return result;
}

/** 诊断当前路由决策（设置页展示“实际使用的 provider/model/fallback”），不发起模型调用 */
export async function peekAIRoute(capability: Capability, scope: AIRequestScope | null = null): Promise<AIRouteDiagnostics> {
  const { diagnostics } = await resolveModelDetailed(capability, scope);
  return diagnostics;
}

/**
 * Ask an external provider for native tool calls. The platform fallback SDK
 * currently exposes text-only messages, so callers can use a deterministic
 * planner when `supported` is false.
 */
export async function invokeToolDecision(
  capability: Capability,
  messages: ChatMessage[],
  tools: AIToolDefinition[],
  _forwardHeaders?: Record<string, string>,
  scope: AIRequestScope | null = null,
  opts?: AICallOptions,
  preference?: ModelPreference | null,
): Promise<AIToolDecision> {
  if (tools.length === 0) return { supported: true, text: '', toolCalls: [] };
  const startedAt = Date.now();
  // Composer 里显式选择的模型同样用于「工具决策」，否则会出现
  // 「用 A 模型规划、用 B 模型作答」的角色错配。
  let resolution: ModelResolution | null = null;
  if (preference?.provider && preference.provider !== 'platform') {
    resolution = await resolveExternalModel(
      preference.provider,
      preference.model ?? '',
      capability,
      scope,
    );
  }
  resolution ??= await resolveModelDetailed(capability, scope);
  const { resolved, diagnostics } = resolution;
  if (resolved.kind === 'platform') return { supported: false };
  const usage: UsageCapture = { inputTokens: null, outputTokens: null };
  try {
    const decision =
      resolved.protocol === 'anthropic'
        ? await invokeAnthropicToolDecision(resolved, messages, tools, diagnostics.requestId, usage, opts)
        : await invokeOpenAIToolDecision(resolved, messages, tools, diagnostics.requestId, usage, opts);
    await trackUsage(diagnostics, scope, opts, startedAt, "ok", usage);
    return decision;
  } catch (err) {
    await trackUsage(diagnostics, scope, opts, startedAt, "error", usage, err instanceof AIError ? err.code : "provider_error");
    throw err;
  }
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function providerToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 64);
}

function internalToolName(providerName: string, tools: AIToolDefinition[]): string {
  return tools.find((tool) => providerToolName(tool.name) === providerName)?.name ?? providerName;
}

async function invokeOpenAIToolDecision(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  tools: AIToolDefinition[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): Promise<AIToolDecision> {
  const resp = await fetchWithResilience(
    joinEndpoint(resolved.baseUrl ?? '', 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        messages,
        temperature: resolved.temperature,
        stream: false,
        tool_choice: 'auto',
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: providerToolName(tool.name),
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
    },
    resolved,
    requestId,
    opts,
  );
  const payload = await resp.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usage.inputTokens = payload.usage?.prompt_tokens ?? null;
  usage.outputTokens = payload.usage?.completion_tokens ?? null;
  const message = payload.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls ?? [])
    .filter((call) => typeof call.function?.name === 'string')
    .map((call) => ({
      id: call.id ?? crypto.randomUUID(),
      name: internalToolName(call.function!.name!, tools),
      input: parseToolInput(call.function?.arguments),
    }));
  return { supported: true, text: message?.content ?? '', toolCalls };
}

async function invokeAnthropicToolDecision(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  tools: AIToolDefinition[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): Promise<AIToolDecision> {
  const system = messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n');
  const turns: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    turns.push({ role: message.role, content: await toAnthropicContent(message.content) });
  }
  const resp = await fetchWithResilience(
    joinEndpoint(resolved.baseUrl ?? '', 'v1/messages'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolved.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 2048,
        system: system || undefined,
        messages: turns,
        temperature: resolved.temperature,
        tools: tools.map((tool) => ({
          name: providerToolName(tool.name),
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      }),
    },
    resolved,
    requestId,
    opts,
  );
  const payload = await resp.json() as {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage.inputTokens = payload.usage?.input_tokens ?? null;
  usage.outputTokens = payload.usage?.output_tokens ?? null;
  const text = (payload.content ?? [])
    .filter((block): block is { type: 'text'; text?: string } => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const toolCalls = (payload.content ?? [])
    .filter((block): block is { type: 'tool_use'; id?: string; name?: string; input?: unknown } => block.type === 'tool_use')
    .filter((block) => typeof block.name === 'string')
    .map((block) => ({
      id: block.id ?? crypto.randomUUID(),
      name: internalToolName(block.name!, tools),
      input: block.input ?? {},
    }));
  return { supported: true, text, toolCalls };
}

async function* streamExternal(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  if (resolved.protocol === "anthropic") {
    yield* streamAnthropic(resolved, messages, requestId, usage, opts);
    return;
  }
  yield* streamOpenAICompatible(resolved, messages, requestId, usage, opts);
}

/** 逐行消费 SSE buffer，返回文本增量；provider error event 抛结构化错误。导出仅供契约测试。 */
export function* parseSSEDataLines(
  lines: string[],
  onPayload: (json: Record<string, unknown>) => string | null,
  resolved: ResolvedModel,
  requestId: string,
): Generator<string> {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue; // 忽略不完整的 SSE 片段
    }
    // provider 级错误事件（OpenAI 兼容 {"error": ...} / Anthropic {"type":"error"}）
    const errPayload = (json.error ?? (json.type === 'error' ? json : null)) as { message?: string; type?: string } | null;
    if (errPayload) {
      throw new AIError(
        { code: 'stream_error', provider: resolved.provider, model: resolved.model, requestId, retryable: false },
        `provider 流式错误: ${errPayload.message ?? errPayload.type ?? 'unknown'}`,
      );
    }
    const delta = onPayload(json);
    if (delta) yield delta;
  }
}

/**
 * 推理强度 → 请求体参数。
 *
 * 安全边界（踩过的坑）：向不支持的服务商发送 `reasoning_effort` 或对
 * o 系列发送 `temperature` / `max_tokens` 会直接 400，而 400 在故障切换链里
 * 会被误判成「该服务商挂了」并切走。因此这里只对**明确支持**的组合下发原生参数：
 * - `reasoning_effort`：仅 openai 官方（其 o/gpt-5 系列）；
 * - o/gpt-5 系列改用 `max_completion_tokens` 并省略 `temperature`；
 * - 其余服务商只调整通用 max_tokens/temperature。
 */
const REASONING_EFFORT_PROVIDERS: ReadonlySet<string> = new Set(['openai']);

export function reasoningParams(
  resolved: ResolvedModel,
  opts?: AICallOptions,
): Record<string, unknown> {
  const profile = REASONING_LEVELS[opts?.reasoning ?? 'medium'];
  const isOpenAIReasoning = resolved.provider === 'openai' && isNativeReasoningModel(resolved.model);
  if (isOpenAIReasoning) {
    return {
      max_completion_tokens: profile.maxTokens,
      temperature: undefined,
      reasoning_effort: REASONING_EFFORT_PROVIDERS.has(resolved.provider ?? '')
        ? profile.level
        : undefined,
      __omitTemperature: true,
    };
  }
  return { max_tokens: profile.maxTokens, temperature: resolved.temperature, __omitTemperature: false };
}

/** 去掉 undefined 与内部标记，得到可直接展开进请求体的对象。 */
function cleanReasoningParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('__') || value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

async function* streamOpenAICompatible(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  const streamOpts: AICallOptions = { ...opts, timeoutMs: Math.max(opts?.timeoutMs ?? 0, STREAM_TIMEOUT_MS) };
  const resp = await fetchWithResilience(
    joinEndpoint(resolved.baseUrl ?? '', 'chat/completions'),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey ?? ''}` },
      body: JSON.stringify({
        model: resolved.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...cleanReasoningParams(reasoningParams(resolved, opts)),
      }),
    },
    resolved,
    requestId,
    streamOpts,
  );
  if (!resp.body) {
    throw new AIError(
      { code: 'provider_unavailable', provider: resolved.provider, model: resolved.model, requestId, retryable: true },
      `${resolved.provider} 响应缺少流式 body`,
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onPayload = (json: Record<string, unknown>): string | null => {
    const usagePayload = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usagePayload) {
      usage.inputTokens = usagePayload.prompt_tokens ?? usage.inputTokens;
      usage.outputTokens = usagePayload.completion_tokens ?? usage.outputTokens;
    }
    const choices = json.choices as Array<{ delta?: { content?: string } }> | undefined;
    return choices?.[0]?.delta?.content ?? null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    yield* parseSSEDataLines(lines, onPayload, resolved, requestId);
  }
  // flush 尾部 buffer（最后一行可能没有换行符）
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* parseSSEDataLines([buffer], onPayload, resolved, requestId);
  }
}

async function* streamAnthropic(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");

  const turns: { role: string; content: string | AnthropicContentBlock[] }[] = [];
  for (const m of messages.filter((m) => m.role !== "system")) {
    turns.push({ role: m.role, content: await toAnthropicContent(m.content) });
  }

  const anthropicStreamOpts: AICallOptions = { ...opts, timeoutMs: Math.max(opts?.timeoutMs ?? 0, STREAM_TIMEOUT_MS) };
  const resp = await fetchWithResilience(
    joinEndpoint(resolved.baseUrl ?? '', 'v1/messages'),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": resolved.apiKey ?? '',
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: REASONING_LEVELS[opts?.reasoning ?? 'medium'].maxTokens,
        system: system || undefined,
        messages: turns,
        temperature: resolved.temperature,
        stream: true,
      }),
    },
    resolved,
    requestId,
    anthropicStreamOpts,
  );
  if (!resp.body) {
    throw new AIError(
      { code: 'provider_unavailable', provider: resolved.provider, model: resolved.model, requestId, retryable: true },
      `Claude 响应缺少流式 body`,
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onPayload = (json: Record<string, unknown>): string | null => {
    if (json.type === 'message_start') {
      const u = (json.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      if (u?.input_tokens != null) usage.inputTokens = u.input_tokens;
      return null;
    }
    if (json.type === 'message_delta') {
      const u = json.usage as { output_tokens?: number } | undefined;
      if (u?.output_tokens != null) usage.outputTokens = u.output_tokens;
      return null;
    }
    if (json.type === "content_block_delta") {
      const delta = json.delta as { text?: string } | undefined;
      return delta?.text ?? null;
    }
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    yield* parseSSEDataLines(lines, onPayload, resolved, requestId);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* parseSSEDataLines([buffer], onPayload, resolved, requestId);
  }
}
