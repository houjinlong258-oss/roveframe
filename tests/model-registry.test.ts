import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_DEFAULT_REASONING,
  aggregateLedgerStats,
  defaultReasoningForAgent,
  healthOf,
  isNativeReasoningModel,
  rankRoutableProviders,
  resolveReasoningLevel,
  tierForModel,
  type ModelRegistry,
  type RegistryProvider,
} from '../src/lib/ai/model-registry';
import { reasoningParams } from '../src/lib/ai/router';
import type { ResolvedModel } from '../src/lib/ai/router';

function externalModel(provider: string, model: string): ResolvedModel {
  return {
    kind: 'external',
    model,
    temperature: 0.7,
    provider,
    apiKey: 'sk-test-not-a-real-key',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai',
    timeoutMs: 1000,
    maxRetries: 0,
    allowLocal: false,
  };
}

test('tierForModel prefers the low tier so gpt-5-mini is not promoted', () => {
  assert.equal(tierForModel('gpt-5-mini'), 'low');
  assert.equal(tierForModel('claude-haiku-4-5'), 'low');
  assert.equal(tierForModel('gemini-2.5-flash'), 'low');
  assert.equal(tierForModel('doubao-seed-2-0-lite-260215'), 'low');
});

test('tierForModel recognises high-capability families', () => {
  assert.equal(tierForModel('claude-opus-4-1'), 'high');
  assert.equal(tierForModel('claude-sonnet-4-5'), 'high');
  assert.equal(tierForModel('deepseek-reasoner'), 'high');
  assert.equal(tierForModel('gemini-2.5-pro'), 'high');
  assert.equal(tierForModel('doubao-seed-2-0-pro-260215'), 'high');
});

test('tierForModel does not let "mini" inside "gemini" demote a flagship', () => {
  // 回归测试：曾经的 `mini` 无词边界规则把 gemini-2.5-pro 判成 low
  assert.equal(tierForModel('gemini-2.5-pro'), 'high');
  assert.equal(tierForModel('gemini-2.5-flash'), 'low');
  // o3/o4 必须带边界，否则 gpt-4o 会被误判为高能力
  assert.equal(tierForModel('gpt-4o'), 'medium');
  assert.equal(tierForModel('MiniMax-M1'), 'high');
});

test('tierForModel falls back to medium for unknown ids', () => {
  assert.equal(tierForModel('gpt-4o'), 'medium');
  assert.equal(tierForModel('deepseek-chat'), 'medium');
  assert.equal(tierForModel('kimi-k2-0905-preview'), 'medium');
});

test('isNativeReasoningModel only matches ids that reject explicit temperature', () => {
  for (const id of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'deepseek-reasoner']) {
    assert.equal(isNativeReasoningModel(id), true, `${id} should be native reasoning`);
  }
  for (const id of ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'deepseek-chat', 'gemini-2.5-pro']) {
    assert.equal(isNativeReasoningModel(id), false, `${id} should not be native reasoning`);
  }
});

test('reasoningParams never sends temperature to native reasoning models', () => {
  const params = reasoningParams(externalModel('openai', 'o4-mini'), { reasoning: 'high' });
  assert.equal(params.temperature, undefined);
  assert.equal(params.__omitTemperature, true);
  assert.equal(params.max_completion_tokens, 4_096);
  assert.equal(params.reasoning_effort, 'high');
  assert.equal(params.max_tokens, undefined);
});

test('reasoningParams only sends reasoning_effort to providers known to accept it', () => {
  // 同一模型经第三方 OpenAI 兼容端点接入时，绝不带 reasoning_effort，
  // 否则上游 400 会在故障切换链里被误判成「服务商挂了」。
  const thirdParty = reasoningParams(externalModel('deepseek', 'deepseek-reasoner'), {
    reasoning: 'high',
  });
  assert.equal(thirdParty.reasoning_effort, undefined);
  assert.equal(thirdParty.max_completion_tokens, undefined);

  const plain = reasoningParams(externalModel('anthropic', 'claude-sonnet-4-5'), {
    reasoning: 'low',
  });
  assert.equal(plain.max_tokens, 1_200);
  assert.equal(plain.temperature, 0.7);
});

test('reasoning levels are bounded and default to medium', () => {
  assert.equal(resolveReasoningLevel('high'), 'high');
  assert.equal(resolveReasoningLevel('LOW'), 'medium');
  assert.equal(resolveReasoningLevel(undefined), 'medium');
  assert.equal(resolveReasoningLevel('extreme'), 'medium');
});

