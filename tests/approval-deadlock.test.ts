import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canApprove } from '../src/lib/agent/approvals';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-12 审批 required_role 死锁修复', () => {
  test('events 路由将 admin 审批策略映射为 owner（商户域无人可批 admin）', () => {
    const src = read('src/app/api/agent/approvals/events/route.ts');
    assert.match(
      src,
      /approval_policy === 'admin' \|\| payload\.approval_policy === 'owner'[\s\S]{0,120}\? 'owner'/,
    );
    assert.ok(!src.includes("payload.approval_policy\n      : 'manager'"), '不再原样透传 admin');
  });

  test('canApprove 契约保持不变（admin 审批不进入商户 RBAC 域）', () => {
    assert.equal(canApprove('owner', 'owner'), true);
    assert.equal(canApprove('manager', 'manager'), true);
    assert.equal(canApprove('manager', 'owner'), false);
    assert.equal(canApprove('owner', 'admin'), false);
  });
});
