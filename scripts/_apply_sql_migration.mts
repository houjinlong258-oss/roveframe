/**
 * 应用一个迁移 SQL 到真实库（DDL 直连），并打印效果。
 *
 * Phase 15 已推翻"直连不可达"的旧结论：`db.<ref>.supabase.co` 本次可直连。
 * 密码只从环境变量读取，不落盘、不打印。
 *
 * 用法：
 *   $env:PGPASSWORD='...'; npx tsx scripts/_apply_sql_migration.mts scripts/migrate-x.sql
 *
 * 幂等性检验：同一文件连跑两次都必须成功。
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const file = process.argv[2];
if (!file) {
  console.error('用法: npx tsx scripts/_apply_sql_migration.mts <sql 文件>');
  process.exit(2);
}

const host = process.env.PGHOST;
const user = process.env.PGUSER;
const database = process.env.PGDATABASE ?? 'postgres';
const password = process.env.PGPASSWORD;

if (!host || !user || !password) {
  console.error('缺 PGHOST / PGUSER / PGPASSWORD 环境变量');
  process.exit(2);
}

async function main(): Promise<number> {
  const sql = readFileSync(file, 'utf8');
  console.log('='.repeat(84));
  console.log(`应用迁移: ${file}  (${sql.length} 字符)`);
  console.log(`目标: ${host} / ${database} / ${user}`);
  console.log('='.repeat(84));

  const pool = new Pool({
    host, user, database, password,
    port: Number(process.env.PGPORT ?? 5432),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });

  const t0 = Date.now();
  try {
    await pool.query(sql);
    console.log(`[OK] 迁移执行成功，用时 ${Date.now() - t0} ms`);
  } catch (e) {
    console.error(`[FAIL] ${e instanceof Error ? e.message : String(e)}`);
    await pool.end();
    return 1;
  }

  // 效果核验：不只看"没报错"
  const checks: Array<[string, string]> = [
    ['subscription_plans', 'select count(*)::int as n from public.subscription_plans'],
    ['tenant_subscriptions', 'select count(*)::int as n from public.tenant_subscriptions'],
    ['feature_entitlements', 'select count(*)::int as n from public.feature_entitlements'],
    ['plans by slug', "select string_agg(slug || '=' || price_amount, ', ' order by price_amount) as s from public.subscription_plans"],
    ['subs by status', 'select string_agg(status || \':\' || n, \', \') as s from (select status, count(*)::text as n from public.tenant_subscriptions group by status) x'],
    ['plan_id 都存在', `select count(*)::int as n from public.tenant_subscriptions ts where ts.plan_id is not null and not exists (select 1 from public.subscription_plans p where p.id = ts.plan_id)`],
    ['无订阅的 tenant', 'select count(*)::int as n from public.tenants t where not exists (select 1 from public.tenant_subscriptions s where s.tenant_id = t.id)'],
    ['email_unsubscribes 表存在', "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='email_unsubscribes'"],
    ['email_unsubscribes 索引', "select count(*)::int as n from pg_indexes where schemaname='public' and tablename='email_unsubscribes'"],
    ['email_send_tasks.unsubscribe_token', "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='email_send_tasks' and column_name in ('unsubscribe_token','unsubscribe_url')"],
    ['email_unsubscribes 行数', 'select count(*)::int as n from public.email_unsubscribes'],
  ];
  for (const [label, q] of checks) {
    try {
      const { rows } = await pool.query(q);
      console.log(`  ${label.padEnd(22)} ${JSON.stringify(rows[0])}`);
    } catch (e) {
      console.log(`  ${label.padEnd(22)} ERR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await pool.end();
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
