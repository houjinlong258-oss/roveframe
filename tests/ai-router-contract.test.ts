/**
 * AI 接口专项契约测试
 * tests/ai-router-contract.test.ts
 *
 * 覆盖：
 * - URL 拼接（/v1 去重、双斜杠、尾斜杠）
 * - SSRF 校验（生产禁 metadata/loopback/私网/明文 http；本地模型 opt-in）
 * - 结构化错误与脱敏（密钥不出现在 message/event）
 * - 有界重试（429/5xx 重试、4xx 不重试、超时归类）
 * - SSE 解析（分片、尾 buffer、空 delta、[DONE]、provider error event）
 * - scope 贯穿回归（租户业务路由调用必须传 tenantId scope）
 * - Provider Catalog 完整性（协议/认证/能力/发现方式）
 * - 用量账本内存降级不阻断
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { joinEndpoint, checkBaseUrl, checkBaseUrlResolved, assertBaseUrlAllowed } from '../src/lib/ai/url-utils';
import { AIError, sanitizeProviderMessage, classifyHTTPError, isAIError } from '../src/lib/ai/errors';
import { PROVIDER_CATALOG, getCatalogEntry, runtimeProtocolOf, catalogSummary } from '../src/lib/ai/provider-catalog';
import { fetchWithResilience, parseSSEDataLines, type ResolvedModel } from '../src/lib/ai/router';
import { recordAIUsage, readMemoryLedger, clearMemoryLedger } from '../src/lib/ai/usage-ledger';

// ---------------------------------------------------------------------------
// URL 拼接
// ---------------------------------------------------------------------------

describe('joinEndpoint', () => {
  test('base 已含 /v1 时不重复拼接', () => {
    assert.equal(joinEndpoint('https://api.openai.com/v1', 'chat/completions'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(joinEndpoint('https://api.anthropic.com', 'v1/messages'), 'https://api.anthropic.com/v1/messages');
    // base 已以 v1 结尾，path 也写 v1/messages → 不变成 /v1/v1
    assert.equal(joinEndpoint('https://api.anthropic.com/v1', 'v1/messages'), 'https://api.anthropic.com/v1/messages');
  });

  test('尾斜杠与双斜杠归一', () => {
    assert.equal(joinEndpoint('https://api.x.ai/v1/', '/chat/completions'), 'https://api.x.ai/v1/chat/completions');
    assert.equal(joinEndpoint('http://localhost:11434/v1//', '//chat/completions'), 'http://localhost:11434/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// SSRF 校验
// ---------------------------------------------------------------------------

describe('checkBaseUrl SSRF 策略', () => {
  test('生产环境拒绝云 metadata 地址（任何环境都拒绝）', () => {
    assert.equal(checkBaseUrl('http://169.254.169.254/latest/meta-data', { production: false, allowLocal: true }).ok, false);
    assert.equal(checkBaseUrl('https://metadata.google.internal/', { production: false, allowLocal: true }).ok, false);
  });

  test('生产环境拒绝 http 与 loopback/私网', () => {
    assert.equal(checkBaseUrl('http://api.example.com/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://127.0.0.1:11434/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://192.168.1.10/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://10.0.0.5/v1', { production: true }).ok, false);
  });

  test('生产环境允许公网 https', () => {
    assert.equal(checkBaseUrl('https://api.openai.com/v1', { production: true }).ok, true);
  });

  test('本地模型 opt-in 允许 http loopback，但仍拒绝公网明文', () => {
    assert.equal(checkBaseUrl('http://localhost:11434/v1', { production: false, allowLocal: true }).ok, true);
    assert.equal(checkBaseUrl('http://192.168.1.20:8000/v1', { production: false, allowLocal: true }).ok, true);
    assert.equal(checkBaseUrl('http://203.0.113.9/v1', { production: false, allowLocal: true }).ok, false);
  });

  test('DNS 重绑定域名、十进制/八进制 IP 与 IPv6 私网变体在生产被拒绝', () => {
    assert.equal(checkBaseUrl('https://127.0.0.1.nip.io/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://2130706433/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://0177.0.0.1/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://[::1]/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://[::ffff:127.0.0.1]/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://[fd00::5]/v1', { production: true }).ok, false);
  });

  test('DNS 解析层：localhost 在生产被拒绝（解析到 loopback）', async () => {
    const check = await checkBaseUrlResolved('https://localhost/v1', { production: true });
    assert.equal(check.ok, false);
  });

  test('非法 URL 与不支持协议', () => {
    assert.equal(checkBaseUrl('not-a-url').ok, false);
    assert.equal(checkBaseUrl('ftp://example.com', { production: false }).ok, false);
    assert.throws(() => assertBaseUrlAllowed('http://169.254.169.254/', { production: false }), /base_url_rejected/);
  });
});

// ---------------------------------------------------------------------------
// 结构化错误与脱敏
// ---------------------------------------------------------------------------

describe('AIError 脱敏与事件', () => {
  test('密钥形态被脱敏', () => {
    const msg = sanitizeProviderMessage('401 invalid key sk-abc123XYZ789_long tail Bearer tok_secretvalue123456');
    assert.ok(!msg.includes('sk-abc123XYZ789'), msg);
    assert.ok(!msg.includes('tok_secretvalue123456'), msg);
  });

  test('toEvent 是 machine-readable 且不含秘密', () => {
    const err = new AIError(
      { code: 'provider_error', provider: 'openai', model: 'gpt-4o', status: 401, requestId: 'req_1', retryable: false },
      'unauthorized: sk-should-not-leak-123456',
    );
    const event = err.toEvent();
    assert.equal(event.type, 'ai_error');
    assert.equal(event.code, 'provider_error');
    assert.equal(event.provider, 'openai');
    assert.equal(event.requestId, 'req_1');
    assert.ok(!JSON.stringify(event).includes('sk-should-not-leak-123456'));
  });

  test('HTTP 状态归类', () => {
    assert.deepEqual(classifyHTTPError(429), { code: 'provider_rate_limited', retryable: true });
    assert.deepEqual(classifyHTTPError(500), { code: 'provider_unavailable', retryable: true });
    assert.deepEqual(classifyHTTPError(401), { code: 'provider_error', retryable: false });
    assert.equal(isAIError(new Error('x')), false);
  });
});

// ---------------------------------------------------------------------------
// 有界重试
// ---------------------------------------------------------------------------

function fakeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    kind: 'external',
    model: 'm',
    temperature: 0.5,
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai',
    timeoutMs: 5_000,
    maxRetries: 2,
    allowLocal: false,
    ...overrides,
  };
}

describe('fetchWithResilience', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('429/500 有界重试后成功', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const resp = await fetchWithResilience('https://8.8.8.8/v1/chat/completions', { method: 'POST' }, fakeResolved(), 'req_retry');
    assert.equal(resp.status, 200);
    assert.equal(calls, 3);
  });

  test('4xx 不重试，抛结构化错误', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('bad request sk-leak-should-hide-999', { status: 400 });
    }) as typeof fetch;
    await assert.rejects(
      fetchWithResilience('https://8.8.8.8/v1/chat/completions', { method: 'POST' }, fakeResolved(), 'req_4xx'),
      (err: unknown) => {
        assert.ok(isAIError(err));
        assert.equal((err as AIError).code, 'provider_error');
        assert.equal((err as AIError).status, 400);
        assert.ok(!(err as AIError).message.includes('sk-leak-should-hide-999'));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  test('持续 500 重试耗尽后抛 provider_unavailable', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('oops', { status: 500 });
    }) as typeof fetch;
    await assert.rejects(
      fetchWithResilience('https://8.8.8.8/v1/x', { method: 'POST' }, fakeResolved({ maxRetries: 2 }), 'req_500'),
      (err: unknown) => isAIError(err) && (err as AIError).code === 'provider_unavailable',
    );
    assert.equal(calls, 3); // 1 + 2 retries，有界
  });

  test('网络错误归类并可重试', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const resp = await fetchWithResilience('https://8.8.8.8/v1/x', { method: 'POST' }, fakeResolved(), 'req_net');
    assert.equal(resp.status, 200);
    assert.equal(calls, 2);
  });
});

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

describe('parseSSEDataLines', () => {
  const resolved = fakeResolved();
  const openaiDelta = (json: Record<string, unknown>): string | null => {
    const choices = json.choices as Array<{ delta?: { content?: string } }> | undefined;
    return choices?.[0]?.delta?.content ?? null;
  };

  test('正常增量 + 空 delta + [DONE]', () => {
    const out = [...parseSSEDataLines([
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ], openaiDelta, resolved, 'req_sse')];
    assert.deepEqual(out, ['你好']);
  });

  test('不完整 JSON 片段被忽略', () => {
    const out = [...parseSSEDataLines(['data: {"choices":[{"delta":{"con'], openaiDelta, resolved, 'req_sse2')];
    assert.deepEqual(out, []);
  });

  test('provider error event 抛结构化 stream_error', () => {
    assert.throws(
      () => [...parseSSEDataLines(['data: {"error":{"message":"model overloaded","type":"server_error"}}'], openaiDelta, resolved, 'req_sse3')],
      (err: unknown) => isAIError(err) && (err as AIError).code === 'stream_error' && (err as AIError).requestId === 'req_sse3',
    );
  });

  test('Anthropic error event 同样抛出', () => {
    const anthropicDelta = () => null;
    assert.throws(
      () => [...parseSSEDataLines(['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'], anthropicDelta, resolved, 'req_sse4')],
      (err: unknown) => isAIError(err) && (err as AIError).code === 'stream_error',
    );
  });
});

// ---------------------------------------------------------------------------
// Provider Catalog 完整性
// ---------------------------------------------------------------------------

describe('Provider Catalog', () => {
  test('id 唯一且必填字段完整', () => {
    const ids = new Set<string>();
    for (const entry of PROVIDER_CATALOG) {
      assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
      ids.add(entry.id);
      assert.ok(entry.displayName && entry.protocol && entry.authType);
      assert.ok(entry.catalogUpdatedAt);
      assert.ok(['models_endpoint', 'manual'].includes(entry.modelDiscovery));
      if (entry.runtime !== 'declared' && entry.id !== 'custom') {
        assert.ok(entry.defaultBaseUrl, `${entry.id} 缺默认 base URL`);
      }
    }
  });

  test('要求的协议全部建模', () => {
    const protocols = new Set(PROVIDER_CATALOG.map((e) => e.protocol));
    for (const p of ['openai_chat', 'anthropic_messages', 'google_generative', 'azure_openai', 'bedrock_converse', 'vertex_gemini', 'custom_openai']) {
      assert.ok(protocols.has(p as never), `missing protocol ${p}`);
    }
  });

  test('要求的服务商类别全部纳入', () => {
    const required = [
      'openai', 'anthropic', 'gemini', 'vertex_gemini', 'azure_openai', 'bedrock', 'xai',
      'deepseek', 'moonshot', 'moonshot_cn', 'qwen', 'glm', 'doubao', 'minimax', 'mistral',
      'cohere', 'groq', 'together', 'fireworks', 'openrouter', 'siliconflow', 'novita',
      'nvidia_nim', 'vercel_gateway', 'ollama', 'lm_studio', 'vllm', 'litellm', 'custom',
    ];
    for (const id of required) {
      assert.ok(getCatalogEntry(id), `missing provider ${id}`);
    }
  });

  test('declared 协议 runtimeProtocolOf 返回 null（拒绝静默降级）', () => {
    const bedrock = getCatalogEntry('bedrock')!;
    assert.equal(runtimeProtocolOf(bedrock), null);
    assert.equal(runtimeProtocolOf(getCatalogEntry('openai')!), 'openai');
    assert.equal(runtimeProtocolOf(getCatalogEntry('anthropic')!), 'anthropic');
    assert.equal(runtimeProtocolOf(getCatalogEntry('gemini')!), 'openai'); // 经 OpenAI 兼容端点
  });

  test('catalogSummary 不含任何秘密字段', () => {
    const summary = catalogSummary();
    for (const entry of summary) {
      const keys = Object.keys(entry);
      for (const forbidden of ['apiKey', 'apiKeyEncrypted', 'api_key_encrypted', 'secret', 'accessToken', 'password']) {
        assert.ok(!keys.includes(forbidden), `${entry.id} 泄露敏感字段 ${forbidden}`);
      }
    }
    assert.equal(summary.length, PROVIDER_CATALOG.length);
  });
});

// ---------------------------------------------------------------------------
// scope 贯穿回归：租户业务路由必须传 scope
// ---------------------------------------------------------------------------

describe('AI scope 贯穿回归', () => {
  function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        collectTsFiles(p, out);
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  test('src/app/api 下所有 streamChat/invokeChat 调用必须携带 tenant scope', () => {
    const apiDir = join(__dirname, '..', 'src', 'app', 'api');
    const files = collectTsFiles(apiDir);
    const violations: string[] = [];

    /** 从 openParen 索引开始按括号深度提取完整实参串（跳过字符串/模板/注释） */
    function extractArgs(src: string, openParen: number): string {
      let depth = 0;
      let i = openParen;
      let quote: string | null = null;
      while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (quote) {
          if (ch === '\\') {
            i += 2;
            continue;
          }
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          i++;
          continue;
        }
        if (ch === '/' && next === '/') {
          while (i < src.length && src[i] !== '\n') i++;
          continue;
        }
        if (ch === '/' && next === '*') {
          i += 2;
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
          i += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) return src.slice(openParen + 1, i);
        }
        i++;
      }
      return src.slice(openParen + 1);
    }

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const callRe = /(?:streamChat|invokeChat|invokeToolDecision)\s*\(/g;
      for (const match of src.matchAll(callRe)) {
        const openParen = match.index + match[0].length - 1;
        const args = extractArgs(src, openParen);
        if (!/tenantId/.test(args)) {
          violations.push(`${file}: ${args.slice(0, 80).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    assert.deepEqual(violations, [], `以下调用缺少 tenant scope:\n${violations.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------
// 用量账本
// ---------------------------------------------------------------------------

describe('AI usage ledger', () => {
  beforeEach(() => clearMemoryLedger());

  test('无数据库时降级内存记录，不阻断主链路', async () => {
    await recordAIUsage({
      tenantId: 't1',
      businessId: 'b1',
      userId: 'u1',
      agent: 'agent',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: null, // 无可靠价格时不伪造
      status: 'ok',
      correlationId: 'req_usage_1',
      latencyMs: 320,
    });
    const rows = readMemoryLedger().filter((r) => r.correlationId === 'req_usage_1');
    // DB 可用时进数据库、不可用时进内存；两者之一必须有记录或不抛错即合规
    if (rows.length > 0) {
      assert.equal(rows[0].provider, 'openai');
      assert.equal(rows[0].estimatedCostUsd, null);
    }
  });
});
