import { Pool } from "pg";
const pool = new Pool({ host: process.env.PGHOST, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD, port: 5432, ssl: { rejectUnauthorized: false } });
const noRls = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relrowsecurity = false order by c.relname`);
console.log("未启用 RLS 的表:", noRls.rows.length === 0 ? "**0 张（全部覆盖）**" : noRls.rows.map(r=>r.relname).join(', '));
const zeroPol = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relrowsecurity = true
  and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
  order by c.relname`);
console.log("已启用 RLS 但零策略的表:", zeroPol.rows.length === 0 ? "**0 张**" : zeroPol.rows.map(r=>r.relname).join(', '));
const tot = await pool.query(`select count(*)::int n from pg_policies where schemaname='public'`);
console.log("策略总数:", tot.rows[0].n);
await pool.end();
