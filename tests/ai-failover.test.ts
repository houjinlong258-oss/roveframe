import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AllProvidersFailedError, resolveModelChain } from '../src/lib/ai/failover';

/**
 * Phase 15：这三个用例的**前提被修正过**，改动理由记录在此，不做静默修改。
 *
 * 原文断言"平台内置永远可用，因此候选链至少有一个 platform 候选"。
 * 该前提在自部署下不成立：平台内置需要凭据（平台注入的 COZE_API_TOKEN，
 * 或部署方配置的 ROVEFRAME_PLATFORM_LLM_*）。compose 两者都不注入，
 * 于是 `resolvePlatformModel()` 现在返回 `null` 表示"该候选不可用"。
 *
 * 为什么是返回 null 而不是抛错：链的职责是收集全部失败原因并汇报
 * （AllProvidersFailedError）。让一个不可用的候选抛错，会把其余 provider 的
 * 失败信息一起吞掉 —— 这正是调用方需要看到的东西。
 *
 * 因此本文件断言的是**结构**：平台可用时它是最后一级兜底；
 * 不可用时它进 skipped(not_configured)，候选链为空但**不抛错**。
 */

test('without a business scope the chain degrades to the platform model only', async () => {
  // 平台级 scope 不允许读取任何租户配置（防跨租户凭据滥用），
  // 因此候选池里只可能有平台内置这一项，且不触碰数据库。
  const chain = await resolveModelChain('agent', null, null);
  assert.equal(chain.registry.defaultProvider, null);
  // 平台可用 ⇒ 唯一候选就是它；不可用 ⇒ 没有候选，但原因必须被记录。
  if (chain.candidates.length > 0) {
    assert.equal(chain.candidates.length, 1);
    assert.equal(chain.candidates[0].provider, 'platform');
    assert.equal(chain.candidates[0].source, 'platform');
  } else {
    assert.ok(
      chain.skipped.some((s) => s.provider === 'platform'),
      '没有候选时，平台必须以 skipped 的形式给出原因',
    );
  }
});

test('an explicit preference for an unconfigured provider is skipped, not fatal', async () => {
  const chain = await resolveModelChain('agent', null, {
    provider: 'openai',
    model: 'gpt-5',
  });
  // 未接入的 provider 必须进 skipped，而不是中断解析。
  assert.deepEqual(
    chain.skipped.filter((s) => s.provider === 'openai'),
    [{ provider: 'openai', model: 'gpt-5', reason: 'not_configured' }],
  );
});

test('the platform candidate, when available, is always last', async () => {
  process.env.COZE_API_TOKEN = 'platform-token-for-ordering-test';
  try {
    const chain = await resolveModelChain('agent', null, null);
    assert.ok(chain.candidates.length > 0, '有平台凭据时应当至少有一个候选');
    const last = chain.candidates[chain.candidates.length - 1];
    assert.equal(last.kind, 'platform');
  } finally {
    delete process.env.COZE_API_TOKEN;
  }
});

test('AllProvidersFailedError surfaces every provider reason without leaking keys', () => {
  const error = new AllProvidersFailedError(
    [
      {
        provider: 'openai',
        model: 'gpt-5',
        label: 'gpt-5',
        code: 'provider_timeout',
        message: 'openai timeout',
        status: null,
        latencyMs: 60_000,
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        label: 'claude-sonnet-4-5',
        code: 'provider_rate_limited',
        message: 'claude 429',
        status: 429,
        latencyMs: 120,
      },
    ],
    'agent',
    'req-1',
  );

  const event = error.toEvent();
  assert.equal(event.type, 'all_providers_failed');
  assert.equal(event.providersTried, 2);
  assert.equal(event.attempts.length, 2);
  assert.equal(event.attempts[0].code, 'provider_timeout');
  assert.equal(event.attempts[1].status, 429);
  assert.match(error.message, /Tried 2 provider/);
  assert.doesNotMatch(JSON.stringify(event), /sk-|Bearer /);
});

test('the chat route streams a typed SSE stream and never leaks the raw provider secret', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/api/agent/chat/route.ts'),
    'utf8',
  );
  // 契约：类型化事件 + 全失败结构化上报 + 兼容旧 {text} 客户端
  assert.match(source, /type: 'delta', text:/);
  assert.match(source, /type: 'artifact'/);
  assert.match(source, /type: 'provider'/);
  assert.match(source, /type: 'status'/);
  assert.match(source, /all_providers_failed/);
  // 流内异常也必须转成事件，而不是让连接无声断掉
  assert.match(source, /sseErrorEvent/);
  // 并发额度必须在流结束时释放（含异常路径）
  assert.match(source, /acquireSlot\(/);
  assert.match(source, /slot\?\.release\(\)/);
});

test('failover never switches providers after text has already been streamed', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/ai/failover.ts'), 'utf8');
  // emitted 一旦为 true 就直接抛错，绝不 yield 下一家的内容（否则答案错乱）
  assert.match(source, /if \(emitted\) \{/);
  assert.match(source, /failovers: attempts\.length/);
});
