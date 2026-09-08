import assert from 'node:assert/strict';
import test from 'node:test';
import { IterationBudget, isRepetitionDominated, runAgentLoop, toolCallKey } from '../packages/roveagent-core/src';
import { executionStop } from '../src/lib/agent/gateway';

const call = (name: string, id = name, input: Record<string, unknown> = {}) => ({ name, id, input });

test('application adapter recognizes both existing approval tool statuses', () => {
  for (const status of ['pending_approval', 'waiting_approval']) {
    assert.equal(executionStop({ ok: true, data: { status } }), 'awaiting_approval');
  }
  assert.equal(executionStop({ ok: true, data: { status: 'succeeded' } }), undefined);
  assert.equal(executionStop({ ok: false, error: { code: 'tool_timeout', message: 'timeout' } }), 'blocked');
});

test('iteration budget enforces bounds and upstream refund semantics', () => {
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new IterationBudget(invalid));
  const budget = new IterationBudget(1);
  budget.refund();
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), false);
  budget.refund();
  assert.equal(budget.remaining, 1);
  assert.equal(budget.used, 0);
});

test('loop replans from executed evidence and returns a final answer', async () => {
  const executed: string[] = [];
  const result = await runAgentLoop({
    plan: async (observations) => observations.length === 0
      ? { calls: [call('sales')], replan: true }
      : observations.length === 1
        ? { calls: [call('inventory')], replan: true }
        : { calls: [], text: 'Inventory explains the sales drop.', replan: true },
    execute: async (request) => { executed.push(request.name); return { result: { value: 42 } }; },
  });
  assert.equal(result.reason, 'completed');
  assert.equal(result.iterations, 3);
  assert.deepEqual(executed, ['sales', 'inventory']);
  assert.match(result.text ?? '', /Inventory/);
});

test('canonical deduplication prevents repeated actions with reordered nested arguments', async () => {
  const a = call('draft', 'a', { target: { x: 1, y: 2 }, amount: 3 });
  const b = call('draft', 'b', { amount: 3, target: { y: 2, x: 1 } });
  assert.equal(toolCallKey(a), toolCallKey(b));
  let executions = 0;
  const result = await runAgentLoop({
    plan: async () => ({ calls: [a, b], replan: true }),
    execute: async () => { executions += 1; return { result: 'drafted' }; },
  });
  assert.equal(executions, 1);
  assert.equal(result.reason, 'repetition');
});

test('pending approval stops the remaining calls before any side effect', async () => {
  const executed: string[] = [];
  const result = await runAgentLoop({
    plan: async () => ({ calls: [call('draft'), call('send')], replan: true }),
    execute: async (request) => {
      executed.push(request.name);
      return { result: { status: 'pending_approval' }, stop: 'awaiting_approval' };
    },
  });
  assert.deepEqual(executed, ['draft']);
  assert.equal(result.reason, 'awaiting_approval');
});

test('permission failure stops execution; adapter audit failure is propagated', async () => {
  const result = await runAgentLoop({
    plan: async () => ({ calls: [call('restricted'), call('other')], replan: true }),
    execute: async () => ({ result: { error: 'forbidden' }, stop: 'blocked' }),
  });
  assert.equal(result.reason, 'blocked');
  assert.equal(result.observations.length, 1);
  await assert.rejects(runAgentLoop({
    plan: async () => ({ calls: [call('restricted')], replan: true }),
    execute: async () => { throw new Error('audit unavailable'); },
  }), /audit unavailable/);
});

test('total tool budget is enforced across planning rounds', async () => {
  let executions = 0;
  const result = await runAgentLoop({
    maxToolCalls: 2,
    plan: async (observations) => ({ calls: [call(`tool${observations.length}`)], replan: true }),
    execute: async () => { executions += 1; return { result: true }; },
  });
  assert.equal(result.reason, 'budget');
  assert.equal(executions, 2);
});

test('unsupported provider fallback executes one plan only', async () => {
  let plans = 0;
  const result = await runAgentLoop({
    plan: async () => { plans += 1; return { calls: [call('sales')], replan: false }; },
    execute: async () => ({ result: 12 }),
  });
  assert.equal(plans, 1);
  assert.equal(result.reason, 'completed');
});

test('cancel after planning prevents execution', async () => {
  const controller = new AbortController();
  const result = await runAgentLoop({
    signal: controller.signal,
    plan: async () => { controller.abort(); return { calls: [call('send')], replan: true }; },
    execute: async () => { assert.fail('cancelled tool executed'); },
  });
  assert.equal(result.reason, 'cancelled');
});

test('concurrent tenant adapters do not share observations or budgets', async () => {
  const run = (tenant: string) => runAgentLoop({
    plan: async (observations) => observations.length
      ? { calls: [], text: JSON.stringify(observations[0].result), replan: true }
      : { calls: [call('read')], replan: true },
    execute: async () => ({ result: { tenant } }),
  });
  const [a, b] = await Promise.all([run('tenant-a'), run('tenant-b')]);
  assert.match(a.text ?? '', /tenant-a/);
  assert.doesNotMatch(a.text ?? '', /tenant-b/);
  assert.match(b.text ?? '', /tenant-b/);
});

test('repetition detector accepts ordinary prose and stops a model echo', async () => {
  assert.equal(isRepetitionDominated('normal short answer'), false);
  assert.equal(isRepetitionDominated('x'.repeat(500)), true);
  assert.equal(isRepetitionDominated(('A long operational recommendation with evidence and figures.\n').repeat(10)), true);
  const result = await runAgentLoop({
    plan: async () => ({ calls: [], text: 'x'.repeat(500), replan: true }),
    execute: async () => { assert.fail('unexpected execution'); },
  });
  assert.equal(result.reason, 'repetition');
  assert.equal(result.text, undefined);
});

test('different actions cannot reuse one audit call ID', async () => {
  let executions = 0;
  const result = await runAgentLoop({
    plan: async () => ({ calls: [call('one', 'same'), call('two', 'same')], replan: true }),
    execute: async () => { executions += 1; return { result: true }; },
  });
  assert.equal(result.reason, 'blocked');
  assert.equal(executions, 1);
});
