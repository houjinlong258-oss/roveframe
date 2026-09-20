/**
 * 诊断：登录为什么 500（Cannot coerce the result to a single JSON object）。
 *
 * 这个报错意味着 PostgREST 的 .single()/.maybeSingle() 拿到的不是恰好一行。
 * 分两种可能，必须量出来才知道是哪种：
 *   · 0 行 —— 账号建了但 public.users 关联行没建
 *   · 多行 —— 有重复行，那本身是另一个更严重的问题
 *
 * 只读。
 */
import { Pool } from 'pg';

const USER_ID = process.argv[2];
if (!USER_ID) { console.error('用法: npx tsx scripts/_diag_staff_login.mts <authUserId>'); process.exit(2); }

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const auth = await pool.query(
    'select id, email, (email_confirmed_at is not null) as confirmed, raw_app_meta_data from auth.users where id = $1',
    [USER_ID],
  );
  console.log('=== auth.users ===');
  for (const r of auth.rows) console.log('  ' + JSON.stringify(r));

  const byId = await pool.query('select id, email, role, tenant_id, business_id from public.users where id = $1', [USER_ID]);
  console.log(`\n=== public.users by id ===  行数=${byId.rows.length}`);
  for (const r of byId.rows) console.log('  ' + JSON.stringify(r));

  const email = auth.rows[0]?.email;
  if (email) {
    const byEmail = await pool.query('select id, email, role, tenant_id from public.users where lower(email) = lower($1)', [email]);
    console.log(`\n=== public.users by email ===  行数=${byEmail.rows.length}`);
    for (const r of byEmail.rows) console.log('  ' + JSON.stringify(r));
  }

  const staff = await pool.query('select id, name, user_id, position, hired_at from public.staff where user_id = $1', [USER_ID]);
  console.log(`\n=== staff ===  行数=${staff.rows.length}`);
  for (const r of staff.rows) console.log('  ' + JSON.stringify(r));

  const dupes = await pool.query('select id, count(*)::int n from public.users group by id having count(*) > 1');
  console.log(`\n=== public.users 主键重复 ===  ${dupes.rows.length} 组`);
}

main().then(() => pool.end()).catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
