import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPermissionEngine } from '../src/lib/agent/permissions/engine';

test('Agent Permissions: Analytics Agent has read access to sales but denied code access', () => {
  const salesRead = agentPermissionEngine.canAccessResource('analytics_agent', 'READ', 'sales');
  assert.equal(salesRead.allowed, true);

  const codeAccess = agentPermissionEngine.canAccessResource('analytics_agent', 'READ', 'code');
  assert.equal(codeAccess.allowed, false);
  assert.match(codeAccess.reason ?? '', /explicitly forbidden/i);
});

test('Agent Permissions: Marketing Agent can write marketing_content but not payment data', () => {
  const contentWrite = agentPermissionEngine.canAccessResource('marketing_agent', 'WRITE', 'marketing_content');
  assert.equal(contentWrite.allowed, true);

  const paymentWrite = agentPermissionEngine.canAccessResource('marketing_agent', 'WRITE', 'payment');
  assert.equal(paymentWrite.allowed, false);
});

test('Agent Permissions: Coding Agent can edit src/custom/* but blocked from src/core/*', () => {
  const customEdit = agentPermissionEngine.canAccessPath('coding_agent', 'WRITE', 'src/custom/themes/default.ts');
  assert.equal(customEdit.allowed, true);

  const coreEdit = agentPermissionEngine.canAccessPath('coding_agent', 'WRITE', 'src/core/auth/session.ts');
  assert.equal(coreEdit.allowed, false);
  assert.match(coreEdit.reason ?? '', /forbidden from accessing path/i);

  const dbClientEdit = agentPermissionEngine.canAccessPath('coding_agent', 'WRITE', 'src/storage/database/supabase-client.ts');
  assert.equal(dbClientEdit.allowed, false);
});

test('Agent Permissions: Coding Agent can read tests and custom files, but not production credentials', () => {
  const testRead = agentPermissionEngine.canAccessPath('coding_agent', 'READ', 'tests/customization-layer.test.ts');
  assert.equal(testRead.allowed, true);

  const credAccess = agentPermissionEngine.canAccessResource('coding_agent', 'READ', 'master_credentials');
  assert.equal(credAccess.allowed, false);
});
