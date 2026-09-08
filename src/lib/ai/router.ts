import { LLMClient, Config } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { decrypt } from "@/lib/crypto";
import { AUTO_ROUTE, PROVIDER_PRESETS, type Capability } from "@/lib/ai/providers";
import { getCatalogEntry, runtimeProtocolOf } from "@/lib/ai/provider-catalog";
import { AIError, classifyHTTPError } from "@/lib/ai/errors";
import { joinEndpoint, checkBaseUrl } from "@/lib/ai/url-utils";
import { recordAIUsage } from "@/lib/ai/usage-ledger";

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

export interface AICallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  /** 用量账本中的 agent 标记（如 ceo/operations/scheduler/daily-brief） */
  agent?: string;
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
const DEFAULT_MAX_RETRIES = 2;

/** 把多模态 content 降级为纯文本（提取 text 块），用于平台内置模型的兜底 */
function textOf(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n");
}

/** 从 URL 或 data URL 拿到 base64 图片数据（Anthropic 图片协议要求 base64） */
async function imageToBase64(url: string): Promise<{ media_type: string; data: string }> {
  const dataMatch = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (dataMatch) {
    return { media_type: dataMatch[1], data: dataMatch[2].replace(/\s/g, "") };
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`图片拉取失败 (${resp.status})`);
  const mediaType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
  const data = Buffer.from(await resp.arrayBuffer()).toString("base64");
  return { media_type: mediaType, data };
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
  tenant_id?: string;
  business_id?: string | null;
  timeout_ms?: number | null;
  max_retries?: number | null;
}

interface Resolution {
  resolved: ResolvedModel;
  diagnostics: AIRouteDiagnostics;
}

