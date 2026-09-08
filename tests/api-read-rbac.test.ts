import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasPermission } from '../src/lib/rbac';
import { AuthorizationError, requirePermission } from '../src/lib/tenant';

const read = (path: string): string => readFileSync(path, 'utf8');

const READ_GUARDS: ReadonlyArray<[string, string]> = [
  // [路由文件, 需要的 entity:read 权限]
  ['src/app/api/emails/route.ts', 'emails:read'],
  ['src/app/api/reservations/route.ts', 'reservations:read'],
  ['src/app/api/reviews/route.ts', 'reviews:read'],
  ['src/app/api/agent/approvals/route.ts', 'approvals:read'],
  ['src/app/api/audit/export/route.ts', 'audit:read'],
];

describe('P0-4 read API RBAC', () => {
  test('staff 无权读取 PII/审批/审计载荷，owner/manager 有权', () => {
    for (const [, action] of READ_GUARDS) {
      assert.equal(hasPermission('staff', action), false, `staff 不得拥有 ${action}`);
      assert.equal(hasPermission('manager', action), true, `manager 应拥有 ${action}`);
      assert.equal(hasPermission('owner', action), true, `owner 应拥有 ${action}`);
    }
  });

  test('requirePermission 对 staff 抛 403 AuthorizationError', () => {
    const ctx = { tenantId: 't-1', businessId: 'b-1', userId: 'u-1', role: 'staff' as const };
    for (const [, action] of READ_GUARDS) {
      assert.throws(() => requirePermission(ctx, action), AuthorizationError);
    }
    const ownerCtx = { ...ctx, role: 'owner' as const };
    requirePermission(ownerCtx, 'emails:read'); // 不抛错
  });

  test('六个读端点全部接入 requirePermission 门控', () => {
    for (const [file, action] of READ_GUARDS) {
      assert.match(read(file), /requirePermission\(/, `${file} 缺少权限门控`);
      assert.ok(read(file).includes(`'${action}'`), `${file} 应要求 ${action}`);
    }
  });

  test('support-access GET 必填 tenantId 且不提供跨管理员授权列表', () => {
    const src = read('src/app/api/admin/support-access/route.ts');
    assert.match(src, /tenantId required/);
    assert.match(src, /getActiveSupportGrant\(tenantId, ctx\.adminId\)/);
    assert.ok(!src.includes("from('support_access_grants')"), '不得无过滤列出全部授权记录');
    assert.ok(!src.includes('getSupabaseClient'), '读取路径只允许 getActiveSupportGrant');
  });
});
