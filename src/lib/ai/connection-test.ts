/**
 * Provider 连接测试与模型发现（服务端专用，密钥不出服务端）。
 * 没有真实凭据的协议（declared）返回结构化“未验收”，不伪造成功。
 */

import { getCatalogEntry, runtimeProtocolOf } from '@/lib/ai/provider-catalog';
import { joinEndpoint, checkBaseUrl } from '@/lib/ai/url-utils';
import { sanitizeProviderMessage } from '@/lib/ai/errors';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[] | null;
  error: string | null; // 已脱敏
}

export interface ConnectionTestInput {
  provider: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  timeoutMs?: number;
  allowLocal?: boolean;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: resp.status, body };
}

function extractOpenAIModels(body: unknown): string[] | null {
  const data = (body as { data?: Array<{ id?: string }> } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => m.id).filter((id): id is string => typeof id === 'string').slice(0, 200);
}

function extractAnthropicModels(body: unknown): string[] | null {
  const data = (body as { data?: Array<{ id?: string }> } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => m.id).filter((id): id is string => typeof id === 'string').slice(0, 200);
}

export async function testProviderConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const fail = (error: string): ConnectionTestResult => ({
    ok: false,
    latencyMs: Date.now() - startedAt,
    models: null,
    error: sanitizeProviderMessage(error),
  });

  const entry = getCatalogEntry(input.provider);
  const protocol = entry ? runtimeProtocolOf(entry) : 'openai';
  if (!protocol) {
    return fail(`provider ${input.provider} 的 adapter 已声明但尚未通过真实验收`);
  }

  const baseUrl = input.baseUrl || entry?.defaultBaseUrl || '';
  const check = checkBaseUrl(baseUrl, { allowLocal: input.allowLocal });
  if (!check.ok) return fail(`base URL 未通过安全校验: ${check.reason}`);

  const timeoutMs = input.timeoutMs ?? 15000;
  const model = input.model || entry?.models[0]?.id || 'gpt-4o-mini';

  try {
    if (protocol === 'anthropic') {
      // 先尝试模型列表，再退回最小 messages 调用
      try {
        const list = await fetchJson(joinEndpoint(baseUrl, 'v1/models'), {
          headers: { 'x-api-key': input.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        }, timeoutMs);
        if (list.status >= 200 && list.status < 300) {
          return { ok: true, latencyMs: Date.now() - startedAt, models: extractAnthropicModels(list.body), error: null };
        }
      } catch {
        // 继续 messages 探测
      }
      const probe = await fetchJson(joinEndpoint(baseUrl, 'v1/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': input.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }, timeoutMs);
      if (probe.status >= 200 && probe.status < 300) {
        return { ok: true, latencyMs: Date.now() - startedAt, models: null, error: null };
      }
      return fail(`Anthropic 连接测试失败 (${probe.status}): ${JSON.stringify(probe.body)}`);
    }

    // OpenAI 兼容协议：优先 /models，失败时退回最小 chat 调用
    try {
      const list = await fetchJson(joinEndpoint(baseUrl, 'models'), {
        headers: { Authorization: `Bearer ${input.apiKey ?? ''}` },
      }, timeoutMs);
      if (list.status >= 200 && list.status < 300) {
        return { ok: true, latencyMs: Date.now() - startedAt, models: extractOpenAIModels(list.body), error: null };
      }
      if (list.status === 401 || list.status === 403) {
        return fail(`认证失败 (${list.status})`);
      }
    } catch {
      // 端点可能不支持 /models，继续 chat 探测
    }
    const probe = await fetchJson(joinEndpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey ?? ''}` },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    }, timeoutMs);
    if (probe.status >= 200 && probe.status < 300) {
      return { ok: true, latencyMs: Date.now() - startedAt, models: null, error: null };
    }
    return fail(`连接测试失败 (${probe.status}): ${JSON.stringify(probe.body)}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
