import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executingLeaseExpired } from '../src/lib/agent/approvals';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-21 审批 executing 租约恢复与幂等对账', () => {
  const LEASE = 15 * 60_000;
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);

  test('executing 超租约可回收；租约内不回收', () => {
    assert.equal(
      executingLeaseExpired(
        { status: 'executing', consumed_at: new Date(now - LEASE - 1).toISOString() },
        now,
      ),
      true,
    );
    assert.equal(
      executingLeaseExpired(
        { status: 'executing', consumed_at: new Date(now - LEASE + 60_000).toISOString() },
        now,
      ),
      false,
    );
    assert.equal(executingLeaseExpired({ status: 'pending', consumed_at: null }, now), false);
    assert.equal(executingLeaseExpired({ status: 'executed', consumed_at: null }, now), false);
    assert.equal(executingLeaseExpired({ status: 'executing', consumed_at: null }, now), false);
  });

  test('回收 CAS：executing→pending，consumed_at 超 15min，留审计', () => {
    const src = read('src/lib/agent/approvals.ts');
    assert.match(src, /EXECUTING_LEASE_MS = 15 \* 60_000/);
    assert.match(src, /eq\('status', 'executing'\)\s*\n\s*\.lte\('consumed_at', cutoffIso\)/);
    assert.match(src, /status: 'pending',\s*\n\s*consumed_at: null/);
    assert.match(src, /approval\.lease_recovered/);
    assert.match(src, /executing lease expired; recovered for replay/);
    assert.match(src, /Approval is currently executing/);
  });

  test('重放安全：副作用幂等键绑定 invocation/execution（恰一次生效）', () => {
    const src = read('src/lib/agent/approvals.ts');
    // Stripe 退款幂等键使用冻结的 invocation_id —— 崩溃重放返回同一退款
    assert.match(src, /idempotencyKey: `refund:\$\{item\.invocation_id\}`/);
    // roveagent 回调携带 execution_id（服务端单次 claim）
    assert.match(src, /executionId: item\.execution_id \?\? ''/);
    assert.match(src, /invocationId: item\.invocation_id/);
  });
});
