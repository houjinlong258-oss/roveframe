/**
 * Phase 18 —— 数据库现状探测（只读，零写入）。
 *
 * 为什么要先跑它：另一个会话的记录声称"4 个迁移已应用、种子已灌"，
 * 而本项目此前的只读探测（PostgREST）报告这些表/列不存在。
 * 两个说法冲突时不能靠猜 —— 先查清楚再决定要不要跑 DDL。
 *
 * 用法（密码只走环境变量，不落盘、不打印）：
 *   $env:PGHOST='db.<ref>.supabase.co'; $env:PGUSER='postgres';
 *   $env:PGPASSWORD='...'; npx tsx scripts/_probe_p18_state.mts
 */
import { Pool } from 'pg';

const host = process.env.PGHOST;
const user = process.env.PGUSER;
const password = process.env.PGPASSWORD;
const database = process.env.PGDATABASE ?? 'postgres';
const port = Number(process.env.PGPORT ?? 5432);

if (!host || !user || !password) {
  console.error('缺 PGHOST / PGUSER / PGPASSWORD');
  process.exit(2);
}

/** 本次要落地/核对的对象：表 → 是否已存在 */
const EXPECTED_TABLES = [
  'public_sites',
  'delivery_orders',
  'delivery_positions',
  'staff_shifts',
  'staff_attendance',
  'staff_care_notes',
  'staff_care_tasks',
  'customer_accounts',
  'customer_sessions',
  'customer_addresses',
];

/** 关键列：迁移是否真的落到了列上（表存在但列缺失是最常见的半吊子状态） */
const EXPECTED_COLUMNS: [string, string][] = [
  ['staff', 'user_id'],
  ['settings', 'delivery'],
  ['settings', 'wellbeing'],
  ['staff', 'birthday'],
  ['staff', 'hired_at'],
  ['delivery_orders', 'dest_lat'],
  ['delivery_orders', 'dest_lng'],
  ['orders', 'idempotency_fingerprint'],
];

async function main(): Promise<number> {
  const pool = new Pool({
    host, user, password, database, port,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });

  try {
    const version = await pool.query<{ version: string }>('select version() as version');
    console.log('连接成功:', String(version.rows[0]?.version ?? '').split(',')[0]);

    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])
        order by table_name`,
      [EXPECTED_TABLES],
    );
    const have = new Set(tables.rows.map((r) => r.table_name));
    console.log('\n=== 表 ===');
    for (const t of EXPECTED_TABLES) {
      console.log(`  ${have.has(t) ? '存在  ' : '缺失  '}${t}`);
    }

    console.log('\n=== 关键列 ===');
    for (const [table, column] of EXPECTED_COLUMNS) {
      const result = await pool.query<{ n: string }>(
        `select count(*)::text as n from information_schema.columns
          where table_schema='public' and table_name=$1 and column_name=$2`,
        [table, column],
      );
      const exists = Number(result.rows[0]?.n ?? '0') > 0;
      console.log(`  ${exists ? '存在  ' : '缺失  '}${table}.${column}`);
    }

    // 索引：并发安全靠它，不是靠代码
    const indexes = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname='public' and indexname = any($1::text[])
        order by indexname`,
      [[
        'staff_attendance_open_key',
        'orders_web_idempotency_idx',
        'delivery_orders_order_key',
        'staff_user_id_key',
        'public_sites_slug_key',
        'customer_sessions_token_hash_key',
      ]],
    );
    console.log('\n=== 关键索引 ===');
    const idx = new Set(indexes.rows.map((r) => r.indexname));
    for (const name of [
      'staff_attendance_open_key', 'orders_web_idempotency_idx', 'delivery_orders_order_key',
      'staff_user_id_key', 'public_sites_slug_key', 'customer_sessions_token_hash_key',
    ]) {
      console.log(`  ${idx.has(name) ? '存在  ' : '缺失  '}${name}`);
    }

    // 种子数据：Hermes 记录声称灌过
    const counts = await pool.query<{ tenants: string; businesses: string; products: string; orders: string }>(
      `select
         (select count(*)::text from public.tenants)   as tenants,
         (select count(*)::text from public.businesses) as businesses,
         (select count(*)::text from public.products)  as products,
         (select count(*)::text from public.orders)    as orders`,
    );
    console.log('\n=== 现有数据量 ===');
    console.log(' ', JSON.stringify(counts.rows[0]));

    return 0;
  } catch (error) {
    console.error('[FAIL]', error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
