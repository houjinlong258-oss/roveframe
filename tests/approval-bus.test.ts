import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { canApprove, hashApprovalArguments } from '../src/lib/agent/approvals';
import { signRoveAgentPayload, verifyRoveAgentPayload } from '../src/lib/roveagent/signature';

const originalSigningSecret = process.env.ROVEAGENT_APPROVAL_SECRET;

before(() => {
  process.env.ROVEAGENT_APPROVAL_SECRET = 'approval-contract-test-key';
});

after(() => {
  if (originalSigningSecret === undefined) delete process.env.ROVEAGENT_APPROVAL_SECRET;
  else process.env.ROVEAGENT_APPROVAL_SECRET = originalSigningSecret;
});

test('frozen argument hashes are recursive and key-order independent', () => {
  const left = hashApprovalArguments({
    recipient: 'customer@example.test',
    campaign: { content: 'hello', tags: ['vip', 'weekly'] },
  });
  const right = hashApprovalArguments({
    campaign: { tags: ['vip', 'weekly'], content: 'hello' },
    recipient: 'customer@example.test',
  });
  const mutated = hashApprovalArguments({
    campaign: { tags: ['vip', 'weekly'], content: 'changed' },
    recipient: 'customer@example.test',
  });
  assert.equal(left, right);
  assert.notEqual(left, mutated);
});

test('approval role hierarchy is fail-closed for merchant and platform roles', () => {
  assert.equal(canApprove('manager', 'manager'), true);
  assert.equal(canApprove('owner', 'manager'), true);
  assert.equal(canApprove('manager', 'owner'), false);
  assert.equal(canApprove('owner', 'owner'), true);
  assert.equal(canApprove('owner', 'admin'), false);
});

test('RoveAgent callbacks use timestamped HMAC signatures with expiry and tamper protection', () => {
  const body = JSON.stringify({ invocation_id: 'invocation-a', args: { amount: 25 } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = signRoveAgentPayload(body, timestamp);
  assert.equal(verifyRoveAgentPayload(body, signed.timestamp, signed.signature), true);
  assert.equal(verifyRoveAgentPayload(`${body} `, signed.timestamp, signed.signature), false);
  assert.equal(verifyRoveAgentPayload(body, String(timestamp - 301), signed.signature), false);
});

test('approval bus schema and implementation preserve one frozen invocation and atomic claim', () => {
  const schema = readFileSync('src/storage/database/shared/schema.ts', 'utf8');
  const approval = readFileSync('src/lib/agent/approvals.ts', 'utf8');
  const python = readFileSync('roveagent/api/app.py', 'utf8');
  const gate = readFileSync('roveagent/enterprise/gate_hook.py', 'utf8');
  const requiredFields = [
    'requester', 'agent', 'tool_name', 'arguments', 'arguments_hash', 'risk_level',
    'required_role', 'invocation_id', 'execution_id', 'approved_by', 'consumed_at',
    'executed_at', 'execution_result',
  ];
  for (const field of requiredFields) assert.match(schema, new RegExp(`"${field}"`));
  assert.match(schema, /agent_approvals_invocation_idx/);
  assert.match(approval, /\.eq\('status', 'pending'\)\.select\('\*'\)\.maybeSingle\(\)/);
  assert.match(approval, /hashApprovalArguments\(item\.arguments\) !== item\.arguments_hash/);
  assert.match(python, /run_tool_execution_middleware/);
  assert.match(python, /claim_resolution/);
  assert.match(gate, /consume_grant/);
  assert.doesNotMatch(gate, /find_grant/);
});

test('conversation state is owned by tenant, business and user with bounded history and summary', () => {
  const schema = readFileSync('src/storage/database/shared/schema.ts', 'utf8');
  const route = readFileSync('src/app/api/agent/chat/route.ts', 'utf8');
  const migration = readFileSync('scripts/migrate-business-tables.sql', 'utf8');
  assert.match(schema, /chat_sessions_tenant_business_user_idx/);
  assert.match(schema, /summarized_message_count/);
  assert.match(route, /RECENT_HISTORY_MESSAGES = 20/);
  assert.match(route, /extendConversationSummary/);
  assert.match(route, /\.eq\('user_id', ctx\.userId\)/);
  assert.match(migration, /conversation user backfill required for chat_sessions/);
});
