/**
 * Phase 15 — 列类型勘察（只读），为修 `migrate-rls.sql` 提供准确依据。
 *
 * `migrate-rls.sql` 应用时报：
 *   operator does not exist: character varying = uuid
 *   in policy products_auth_tenant_scope ... tenant_id = (select tenant_id from public.users ...)
 *
 * 即策略里的等值比较两侧类型不一致。本脚本把相关列的真实类型打印出来，
 * 不做任何猜测。同时打印 `auth.uid()` 的返回类型。
 */
import { Client } from 'pg';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

const TABLES = [
  'tenants', 'businesses', 'users', 'settings', 'products', 'orders',
  'customers', 'reviews', 'staff', 'business_memories', 'reservations',
  'inventory_items', 'store_qr_codes', 'chat_sessions', 'chat_messages',
  'knowledge_docs', 'doc_chunks', 'marketing_contents', 'emails',
  'email_accounts', 'email_send_tasks', 'alerts', 'integration_configs',
  'model_configs', 'payments', 'payment_events', 'integration_events',
  'agent_actions', 'agent_approvals', 'agent_tasks', 'agent_task_runs',
  'agent_events', 'notification_outbox', 'notifications', 'push_subscriptions',
  'audit_events',
] as const;

async function main(): Promise<number> {
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }
  const client = new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('='.repeat(78));
  console.log('Phase 15 — RLS 策略涉及的列类型');
  console.log('='.repeat(78));

  try {
    const r = await client.query<{ table_name: string; column_name: string; data_type: string; udt: string }>(
      `select table_name, column_name, data_type, udt_name as udt
         from information_schema.columns
        where table_schema='public'
          and column_name in ('id','tenant_id','business_id')
          and table_name = any($1::text[])
        order by table_name, column_name`, [TABLES],
    );

    console.log(`${'table'.padEnd(24)} ${'column'.padEnd(14)} ${'data_type'.padEnd(20)} udt`);
    console.log('-'.repeat(78));
    for (const row of r.rows) {
      console.log(`${row.table_name.padEnd(24)} ${row.column_name.padEnd(14)} ${row.data_type.padEnd(20)} ${row.udt}`);
    }

    // auth.uid() 的返回类型
    try {
      const f = await client.query<{ n: string; t: string }>(
        `select n.nspname||'.'||p.proname as n, pg_catalog.format_type(p.prorettype, null) as t
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proname = 'uid' order by 1`,
      );
      console.log('');
      console.log('auth.uid() 相关函数:');
      for (const row of f.rows) console.log(`    ${row.n}  →  returns ${row.t}`);
      if (f.rows.length === 0) console.log('    (未找到 uid 函数)');
    } catch (e) {
      console.log(`auth.uid() 查询失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 分组：哪些是 uuid，哪些是 varchar
    const uuidCols = r.rows.filter((x) => x.udt === 'uuid').map((x) => `${x.table_name}.${x.column_name}`);
    const textCols = r.rows.filter((x) => x.udt !== 'uuid').map((x) => `${x.table_name}.${x.column_name} (${x.udt})`);
    console.log('');
    console.log('='.repeat(78));
    console.log(`uuid 列 (${uuidCols.length}): ${uuidCols.slice(0, 8).join(', ')}${uuidCols.length > 8 ? ' …' : ''}`);
    console.log(`非 uuid 列 (${textCols.length}): ${textCols.slice(0, 8).join(', ')}${textCols.length > 8 ? ' …' : ''}`);
    console.log('');
    console.log('判读: 策略里 `tenant_id = (select tenant_id from public.users ...)` 的');
    console.log('      左侧若是 varchar、右侧若是 uuid（或反之），Postgres 会直接报 42883。');
    console.log('='.repeat(78));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 400).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
