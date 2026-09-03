import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScheduledRunIdempotencyKey, calculateTaskRetryDelayMinutes } from '@/lib/agent/tasks/worker';

test('scheduled task idempotency keys are stable per slot', () => {
  const first = buildScheduledRunIdempotencyKey('task-1', '2026-09-03T08:00:00.000Z');
  const second = buildScheduledRunIdempotencyKey('task-1', '2026-09-03T08:00:00.000Z');
  assert.equal(first, second);
  assert.notEqual(first, buildScheduledRunIdempotencyKey('task-1', '2026-09-03T08:15:00.000Z'));
});

test('task retries use bounded exponential backoff', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(calculateTaskRetryDelayMinutes), [1, 2, 4, 8, 16, 60]);
});