test('agent defaults give the CEO and CTO high reasoning, COO and CMO medium', () => {
  assert.equal(defaultReasoningForAgent('ceo'), 'high');
  assert.equal(defaultReasoningForAgent('ceo-insight'), 'high');
  assert.equal(defaultReasoningForAgent('operations'), 'medium');
  assert.equal(defaultReasoningForAgent('coo'), 'medium');
  assert.equal(defaultReasoningForAgent('marketing'), 'medium');
  assert.equal(defaultReasoningForAgent('devops'), 'high');
  assert.equal(defaultReasoningForAgent('unknown-agent'), 'medium');
  assert.equal(Object.keys(AGENT_DEFAULT_REASONING).length > 0, true);
});

test('healthOf never reports online without evidence', () => {
  assert.equal(
    healthOf({ configured: false, lastTestOk: null, latencyMs: null, successRate: null, callCount: 0 }),
    'offline',
  );
  assert.equal(
    healthOf({ configured: true, lastTestOk: null, latencyMs: null, successRate: null, callCount: 0 }),
    'unknown',
  );
  assert.equal(
    healthOf({ configured: true, lastTestOk: true, latencyMs: null, successRate: null, callCount: 0 }),
    'online',
  );
});

test('healthOf degrades on real failure rate and latency', () => {
  const base = { configured: true, lastTestOk: true, latencyMs: 800, callCount: 20 };
  assert.equal(healthOf({ ...base, successRate: 0.4 }), 'error');
  assert.equal(healthOf({ ...base, successRate: 0.6 }), 'degraded');
  assert.equal(healthOf({ ...base, successRate: 0.95, latencyMs: 9_000 }), 'slow');
  assert.equal(healthOf({ ...base, successRate: 0.95 }), 'online');
  assert.equal(
    healthOf({ ...base, lastTestOk: false, successRate: 1 }),
    'error',
  );
});

test('aggregateLedgerStats computes p50 latency and success rate per provider', () => {
  const stats = aggregateLedgerStats([
    { provider: 'openai', model: 'gpt-5', status: 'ok', latency_ms: 100 },
    { provider: 'openai', model: 'gpt-5', status: 'ok', latency_ms: 300 },
    { provider: 'openai', model: 'gpt-5', status: 'error', latency_ms: null },
    { provider: 'anthropic', model: 'claude', status: 'ok', latency_ms: 200 },
  ]);
  const openai = stats.get('openai');
  assert.equal(openai?.callCount, 3);
  assert.equal(openai?.latencyMs, 100);
  assert.equal(openai?.successRate, 2 / 3);
  const anthropic = stats.get('anthropic');
  assert.equal(anthropic?.callCount, 1);
  assert.equal(anthropic?.successRate, 1);
});

test('aggregateLedgerStats returns null latency when there is no successful sample', () => {
  const stats = aggregateLedgerStats([
    { provider: 'gemini', model: 'x', status: 'error', latency_ms: null },
  ]);
  assert.equal(stats.get('gemini')?.latencyMs, null);
  assert.equal(stats.get('gemini')?.successRate, 0);
});

function providerFixture(overrides: Partial<RegistryProvider>): RegistryProvider {
  return {
    id: 'p',
    displayName: 'P',
    description: '',
    category: 'us',
    protocol: 'openai_chat',
    runtime: 'native',
    configured: true,
    isEnabled: true,
    hasKey: true,
    baseUrl: null,
    defaultModel: 'm',
    health: 'online',
    latencyMs: 100,
    successRate: 1,
    callCount: 5,
    lastTestedAt: null,
    lastError: null,
    models: [],
    ...overrides,
  };
}

test('rankRoutableProviders orders by health then latency and drops unconfigured ones', () => {
  const registry = {
    providers: [
      providerFixture({ id: 'slow', health: 'slow', latencyMs: 100 }),
      providerFixture({ id: 'fast', health: 'online', latencyMs: 900 }),
      providerFixture({ id: 'faster', health: 'online', latencyMs: 200 }),
      providerFixture({ id: 'off', configured: false, health: 'offline' }),
      providerFixture({ id: 'broken', health: 'error' }),
    ],
    defaultProvider: null,
    defaultModel: null,
    platformFallback: { provider: 'platform' as const, model: 'x', label: 'x' },
    routableProviderIds: [],
    generatedAt: new Date(0).toISOString(),
  } satisfies ModelRegistry;

  assert.deepEqual(
    rankRoutableProviders(registry, 'agent').map((p) => p.id),
    ['faster', 'fast', 'slow', 'broken'],
  );
});
