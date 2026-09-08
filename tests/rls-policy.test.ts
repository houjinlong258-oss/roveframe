import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRIORITY_TABLES = ['orders', 'customers', 'payments', 'integration_configs', 'business_memories', 'audit_events'];

test('RLS migration enables row level security on priority tables', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts/migrate-rls.sql'), 'utf8');
  for (const table of PRIORITY_TABLES) {
    assert.ok(sql.includes("'" + table + "'"), 'table missing from RLS migration: ' + table);
  }
  assert.match(sql, /enable row level security/);
});

test('RLS migration creates tenant + business policies for authenticated', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts/migrate-rls.sql'), 'utf8');
  assert.match(sql, /_auth_tenant_scope/);
  assert.match(sql, /_auth_business_scope/);
  assert.match(sql, /to authenticated/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /to service_role/);
});

test('RLS verification asserts zero crossover for same-tenant and cross-tenant', () => {
  const verify = readFileSync(join(process.cwd(), 'scripts/verify-rls.sql'), 'utf8');
  assert.match(verify, /cross-tenant/);
  assert.match(verify, /cross-business/);
  assert.match(verify, /raise exception/);
  assert.match(verify, /rollback/);
  assert.match(verify, /request\.jwt\.claims/);
});

test('business scoped tables all appear in the RLS migration', () => {
  const tenantDb = readFileSync(join(process.cwd(), 'src/lib/tenant-db.ts'), 'utf8');
  const sql = readFileSync(join(process.cwd(), 'scripts/migrate-rls.sql'), 'utf8');
  const start = tenantDb.indexOf('export const BUSINESS_SCOPED_TABLES');
  const end = tenantDb.indexOf(']);', start);
  const block = tenantDb.slice(start, end);
  const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => String(m[1]));
  assert.ok(names.length >= 30, 'expected 30+ business tables, got ' + names.length);
  for (const name of names) {
    assert.ok(sql.includes("'" + name + "'"), name + ' missing from RLS migration');
  }
});
