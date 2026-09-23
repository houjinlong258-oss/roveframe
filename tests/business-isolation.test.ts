import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  BUSINESS_SCOPED_TABLES,
  plainDelete,
  plainInsert,
  plainTable,
  plainUpdate,
  scopedTable,
  tenantTable,
} from '../src/lib/tenant-db';

const read = (path: string): string => readFileSync(path, 'utf8');

const BUSINESS_TABLES = [
  'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
  'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
  'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
  'emails', 'email_accounts', 'email_send_tasks', 'alerts',
  'integration_configs', 'model_configs', 'settings', 'payments',
  'payment_events', 'integration_events', 'agent_actions', 'agent_approvals', 'agent_tasks',
  'agent_task_runs', 'agent_events', 'notification_outbox', 'notifications',
  'push_subscriptions',
] as const;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('P0-5 business isolation contracts', () => {
  test('business tables fail closed without business scope', () => {
    assert.throws(
      () => scopedTable({ tenantId: 'tenant-1', businessId: null, userId: 'user-1', role: 'owner' }, 'orders'),
      /business scope is required/,
    );
    assert.throws(
      () => tenantTable('tenant-1', 'orders'),
      /tenant-only data access is forbidden/,
    );
    assert.ok(BUSINESS_SCOPED_TABLES.has('orders'));
    assert.ok(BUSINESS_SCOPED_TABLES.has('integration_configs'));
    assert.ok(BUSINESS_SCOPED_TABLES.has('knowledge_docs'));
  });

  test('every direct business-table access has scope or a reviewed control-plane exception', () => {
    const tablePattern = BUSINESS_TABLES.join('|');
    const accessPattern = new RegExp(`\\.from\\('(${tablePattern})'\\)`, 'g');
    const reviewedExceptions = new Set([
      'src/app/api/admin/providers/route.ts:model_configs',
      'src/app/api/admin/tenants/[id]/route.ts:model_configs',
      'src/lib/boot-check.ts:orders',
      'src/app/api/integrations/[provider]/sync/route.ts:orders',
      'src/app/api/settings/models/route.ts:model_configs',
      'src/lib/enterprise/memory.ts:knowledge_docs',
      'src/lib/notifications/outbox.ts:notification_outbox',
      'src/lib/email/outgoing.ts:email_send_tasks',
      'src/lib/email/imap-sync.ts:emails',
      // Phase 19：平台级运维指标。与上面两个队列 worker 同一形态 ——
      // 它们按定义要跨租户工作（一次抓取要看全平台积压），并且**只导出计数**：
      // 没有 tenant_id、没有金额、没有任何单行。指标端点自身需要
      // X-RoveAgent-Key 或平台管理员会话（见 src/app/api/metrics/route.ts）。
      //
      // 为什么必须在这里登记而不是"在语句里写上 business_id"：那会让指标变成
      // 只统计某一个租户，而这条指标的全部意义是回答"平台有没有东西卡住"。
      'src/app/api/metrics/route.ts:payment_events',
      'src/app/api/metrics/route.ts:payments',
    ]);
    const unexplained: string[] = [];

    for (const file of sourceFiles('src')) {
      const source = read(file);
      for (const match of source.matchAll(accessPattern)) {
        const start = match.index;
        const semicolon = source.indexOf(';', start);
        const end = semicolon >= 0 && semicolon - start <= 1_500 ? semicolon : start + 1_500;
        const statement = source.slice(start, end);
        if (!statement.includes('business_id')) {
          const key = `${file}:${match[1]}`;
          if (!reviewedExceptions.has(key)) unexplained.push(key);
        }
      }
    }

    assert.deepEqual(unexplained, []);

    // The exceptions are deliberate: platform admin/schema discovery, or a
    // pre-scoped row/query variable whose scope is asserted here.
    assert.match(read('src/app/api/integrations/[provider]/sync/route.ts'), /upsert\(\{[\s\S]{0,200}business_id: ctx\.businessId/);
    assert.match(read('src/app/api/settings/models/route.ts'), /record\.business_id = context\.businessId/);
    assert.match(read('src/lib/enterprise/memory.ts'), /q = q\.eq\('tenant_id', tenantId\)\.eq\('business_id', businessId\)/);
    assert.match(read('src/lib/notifications/outbox.ts'), /const row = \{[\s\S]{0,160}business_id: input\.businessId/);
    assert.match(read('src/lib/email/imap-sync.ts'), /tenant_id: input\.account\.tenant_id,[\s\S]{0,100}business_id: input\.account\.business_id/);
  });

  test('integration and settings uniqueness is tenant + business + provider', () => {
    const schema = read('src/storage/database/shared/schema.ts');
    const migration = read('scripts/migrate.sql');
    const businessMigration = read('scripts/migrate-business-tables.sql');

    for (const source of [schema, migration, businessMigration]) {
      assert.match(source, /integration_configs_[a-z_]*(?:idx|key)[\s\S]{0,160}tenant_id[\s\S]{0,80}business_id[\s\S]{0,80}provider/);
      assert.match(source, /model_configs_[a-z_]*(?:idx|key)[\s\S]{0,160}tenant_id[\s\S]{0,80}business_id[\s\S]{0,80}provider/);
      assert.doesNotMatch(source, /unique[^\n]*(?:integration|model)_configs[^\n]*\(tenant_id, provider\)/);
    }
    assert.match(migration, /settings_tenant_business_key[\s\S]{0,120}\(tenant_id, business_id\)/);
  });

  test('webhooks resolve and mutate one exact business', () => {
    const route = read('src/app/api/webhooks/[provider]/route.ts');
    assert.match(route, /searchParams\.get\('business'\)/);
    assert.match(route, /\.from\('integration_configs'\)[\s\S]{0,220}\.eq\('tenant_id',[\s\S]{0,100}\.eq\('business_id'/);
    assert.match(route, /\.from\('payment_events'\)\.insert\([\s\S]{0,160}business_id: businessId/);
    assert.match(route, /\.from\('orders'\)\.upsert\([\s\S]{0,180}tenant_id: tenantId,[\s\S]{0,80}business_id: businessId/);
  });

  test('RAG RPC requires and enforces both scope identifiers', () => {
    const sql = read('scripts/migrate-business-tables.sql');
    assert.match(sql, /filter_tenant_id varchar\(36\),\s*filter_business_id varchar\(36\)/);
    assert.match(sql, /c\.tenant_id = filter_tenant_id/);
    assert.match(sql, /c\.business_id = filter_business_id/);
    assert.match(sql, /d\.tenant_id = filter_tenant_id/);
    assert.match(sql, /d\.business_id = filter_business_id/);
  });

  test('ambiguous legacy rows abort instead of guessing a business', () => {
    const migration = read('scripts/migrate.sql');
    assert.match(migration, /having count\(\*\) = 1/);
    assert.match(migration, /business scope backfill required/);
    assert.doesNotMatch(
      migration,
      /set business_id = business\.id from public\.businesses business where row\.business_id is null/,
    );
  });

  test('P0-3 plain* helpers reject business tables (no unfiltered cross-tenant access)', () => {
    // 业务表无论读写都不允许无过滤访问；平台表不受影响。
    for (const table of ['products', 'integration_configs', 'settings', 'agent_approvals']) {
      assert.throws(() => plainTable(table), /unfiltered data access is forbidden for business table/);
      assert.throws(() => plainInsert(table, {}), /unfiltered data access is forbidden for business table/);
      assert.throws(() => plainUpdate(table, 'id', {}), /unfiltered data access is forbidden for business table/);
      assert.throws(() => plainDelete(table, 'id'), /unfiltered data access is forbidden for business table/);
    }
  });

  test('P0-3 inventory route reads integration_configs through scopedTable (tenant+business)', () => {
    const src = read('src/app/api/business/inventory/route.ts');
    assert.ok(!/import\s*\{[^}]*plainTable/.test(src), 'inventory 路由禁止导入 plainTable');
    assert.match(src, /scopedTable\(\s*ctx,\s*'integration_configs'/);
    assert.match(src, /\.eq\('provider', 'erpnext'\)/);
  });
});
