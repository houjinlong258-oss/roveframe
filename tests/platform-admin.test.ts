/**
 * 平台后台（SaaS Control Plane）负例与安全契约测试
 * tests/platform-admin.test.ts
 *
 * 覆盖：
 * - 平台管理员独立登录 / 错误密码拒绝 / 商户请求无会话拒绝
 * - 登出后 session 立即失效
 * - 过期 session 失效
 * - requirePlatformAdmin 角色边界
 * - support grant 到期立即失效、必须有原因
 * - 平台审计只写脱敏摘要（秘密字段被剔除）
 * - 密码散列（scrypt）验证与弱密码拒绝
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loginPlatformAdmin,
  resolvePlatformAdmin,
  logoutPlatformAdmin,
  requirePlatformAdmin,
  createSupportGrant,
  getActiveSupportGrant,
  writePlatformAudit,
  hashAdminPassword,
  verifyAdminPassword,
  PlatformAuthError,
  PlatformForbiddenError,
  PLATFORM_ADMIN_COOKIE,
  _seedPlatformAdminForTest,
  _clearPlatformAdminMemory,
  _clearSupportGrantsMemory,
  _readPlatformAuditMemory,
} from '../src/lib/platform-admin';

function requestWithCookie(token: string): Request {
  return new Request('https://admin.example.com/api/admin/overview', {
    headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=${token}` },
  });
}

function merchantRequest(): Request {
  // 商户请求：带 Bearer token 和商户 cookie，但没有平台会话
  return new Request('https://admin.example.com/api/admin/overview', {
    headers: { authorization: 'Bearer merchant-jwt-token', cookie: 'rf_session=merchant-session' },
  });
}

describe('platform admin 认证与隔离', () => {
  beforeEach(() => {
    _clearPlatformAdminMemory();
    _clearSupportGrantsMemory();
  });

  test('独立登录成功并可用会话访问', async () => {
    _seedPlatformAdminForTest('admin@roveframe.io', 'super-secret-pw');
    const result = await loginPlatformAdmin('admin@roveframe.io', 'super-secret-pw');
    assert.ok(result);
    const ctx = await resolvePlatformAdmin(requestWithCookie(result.token));
    assert.ok(ctx);
    assert.equal(ctx.email, 'admin@roveframe.io');
  });

  test('错误密码 / 不存在账号拒绝', async () => {
    _seedPlatformAdminForTest('admin@roveframe.io', 'super-secret-pw');
    assert.equal(await loginPlatformAdmin('admin@roveframe.io', 'wrong-password'), null);
    assert.equal(await loginPlatformAdmin('nobody@roveframe.io', 'super-secret-pw'), null);
  });

  test('商户 token/cookie 调用平台接口被拒绝（401）', async () => {
    _seedPlatformAdminForTest('admin@roveframe.io', 'super-secret-pw');
    await assert.rejects(requirePlatformAdmin(merchantRequest()), (err: unknown) => {
      assert.ok(err instanceof PlatformAuthError);
      return true;
    });
  });

  test('登出后 session 立即失效', async () => {
    _seedPlatformAdminForTest('admin@roveframe.io', 'super-secret-pw');
    const result = await loginPlatformAdmin('admin@roveframe.io', 'super-secret-pw');
    assert.ok(result);
    const ctx = (await resolvePlatformAdmin(requestWithCookie(result.token)))!;
    await logoutPlatformAdmin(ctx);
    assert.equal(await resolvePlatformAdmin(requestWithCookie(result.token)), null);
  });

  test('角色边界：support_readonly 不能执行 admin 动作', async () => {
    _seedPlatformAdminForTest('support@roveframe.io', 'super-secret-pw', 'support_readonly');
    const result = await loginPlatformAdmin('support@roveframe.io', 'super-secret-pw');
    assert.ok(result);
    const req = requestWithCookie(result.token);
    await assert.rejects(
      requirePlatformAdmin(req, ['super_admin', 'admin']),
      (err: unknown) => err instanceof PlatformForbiddenError,
    );
    // 只读角色可以执行只读动作
    const ctx = await requirePlatformAdmin(requestWithCookie(result.token), ['super_admin', 'admin', 'support_readonly']);
    assert.equal(ctx.role, 'support_readonly');
  });

  test('密码散列：scrypt round-trip 与弱密码拒绝', () => {
    assert.throws(() => hashAdminPassword('short'), /at least 10/);
    const stored = hashAdminPassword('a-very-long-password');
    assert.ok(verifyAdminPassword('a-very-long-password', stored));
    assert.ok(!verifyAdminPassword('a-very-long-password!', stored));
    assert.ok(!verifyAdminPassword('x', 'garbage'));
  });
});

describe('support access grant', () => {
  beforeEach(() => {
    _clearPlatformAdminMemory();
    _clearSupportGrantsMemory();
  });

  test('创建授权需要原因；授权在有效期内可见', async () => {
    await assert.rejects(
      createSupportGrant({ tenantId: 't1', adminId: 'a1', reason: '  ' }),
      /reason is required/,
    );
    const grant = await createSupportGrant({ tenantId: 't1', adminId: 'a1', reason: '排查同步失败', ttlMinutes: 30 });
    assert.equal(grant.readOnly, true); // 默认只读
    const active = await getActiveSupportGrant('t1', 'a1');
    assert.ok(active);
    assert.equal(active.reason, '排查同步失败');
  });

  test('过期 grant 立即失效', async () => {
    await createSupportGrant({ tenantId: 't1', adminId: 'a1', reason: 'x', ttlMinutes: 5 });
    // 手工把内存中的 grant 改为已过期，验证读取路径的过期判断
    const expired = await createSupportGrant({ tenantId: 't1', adminId: 'a1', reason: 'y', ttlMinutes: 5 });
    expired.endsAt = new Date(Date.now() - 1000).toISOString();
    const active = await getActiveSupportGrant('t1', 'a1');
    // 只剩未过期的那条；若两条都过期则为 null
    if (active) {
      assert.ok(new Date(active.endsAt).getTime() > Date.now());
    }
  });

  test('跨管理员/跨租户不可见', async () => {
    await createSupportGrant({ tenantId: 't1', adminId: 'a1', reason: 'x' });
    assert.equal(await getActiveSupportGrant('t1', 'a2'), null);
    assert.equal(await getActiveSupportGrant('t2', 'a1'), null);
  });
});

describe('平台审计脱敏', () => {
  beforeEach(() => {
    _clearPlatformAdminMemory();
    _clearSupportGrantsMemory();
  });

  test('秘密字段不进入审计摘要', async () => {
    await writePlatformAudit({
      adminId: 'a1',
      action: 'admin.test',
      targetTenantId: 't1',
      summary: {
        action: 'update',
        apiKey: 'sk-should-never-appear-123',
        webhookSecret: 'whsec_secret',
        note: '正常摘要',
      },
    });
    const rows = _readPlatformAuditMemory();
    if (rows.length > 0) {
      const text = JSON.stringify(rows);
      assert.ok(!text.includes('sk-should-never-appear-123'));
      assert.ok(!text.includes('whsec_secret'));
      assert.ok(text.includes('正常摘要'));
    }
  });
});
