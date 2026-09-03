import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToolRegistry } from '@/lib/agent/registry';
import { registerDecoupledTools } from '@/lib/agent/tools/decoupled-registry';

test('Decoupled Tool Registry: registers 7 core tools with strict risk levels', () => {
  registerDecoupledTools();

  const analytics = agentToolRegistry.get('analytics_tool');
  const reviews = agentToolRegistry.get('reviews_tool');
  const customer = agentToolRegistry.get('customer_tool');
  const inventory = agentToolRegistry.get('inventory_tool');
  const marketing = agentToolRegistry.get('marketing_tool');
  const report = agentToolRegistry.get('report_tool');
  const notification = agentToolRegistry.get('notification_tool');

  assert.ok(analytics, 'analytics_tool should be registered');
  assert.equal(analytics?.risk, 'read');

  assert.ok(reviews, 'reviews_tool should be registered');
  assert.equal(reviews?.risk, 'read');

  assert.ok(customer, 'customer_tool should be registered');
  assert.equal(customer?.risk, 'read');

  assert.ok(inventory, 'inventory_tool should be registered');
  assert.equal(inventory?.risk, 'read');

  assert.ok(marketing, 'marketing_tool should be registered');
  assert.equal(marketing?.risk, 'write');

  assert.ok(report, 'report_tool should be registered');
  assert.equal(report?.risk, 'read');

  assert.ok(notification, 'notification_tool should be registered');
  assert.equal(notification?.risk, 'write');
});
