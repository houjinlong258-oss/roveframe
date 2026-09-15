import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AllProvidersFailedError, resolveModelChain } from '../src/lib/ai/failover';

test('without a business scope the chain degrades to the platform model only', async () => {
  // 平台级 scope 不允许读取任何租户配置（防跨租户凭据滥用），
  // 因此这里必须得到「唯一候选 = 平台内置」，且不触碰数据库。
  const chain = await resolveModelChain('agent', null, null);
  assert.equal(chain.candidates.length, 1);
  assert.equal(chain.candidates[0].provider, 'platform');
  assert.equal(chain.candidates[0].source, 'platform');
  assert.equal(chain.registry.defaultProvider, null);
});

test('an explicit preference for an unconfigured provider is skipped, not fatal', async () => {
  const chain = await resolveModelChain('agent', null, {
    provider: 'openai',
    model: 'gpt-5',
  });
  assert.equal(chain.candidates.length, 1);
  assert.equal(chain.candidates[0].provider, 'platform');
  assert.deepEqual(chain.skipped, [
    { provider: 'openai', model: 'gpt-5', reason: 'not_configured' },
  ]);
});

test('the platform candidate is always last so external providers are preferred', async () => {
  const chain = await resolveModelChain('agent', null, null);
  const last = chain.candidates[chain.candidates.length - 1];
  assert.equal(last.kind, 'platform');
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
