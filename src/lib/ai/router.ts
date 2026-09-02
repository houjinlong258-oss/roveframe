import { LLMClient, Config } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { decrypt } from "@/lib/crypto";
import { AUTO_ROUTE, PROVIDER_PRESETS, type Capability } from "@/lib/ai/providers";

/** 多模态内容块：text + image_url（url 可为 data URL 或 http(s) 地址） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

interface ResolvedModel {
  kind: "platform" | "external";
  model: string;
  temperature: number;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: "anthropic" | "openai";
}

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

/** 解析某能力应使用的模型：auto → 平台内置按复杂度分流；指定 provider:model → 走用户接入的服务商 */
async function resolveModel(capability: Capability): Promise<ResolvedModel> {
  const client = getSupabaseClient();
  const { data: settingsRows, error: sErr } = await client.from("settings").select("model_assign").limit(1);
  if (sErr) throw new Error(`读取设置失败: ${sErr.message}`);
  const assign = (settingsRows?.[0]?.model_assign ?? {}) as Record<string, string>;
  const target = assign[capability] ?? "auto";

  const auto = AUTO_ROUTE[capability];
  if (target === "auto" || !target.includes(":")) {
    return { kind: "platform", model: auto.model, temperature: auto.temperature };
  }

  const [provider, model] = target.split(":");
  const { data: cfgRows, error: cErr } = await client
    .from("model_configs")
    .select("provider, api_key_encrypted, base_url, default_model, is_enabled")
    .eq("provider", provider)
    .eq("is_enabled", true)
    .limit(1);
  if (cErr) throw new Error(`读取模型配置失败: ${cErr.message}`);

  const cfg = cfgRows?.[0];
  if (!cfg?.api_key_encrypted) {
    // 配置了分配但服务商不可用 → 回落平台内置
    return { kind: "platform", model: auto.model, temperature: auto.temperature };
  }

  return {
    kind: "external",
    model: model || cfg.default_model || PROVIDER_PRESETS[provider]?.models[0] || "",
    temperature: auto.temperature,
    provider,
    apiKey: decrypt(cfg.api_key_encrypted),
    baseUrl: cfg.base_url || PROVIDER_PRESETS[provider]?.baseUrl || "",
    protocol: PROVIDER_PRESETS[provider]?.protocol ?? "openai",
  };
}

/** 流式对话：平台内置走 LLMClient，外部服务商按协议直连，统一产出文本增量 */
export async function* streamChat(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders?: Record<string, string>
): AsyncGenerator<string> {
  const resolved = await resolveModel(capability);

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

  yield* streamExternal(resolved, messages);
}

/** 非流式调用：用于分类、评分等轻量任务 */
export async function invokeChat(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders?: Record<string, string>
): Promise<string> {
  let result = "";
  for await (const chunk of streamChat(capability, messages, forwardHeaders)) {
    result += chunk;
  }
  return result;
}

async function* streamExternal(resolved: ResolvedModel, messages: ChatMessage[]): AsyncGenerator<string> {
  if (resolved.protocol === "anthropic") {
    yield* streamAnthropic(resolved, messages);
    return;
  }
  yield* streamOpenAICompatible(resolved, messages);
}

async function* streamOpenAICompatible(resolved: ResolvedModel, messages: ChatMessage[]): AsyncGenerator<string> {
  const resp = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
    body: JSON.stringify({ model: resolved.model, messages, temperature: resolved.temperature, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`${resolved.provider} 调用失败 (${resp.status}): ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
      try {
        const json = JSON.parse(trimmed.slice(5));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        // 忽略不完整的 SSE 片段
      }
    }
  }
}

async function* streamAnthropic(resolved: ResolvedModel, messages: ChatMessage[]): AsyncGenerator<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");

  const turns: { role: string; content: string | AnthropicContentBlock[] }[] = [];
  for (const m of messages.filter((m) => m.role !== "system")) {
    turns.push({ role: m.role, content: await toAnthropicContent(m.content) });
  }

  const resp = await fetch(`${resolved.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": resolved.apiKey ?? "",
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
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Claude 调用失败 (${resp.status}): ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const json = JSON.parse(trimmed.slice(5));
        if (json.type === "content_block_delta" && json.delta?.text) yield json.delta.text as string;
      } catch {
        // 忽略不完整的 SSE 片段
      }
    }
  }
}