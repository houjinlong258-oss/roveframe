import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToolRegistry } from '../src/lib/agent/registry';
import { registerDefaultWriteTools } from '../src/lib/agent/tools/write-tools';

test('Human-in-the-Loop Write Tools: registers purchase.create_draft, marketing.create_draft_campaign, and reviews.draft_reply', () => {
  registerDefaultWriteTools();

  const purchaseTool = agentToolRegistry.get('purchase.create_draft');
  assert.ok(purchaseTool);
  assert.equal(purchaseTool.requiredPermission, 'manage');

  const marketingTool = agentToolRegistry.get('marketing.create_draft_campaign');
  assert.ok(marketingTool);
  assert.equal(marketingTool.requiredPermission, 'manage');

  const reviewTool = agentToolRegistry.get('reviews.draft_reply');
  assert.ok(reviewTool);
  assert.equal(reviewTool.requiredPermission, 'manage');
});

test('Human-in-the-Loop Write Tools: filters model-callable write tools by user role permission', () => {
  registerDefaultWriteTools();

  const staffTools = agentToolRegistry.modelTools('staff');
  assert.equal(staffTools.some(t => t.name === 'purchase.create_draft'), false);

  const ownerTools = agentToolRegistry.modelTools('owner');
  assert.equal(ownerTools.some(t => t.name === 'purchase.create_draft'), true);
});
