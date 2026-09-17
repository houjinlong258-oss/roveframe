/**
 * Phase 15 — 查 `verify-rls.sql` 夹具插入所需的最小列集（只读）。
 *
 * `verify-rls.sql` 的夹具报：
 *   null value in column "name" of relation "tenants" violates not-null constraint
 * 即它写于 schema 变更之前，夹具缺列。本脚本列出四张夹具表里
 * **NOT NULL 且无默认值**的列 —— 这些是 insert 时必须提供的。
 */
import { Client } from 'pg';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

async function main(): Promise<number> {
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }
  const client = new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('='.repeat(78));
  console.log('Phase 15 — 夹具表 NOT NULL 且无默认值的列');
  console.log('='.repeat(78));

  try {
    const r = await client.query<{
      table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public'
          and table_name in ('tenants','businesses','users','orders')
        order by table_name, ordinal_position`,
    );

    const byTable = new Map<string, typeof r.rows>();
    for (const row of r.rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
      byTable.get(row.table_name)!.push(row);
    }

    for (const [table, cols] of byTable) {
      const required = cols.filter((c) => c.is_nullable === 'NO' && c.column_default === null);
      console.log('');
      console.log(`--- ${table} （共 ${cols.length} 列，必须提供 ${required.length} 列）---`);
      for (const c of required) {
        console.log(`    ${c.column_name.padEnd(24)} ${c.data_type}`);
      }
      const optional = cols.filter((c) => !(c.is_nullable === 'NO' && c.column_default === null));
      console.log(`    （其余 ${optional.length} 列可空或有默认值）`);
    }

    console.log('');
    console.log('='.repeat(78));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 400).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
