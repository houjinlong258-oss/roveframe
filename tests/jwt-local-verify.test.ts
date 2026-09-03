/**
 * 改进 5 — JWT 本地校验快速路径
 * tests/jwt-local-verify.test.ts
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifyJwtLocally, resolveRequestUser, _clearAuthCaches } from '../src/lib/auth-guard';

const TEST_SECRET = 'test-jwt-secret-for-local-verify';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function makeJwt(opts: {
  secret?: string;
  alg?: string;
  expOffsetSec?: number;
  claims?: Record<string, unknown>;
}): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: 'user_jwt_1',
      email: 'jwt@example.com',
      exp: Math.floor(Date.now() / 1000) + (opts.expOffsetSec ?? 3600),
      app_metadata: { tenant_id: 'tenant_jwt', business_id: 'biz_jwt' },
      user_metadata: { name: 'JWT User' },
      ...(opts.claims ?? {}),
    })
  );
  const sig = createHmac('sha256', opts.secret ?? TEST_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('JWT local verification', () => {
  beforeEach(() => {
    process.env.COZE_SUPABASE_JWT_SECRET = TEST_SECRET;
    _clearAuthCaches();
  });
  afterEach(() => {
    delete process.env.COZE_SUPABASE_JWT_SECRET;
    _clearAuthCaches();
  });

  test('valid token verifies and extracts tenant claims', () => {
    const claims = verifyJwtLocally(makeJwt({}));
    assert.ok(claims);
    assert.equal(claims.userId, 'user_jwt_1');
    assert.equal(claims.tenantId, 'tenant_jwt');
    assert.equal(claims.businessId, 'biz_jwt');
    assert.equal(claims.name, 'JWT User');
  });

  test('wrong secret rejected (timing-safe compare)', () => {
    assert.equal(verifyJwtLocally(makeJwt({ secret: 'wrong-secret' })), null);
  });

  test('expired token rejected', () => {
    assert.equal(verifyJwtLocally(makeJwt({ expOffsetSec: -60 })), null);
  });

  test('alg=none rejected', () => {
    assert.equal(verifyJwtLocally(makeJwt({ alg: 'none' })), null);
  });

  test('missing tenant claim rejected', () => {
    assert.equal(
      verifyJwtLocally(makeJwt({ claims: { app_metadata: {} } })),
      null
    );
  });

  test('malformed token rejected', () => {
    assert.equal(verifyJwtLocally('not-a-jwt'), null);
    assert.equal(verifyJwtLocally('a.b.c'), null);
  });

  test('returns null (fallback to remote) when secret not configured', () => {
    delete process.env.COZE_SUPABASE_JWT_SECRET;
    assert.equal(verifyJwtLocally(makeJwt({})), null);
  });

  test('resolveRequestUser: valid local JWT without cached role falls back to remote (401 here, no DB)', async () => {
    // role 不在 JWT 声明里；本地验签通过但无 role 缓存时降级远程，
    // 本环境无 DB → fail closed 401，但绝不能 200
    const req = new Request('http://localhost/api/x', {
      headers: { Authorization: `Bearer ${makeJwt({})}` },
    });
    const result = await resolveRequestUser(req);
    assert.equal(result.ok, false);
  });
});