function platformResolution(capability: Capability, requestId: string, usedFallback: boolean, fallbackReason: string | null): Resolution {
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
 * 解析某能力应使用的模型。
 * 选择顺序：business 显式配置 → tenant 默认配置 → 平台内置（可见 fallback）。
 * 配置存在但不可用（SSRF 拒绝、adapter 未验收）时抛结构化错误，
 * 不静默切换到平台模型。
 */
async function resolveModelDetailed(capability: Capability, scope?: AIRequestScope): Promise<Resolution> {
  const requestId = scope?.requestId ?? crypto.randomUUID();
  if (scope && !scope.businessId) {
    throw new Error('business scope is required for model resolution');
  }
  const client = getSupabaseClient();
  let settingsQuery = client.from("settings").select("model_assign");
  if (scope) {
    settingsQuery = settingsQuery
      .eq("tenant_id", scope.tenantId)
      .eq("business_id", scope.businessId);
  }
  const { data: settingsRows, error: sErr } = await settingsQuery.limit(1);
  if (sErr) throw new Error(`读取设置失败: ${sErr.message}`);
  const assign = (settingsRows?.[0]?.model_assign ?? {}) as Record<string, string>;
  const target = assign[capability] ?? "auto";

  if (target === "auto" || !target.includes(":")) {
    return platformResolution(capability, requestId, false, null);
  }

  const [rawProvider, model] = target.split(":");
  const provider = PROVIDER_ALIAS[rawProvider] ?? rawProvider;
  const catalog = getCatalogEntry(provider);

  let configQuery = client
    .from("model_configs")
    .select("*")
    .eq("provider", rawProvider)
    .eq("is_enabled", true);
  if (scope) {
    configQuery = configQuery
      .eq("tenant_id", scope.tenantId)
      .eq("business_id", scope.businessId);
  }
  const { data: cfgRows, error: cErr } = await configQuery;
  if (cErr) throw new Error(`读取模型配置失败: ${cErr.message}`);

  const rows = (cfgRows ?? []) as ModelConfigRow[];
  const cfg = rows[0];

  const needsKey = catalog ? catalog.authType === "api_key" || catalog.authType === "oauth" : true;
  if (!cfg || (needsKey && !cfg.api_key_encrypted)) {
    // 配置了分配但服务商未接入 → 可见地回落平台内置
    return platformResolution(capability, requestId, true, "provider_not_configured");
  }

  const baseUrl = cfg.base_url || catalog?.defaultBaseUrl || PROVIDER_PRESETS[rawProvider]?.baseUrl || "";
  const allowLocal = catalog?.category === "local" || catalog?.authType === "local";
  const urlCheck = checkBaseUrl(baseUrl, { allowLocal });
  if (!urlCheck.ok) {
    throw new AIError(
      { code: "ssrf_blocked", provider, model: model ?? undefined, requestId, retryable: false },
      `base URL 未通过安全校验 (${urlCheck.reason})`,
    );
  }

  const protocol = catalog ? runtimeProtocolOf(catalog) : (PROVIDER_PRESETS[rawProvider]?.protocol ?? "openai");
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
      model: model || cfg.default_model || catalog?.models[0]?.id || PROVIDER_PRESETS[rawProvider]?.models[0] || "",
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

/** 组合超时与调用方取消信号 */
function composeSignal(resolved: ResolvedModel, opts?: AICallOptions): AbortSignal {
  const timeoutMs = opts?.timeoutMs ?? resolved.timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  return opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
}

/**
 * 有界重试的外部 fetch：仅对 429/5xx/网络错误重试（maxRetries 次，指数退避），
 * 4xx 不重试。最终失败抛结构化 AIError（脱敏）。
 * 导出仅供契约测试使用。
 */
export async function fetchWithResilience(
  url: string,
  init: RequestInit,
  resolved: ResolvedModel,
  requestId: string,
  opts?: AICallOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? resolved.maxRetries;
  let lastError: AIError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
    try {
      const resp = await fetch(url, { ...init, signal: composeSignal(resolved, opts) });
      if (resp.ok) return resp;
      const { code, retryable } = classifyHTTPError(resp.status);
      const body = await resp.text().catch(() => "");
      lastError = new AIError(
        { code, provider: resolved.provider, model: resolved.model, status: resp.status, requestId, retryable },
        `${resolved.provider} 调用失败 (${resp.status}): ${body}`,
      );
      if (!retryable) throw lastError;
    } catch (err) {
      if (err instanceof AIError && !err.retryable) throw err;
      if (err instanceof AIError) {
        lastError = err;
        continue;
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
  throw lastError ?? new AIError(
    { code: "provider_unavailable", provider: resolved.provider, model: resolved.model, requestId, retryable: false },
    "provider 调用失败",
  );
}

interface UsageCapture {
  inputTokens: number | null;
  outputTokens: number | null;
}

async function trackUsage(
  diagnostics: AIRouteDiagnostics,
  scope: AIRequestScope | undefined,
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

/** 流式对话：平台内置走 LLMClient，外部服务商按协议直连，统一产出文本增量 */
export async function* streamChat(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders?: Record<string, string>,
  scope?: AIRequestScope,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  const startedAt = Date.now();
  const { resolved, diagnostics } = await resolveModelDetailed(capability, scope);
  const usage: UsageCapture = { inputTokens: null, outputTokens: null };
  let status: "ok" | "error" = "ok";
  let errorCode: string | null = null;

  try {
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
    yield* streamExternal(resolved, messages, diagnostics.requestId, usage, opts);
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
  scope?: AIRequestScope,
  opts?: AICallOptions,
): Promise<string> {
  let result = "";
  for await (const chunk of streamChat(capability, messages, forwardHeaders, scope, opts)) {
    result += chunk;
  }
  return result;
}

/** 诊断当前路由决策（设置页展示“实际使用的 provider/model/fallback”），不发起模型调用 */
export async function peekAIRoute(capability: Capability, scope?: AIRequestScope): Promise<AIRouteDiagnostics> {
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
  scope?: AIRequestScope,
  opts?: AICallOptions,
): Promise<AIToolDecision> {
  if (tools.length === 0) return { supported: true, text: '', toolCalls: [] };
  const startedAt = Date.now();
  const { resolved, diagnostics } = await resolveModelDetailed(capability, scope);
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

async function* streamOpenAICompatible(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  requestId: string,
  usage: UsageCapture,
  opts?: AICallOptions,
): AsyncGenerator<string> {
  const resp = await fetchWithResilience(
    joinEndpoint(resolved.baseUrl ?? '', 'chat/completions'),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey ?? ''}` },
      body: JSON.stringify({
        model: resolved.model,
        messages,
        temperature: resolved.temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
    },
    resolved,
    requestId,
    opts,
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
        max_tokens: 4096,
        system: system || undefined,
        messages: turns,
        temperature: resolved.temperature,
        stream: true,
      }),
    },
    resolved,
    requestId,
    opts,
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
