import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  acquireSlot,
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
  resetRateLimitStateForTests,
} from '../src/lib/rate-limit';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-1 rate limit', () => {
  test('固定窗口超限返回 429 决策（retryAfterSec ≥ 1）', () => {
    resetRateLimitStateForTests();
    const opts = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      const d = checkFixedWindow('k:window', opts);
      assert.equal(d.ok, true, `第 ${i + 1} 次应放行`);
    }
    const blocked = checkFixedWindow('k:window', opts);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterSec >= 1);
    assert.equal(blocked.limit, 3);
  });

  test('不同 key 互不影响', () => {
    resetRateLimitStateForTests();
    const opts = { limit: 1, windowMs: 60_000 };
    assert.equal(checkFixedWindow('k:a', opts).ok, true);
    assert.equal(checkFixedWindow('k:a', opts).ok, false, 'key a 已超限');
    assert.equal(checkFixedWindow('k:b', opts).ok, true, 'key b 不受 key a 影响');
  });

  test('窗口过期后自动重置', () => {
    resetRateLimitStateForTests();
    mock.timers.enable({ apis: ['Date'] });
    try {
      const opts = { limit: 1, windowMs: 60_000 };
      assert.equal(checkFixedWindow('k:reset', opts).ok, true);
      assert.equal(checkFixedWindow('k:reset', opts).ok, false);
      mock.timers.tick(61_000);
      assert.equal(checkFixedWindow('k:reset', opts).ok, true, '窗口过期后应重新放行');
    } finally {
      mock.timers.reset();
    }
  });

  test('指数退避：连续失败封锁，成功后解除', () => {
    resetRateLimitStateForTests();
    const backoff = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };
    const opts = { limit: 5, windowMs: 15 * 60_000, backoff };
    noteFailure('k:backoff', backoff);
    noteFailure('k:backoff', backoff);
    const blocked = checkFixedWindow('k:backoff', opts);
    assert.equal(blocked.ok, false, '退避期内应拒绝');
    assert.ok(blocked.retryAfterSec >= 1);
    noteSuccess('k:backoff');
    assert.equal(checkFixedWindow('k:backoff', opts).ok, true, '成功后解除退避');
  });

  test('并发门：达到上限拒绝，release 后恢复且 release 幂等', () => {
    resetRateLimitStateForTests();
    const a = acquireSlot('k:slot', 2);
    const b = acquireSlot('k:slot', 2);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const c = acquireSlot('k:slot', 2);
    assert.equal(c.ok, false, '并发已达上限应拒绝');
    b.release();
    b.release(); // 幂等：重复 release 不得过度释放
    const d = acquireSlot('k:slot', 2);
    assert.equal(d.ok, true, 'release 后应可再获取');
    d.release();
    a.release();
    const e = acquireSlot('k:slot', 2);
    assert.equal(e.ok, true, '全部释放后额度完全恢复');
  });

  test('429 响应携带 JSON 错误与 Retry-After 头', () => {
    const response = rateLimitResponse({ ok: false, retryAfterSec: 42, limit: 5 });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '42');
  });

  test('getClientIp 解析 x-forwarded-for / x-real-ip / 缺省', () => {
    const withFwd = new Request('https://x.test/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    assert.equal(getClientIp(withFwd), '1.2.3.4');
    const withReal = new Request('https://x.test/', { headers: { 'x-real-ip': '5.6.7.8' } });
    assert.equal(getClientIp(withReal), '5.6.7.8');
    assert.equal(getClientIp(new Request('https://x.test/')), 'unknown');
  });
});

describe('P0-1 rate limit wiring contracts', () => {
  const WIRED_ROUTES: Array<[string, RegExp]> = [
    ['src/app/api/auth/login/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/auth/signup/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/admin/auth/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/emails/send/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/channels/send/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/marketing/send/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/payments/checkout/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/payments/refund/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/payments/reconcile/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/store/orders/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/upload/route.ts', /checkFixedWindow|rateLimitResponse/],
    ['src/app/api/agent/chat/route.ts', /acquireSlot\(/],
    ['src/app/api/healing/route.ts', /checkFixedWindow|rateLimitResponse/],
  ];

  test('P0-1 缺口端点全部接入限流', () => {
    for (const [file, pattern] of WIRED_ROUTES) {
      assert.match(read(file), pattern, `${file} 必须接入限流`);
    }
  });

  test('/api/health 不阻塞（不接入限流）', () => {
    const health = read('src/app/api/health/route.ts');
    assert.ok(!health.includes('rate-limit'), '健康检查不得接入限流');
  });
});
