import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('audit_events schema carries the required production fields', () => {
  const schema = readFileSync(join(process.cwd(), 'src/storage/database/shared/schema.ts'), 'utf8');
  for (const field of ['tenant_id', 'business_id', 'user_id', 'agent_id', 'tool_name', 'action', 'arguments_hash', 'approval_id', 'execution_id', 'created_at', 'result']) {
    assert.ok(schema.includes(field), 'missing schema field: ' + field);
  }
  const sql = readFileSync(join(process.cwd(), 'scripts/migrate-pilot-ready.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.audit_events/);
});

test('approval lifecycle writes audit_events', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/agent/approvals.ts'), 'utf8');
  for (const action of ['approval.created', 'approval.rejected', 'approval.approved', 'approval.executed', 'approval.failed']) {
    assert.ok(source.includes("'" + action + "'"), 'missing lifecycle action: ' + action);
  }
  assert.match(source, /writeAuditEvent/);
});

test('audit query and export APIs are tenant+business scoped', () => {
  const list = readFileSync(join(process.cwd(), 'src/app/api/audit/route.ts'), 'utf8');
  assert.match(list, /\.eq\('tenant_id', context\.tenantId\)/);
  assert.match(list, /\.eq\('business_id', context\.businessId\)/);
  assert.match(list, /approval_id/);
  const exportRoute = readFileSync(join(process.cwd(), 'src/app/api/audit/export/route.ts'), 'utf8');
  assert.match(exportRoute, /text\/csv/);
  assert.match(exportRoute, /\.eq\('tenant_id', context\.tenantId\)/);
});

test('audit page renders events and links back to approvals', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/[locale]/audit/page.tsx'), 'utf8');
  assert.match(page, /\/api\/audit/);
  assert.match(page, /\/api\/audit\/export/);
  assert.match(page, /approval_id/);
});

test('approvals page exposes request/risk/execution/result/audit detail', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/[locale]/approvals/page.tsx'), 'utf8');
  assert.match(page, /execution_result/);
  assert.match(page, /approved_by/);
  assert.match(page, /viewAudit/);
  assert.match(page, /setInterval/);
  assert.match(page, /useState<'code' \| 'business'>\('business'\)/);
});
