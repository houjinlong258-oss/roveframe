import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emailLeaseDecision } from '../src/lib/email/outgoing';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-15 email_send_tasks 租约恢复', () => {
  const LEASE = 15 * 60_000;
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);

  test('sending 行租约过期 → requeue 且 attempts+1', () => {
    const decision = emailLeaseDecision(
      { status: 'sending', claimed_at: new Date(now - LEASE - 1).toISOString(), attempts: 1, max_attempts: 3 },
      now,
    );
    assert.deepEqual(decision, { action: 'requeue', nextAttempts: 2 });
  });

  test('sending 行租约内不回收', () => {
    const decision = emailLeaseDecision(
      { status: 'sending', claimed_at: new Date(now - LEASE + 60_000).toISOString(), attempts: 0, max_attempts: 3 },
      now,
    );
    assert.deepEqual(decision, { action: 'none', nextAttempts: 0 });
  });

  test('attempts 达上限 → 转 failed（不再无限重发）', () => {
    const decision = emailLeaseDecision(
      { status: 'sending', claimed_at: new Date(now - LEASE - 1).toISOString(), attempts: 2, max_attempts: 3 },
      now,
    );
    assert.deepEqual(decision, { action: 'fail', nextAttempts: 3 });
  });

  test('非 sending 或缺失 claimed_at 不回收', () => {
    assert.equal(emailLeaseDecision(
      { status: 'queued', claimed_at: null, attempts: 0, max_attempts: 3 }, now,
    ).action, 'none');
    assert.equal(emailLeaseDecision(
      { status: 'sending', claimed_at: null, attempts: 0, max_attempts: 3 }, now,
    ).action, 'none');
  });

  test('接线契约：出件主循环先回收 + 认领时落 claimed_at + 失败留痕', () => {
    const src = read('src/lib/email/outgoing.ts');
    assert.match(src, /await recoverStaleEmailSends\(\);/);
    assert.match(src, /update\(\{ status: 'sending', claimed_at: nowIso \}\)/);
    assert.match(src, /sent status write-back failed/);
    assert.match(src, /EMAIL_SEND_LEASE_TIMEOUT_MS = 15 \* 60_000/);
  });

  test('outbox 同款租约恢复接线', () => {
    const src = read('src/lib/notifications/outbox.ts');
    assert.match(src, /await recoverStaleOutboxItems\(\);/);
    assert.match(src, /OUTBOX_LEASE_TIMEOUT_MS = 15 \* 60_000/);
    assert.match(src, /outbox lease expired/);
  });
});
