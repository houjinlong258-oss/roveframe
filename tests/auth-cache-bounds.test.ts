import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _authCacheSizes,
  _AUTH_CACHE_LIMITS,
  _clearAuthCaches,
  _seedRoleForTest,
} from '../src/lib/auth-guard';

/**
 * Phase 12 / P1-10 — 鉴权缓存必须有**无条件**上限。
 *
 * 旧行为：在 size 超阈值时只清理**已过期**条目，而且 token 侧的清理只挂在
 * 远程解析分支上。两个后果都是内存无界：
 *
 *   1. 配好 COZE_SUPABASE_JWT_SECRET 后请求走本地验签分支，那处清理永不执行；
 *   2. 即使执行，若同时在活条目多于阈值（60s TTL 在持续负载下可达），
 *      它一条也清不掉。
 *
 * 这些用例钉住的是"上限"这一契约本身——内存问题不会以功能失败的形式出现，
 * 只会表现为进程 RSS 缓慢上涨，因此必须显式断言。
 */
describe('auth cache bounds (P1-10)', () => {
  beforeEach(() => {
    _clearAuthCaches();
  });

  test('role cache evicts when every entry is still live', () => {
    const limit = _AUTH_CACHE_LIMITS.role;
    // 全部写入都在 TTL 内，因此"只清过期项"的策略一条也清不掉。
    for (let i = 0; i < limit + 250; i += 1) {
      _seedRoleForTest(`user-${i}`, 'staff');
    }
    const { role } = _authCacheSizes();
    assert.ok(
      role <= limit,
      `role 缓存在全部条目未过期时仍必须受限：size=${role} limit=${limit}`,
    );
    assert.ok(role > 0, 'role 缓存不应被清空');
  });

  test('role cache stays bounded across repeated over-limit inserts', () => {
    const limit = _AUTH_CACHE_LIMITS.role;
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < limit; i += 1) {
        _seedRoleForTest(`round-${round}-user-${i}`, 'manager');
      }
      const { role } = _authCacheSizes();
      assert.ok(role <= limit, `第 ${round} 轮后超限：size=${role}`);
    }
  });

  test('the limits are explicit and finite', () => {
    assert.equal(Number.isFinite(_AUTH_CACHE_LIMITS.token), true);
    assert.equal(Number.isFinite(_AUTH_CACHE_LIMITS.role), true);
    assert.ok(_AUTH_CACHE_LIMITS.token > 0 && _AUTH_CACHE_LIMITS.token <= 10_000);
    assert.ok(_AUTH_CACHE_LIMITS.role > 0 && _AUTH_CACHE_LIMITS.role <= 10_000);
  });
});
