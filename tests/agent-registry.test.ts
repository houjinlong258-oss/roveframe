import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AgentToolRegistry } from '@/lib/agent/registry';
import { deterministicToolPlan } from '@/lib/agent/gateway';
import type { AgentAuditEvent, AgentToolContext } from '@/lib/agent/types';

function context(role: 'owner' | 'manager' | 'staff', events: AgentAuditEvent[]): AgentToolContext {
  return {
    tenantId: 'tenant-test',
    businessId: 'business-test',
    userId: 'user-test',
    role,
    sessionId: 'session-test',
    turnId: 'turn-test',
    locale: 'en',
    timeZone: 'America/New_York',
    audit: async (event) => {
      events.push(event);
    },
  };
}

test('blocks a tool when the role lacks the required permission', async () => {
  const registry = new AgentToolRegistry();
  let executed = false;
  registry.register({
    name: 'reviews.reply',
    description: 'Reply to a review',
    action: 'reviews:reply',
    risk: 'external_side_effect',
    requiredPermission: 'reviews:write',
    timeoutMs: 100,
    inputSchema: z.object({ reviewId: z.string() }),
    execute: async () => {
      executed = true;
      return { ok: true, data: { sent: true } };
    },
  });

  const events: AgentAuditEvent[] = [];
  const result = await registry.execute('reviews.reply', { reviewId: 'review-1' }, context('staff', events));

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'forbidden', message: 'Missing permission: reviews:write' },
  });
  assert.equal(executed, false);
  assert.equal(events.at(-1)?.status, 'blocked');
});

test('rejects invalid input before tool execution', async () => {
  const registry = new AgentToolRegistry();
  let executed = false;
  registry.register({
    name: 'analytics.summary',
    description: 'Read an analytics summary',
    action: 'analytics:read',
    risk: 'read',
    requiredPermission: 'orders:read',
    timeoutMs: 100,
    inputSchema: z.object({ period: z.enum(['today', 'week']) }),
    execute: async () => {
      executed = true;
      return { ok: true, data: {} };
    },
  });

  const events: AgentAuditEvent[] = [];
  const result = await registry.execute('analytics.summary', { period: 'year' }, context('staff', events));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'invalid_input');
  assert.equal(executed, false);
  assert.equal(events.at(-1)?.status, 'blocked');
});

test('returns a structured timeout and closes the timeout timer', async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    name: 'analytics.slow',
    description: 'Slow analytics probe',
    action: 'analytics:read',
    risk: 'read',
    requiredPermission: 'orders:read',
    timeoutMs: 20,
    inputSchema: z.object({}),
    execute: async () => new Promise<never>(() => undefined),
  });

  const events: AgentAuditEvent[] = [];
  const started = Date.now();
  const result = await registry.execute('analytics.slow', {}, context('staff', events));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'tool_timeout');
  assert.ok(Date.now() - started < 1000);
  assert.equal(events.at(-1)?.status, 'timed_out');
});

test('exposes only model-callable tools allowed for the current role', () => {
  const registry = new AgentToolRegistry();
  registry.register({
    name: 'inventory.read',
    description: 'Read inventory',
    action: 'inventory:read',
    risk: 'read',
    requiredPermission: 'inventory:read',
    timeoutMs: 100,
    modelInputSchema: { type: 'object', properties: {} },
    inputSchema: z.object({}),
    execute: async () => ({ ok: true, data: {} }),
  });

  assert.equal(registry.modelTools('manager').length, 1);
  assert.equal(registry.modelTools('staff').length, 0);
});

test('deterministic planner selects bounded business read tools', () => {
  const calls = deterministicToolPlan('为什么本周销售下降，差评和库存怎么样？');
  assert.deepEqual(calls.map((call) => call.name), [
    'analytics.get_sales_summary',
    'reviews.get_negative_trend',
    'inventory.get_low_stock',
  ]);
  assert.deepEqual(calls[0]?.input, { period: 'week' });
});
