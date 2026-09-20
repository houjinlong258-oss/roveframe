/**
 * 两件收尾诊断（只读）：
 *   1. customer_sessions 上到底有哪些索引 —— 探测脚本里写的名字可能是错的
 *   2. products 的重复行 —— migrate.sql 建唯一索引失败的真正原因
 */
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const idx = await pool.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where schemaname='public' and tablename in ('customer_sessions','customer_accounts','customer_addresses')
      order by tablename, indexname`,
  );
  console.log('=== 顾客相关表的索引 ===');
  for (const row of idx.rows) console.log('  ' + row.indexname + '\n     ' + row.indexdef);

  console.log('\n=== products 重复分组 ===');
  const dup = await pool.query(
    `select tenant_id, business_id, source, external_id, count(*)::int as n
       from public.products group by 1,2,3,4 having count(*) > 1 order by n desc limit 10`,
  );
  if (dup.rows.length === 0) console.log('  无重复分组');
  for (const row of dup.rows) console.log('  ' + JSON.stringify(row));

  const summary = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where external_id is null)::int as null_ext,
            count(distinct (tenant_id, business_id, source, external_id))::int as distinct_keys
       from public.products`,
  );
  console.log('  products 汇总:', JSON.stringify(summary.rows[0]));

  await pool.end();
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1); });
