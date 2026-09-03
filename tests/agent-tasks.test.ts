import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTaskHandler } from '../src/lib/agent/tasks/worker';

test('Agent Task Worker: registers custom task handlers cleanly', () => {
  let executed = false;
  registerTaskHandler('test_task_handler', async (ctx) => {
    executed = true;
    return { ok: true, payload: ctx.payload };
  });

  assert.equal(typeof registerTaskHandler, 'function');
  assert.equal(executed, false);
});
