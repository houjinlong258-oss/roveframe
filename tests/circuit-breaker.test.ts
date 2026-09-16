import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/lib/ai/circuit-breaker';
import { retryDelayMs, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from '../src/lib/ai/router';

/**
 * Phase 12 / P1-7 —— 熔断与退避抖动。
 *
 * 熔断器保护的是「一个已宕机的 provider 不会让每个请求都付满重试预算」。
 * 这类失效是延迟/负载性质的，不会表现为功能报错，因此必须显式断言状态机。
 * 时钟通过构造参数注入，测试因此是确定性的（不 sleep）。
 */
describe('provider circuit breaker (P1-7)', () => {
  function makeBreaker(overrides: { failureThreshold?: number; cooldownMs?: number } = {}) {
    let clock = 1_000;
    const breaker = new CircuitBreaker({
      failureThreshold: overrides.failureThreshold ?? 5,
      cooldownMs: overrides.cooldownMs ?? 30_000,
      now: () => clock,
    });
    return { breaker, advance: (ms: number) => { clock += ms; } };
  }

  test('starts closed and allows attempts', () => {
    const { breaker } = makeBreaker();
    assert.equal(breaker.canAttempt('openai').allowed, true);
    assert.equal(breaker.snapshot('openai').state, 'closed');
  });

  test('opens only after the failure threshold is reached', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    assert.equal(breaker.canAttempt('openai').allowed, true, '未达阈值不得熔断');
    breaker.recordFailure('openai');
    assert.equal(breaker.canAttempt('openai').allowed, false, '达到阈值必须熔断');
    assert.equal(breaker.snapshot('openai').state, 'open');
  });

  test('a success resets the consecutive-failure count', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    breaker.recordSuccess('openai');
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    assert.equal(
      breaker.canAttempt('openai').allowed,
      true,
      '成功必须清零连续失败计数，否则零散失败会累积成误熔断',
    );
  });

  test('circuit breakers are per provider, not global', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure('openai');
    assert.equal(breaker.canAttempt('openai').allowed, false);
    assert.equal(breaker.canAttempt('anthropic').allowed, true, '一个 provider 熔断不得影响其他 provider');
  });

  test('after the cooldown it half-opens and admits exactly one probe', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure('openai');
    assert.equal(breaker.canAttempt('openai').allowed, false);

    advance(29_999);
    assert.equal(breaker.canAttempt('openai').allowed, false, '冷却未满不得放行');

    advance(2);
    assert.equal(breaker.canAttempt('openai').allowed, true, '冷却结束后必须放探针');
    // 探针在途时，其余并发请求必须继续快速失败，避免恢复瞬间的惊群。
    assert.equal(breaker.canAttempt('openai').allowed, false, '只允许一个在途探针');
    assert.equal(breaker.snapshot('openai').state, 'half_open');
  });

  test('a successful probe closes the breaker', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    breaker.recordFailure('openai');
    advance(1_001);
    assert.equal(breaker.canAttempt('openai').allowed, true);
    breaker.recordSuccess('openai');
    assert.equal(breaker.canAttempt('openai').allowed, true);
    assert.equal(breaker.snapshot('openai').state, 'closed');
  });

  test('a failed probe re-opens the breaker and restarts the cooldown', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    breaker.recordFailure('openai');
    advance(1_001);
    assert.equal(breaker.canAttempt('openai').allowed, true);
    breaker.recordFailure('openai');
    assert.equal(breaker.canAttempt('openai').allowed, false, '探针失败必须重新熔断');
    advance(500);
    assert.equal(breaker.canAttempt('openai').allowed, false, '冷却必须重新计时');
  });

  test('reports retryAfterMs so callers can surface it', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    breaker.recordFailure('openai');
    advance(4_000);
    const snap = breaker.snapshot('openai');
    assert.equal(snap.retryAfterMs, 6_000);
  });
});

describe('retry backoff jitter (P1-7)', () => {
  test('delay stays within [half, full] of the exponential base', () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
      for (const rand of [0, 0.25, 0.5, 0.99]) {
        const delay = retryDelayMs(attempt, () => rand);
        assert.ok(
          delay >= Math.floor(exponential / 2) && delay <= Math.ceil(exponential),
          `attempt=${attempt} rand=${rand} delay=${delay} 越界（exponential=${exponential}）`,
        );
      }
    }
  });

  test('the delay is capped so a large maxRetries cannot stall a request', () => {
    assert.ok(retryDelayMs(20, () => 1) <= RETRY_MAX_DELAY_MS);
    assert.ok(retryDelayMs(50, () => 1) <= RETRY_MAX_DELAY_MS);
  });

  test('jitter actually decorrelates concurrent retries', () => {
    // 固定 attempt 下，不同随机源必须给出不同延迟 —— 这正是原实现缺失的性质
    // （原实现 250 * 2^(n-1) 对同一 attempt 永远返回同一个值，所有并发请求
    // 会在同一毫秒一起重试）。
    const samples = new Set<number>();
    for (let i = 0; i < 40; i += 1) samples.add(retryDelayMs(4, () => i / 40));
    assert.ok(samples.size > 10, `抖动未生效：只产生 ${samples.size} 种延迟`);
  });

  test('never returns a negative or NaN delay', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const delay = retryDelayMs(attempt);
      assert.ok(Number.isFinite(delay) && delay >= 0, `attempt=${attempt} -> ${delay}`);
    }
  });
});
