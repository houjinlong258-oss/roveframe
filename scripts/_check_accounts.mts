/**
 * 收尾诊断 + 清理（只读诊断 + 精确删除我自己造的测试数据）。
 *
 * 做三件事：
 *   1. 查 `houjinlong258@gmail.com` 这个账号在不在 auth.users 里（只读）
 *   2. 列出所有租户，让人能一眼看出哪些是测试残留
 *   3. --cleanup 时**只删**本会话探测脚本建的那几个租户（按名字精确匹配）
 *
 * 用法：
 *   npx tsx scripts/_check_accounts.mts
 *   npx tsx scripts/_check_accounts.mts --cleanup
 */
import { Pool } from 'pg';

const cleanup = process.argv.includes('--cleanup');
/** 本会话探测时建的名字。刻意用白名单而不是模糊匹配 —— 删数据不能靠"看起来像"。 */
const PROBE_NAMES = ['Probe Store', 'Probe Store 2', 'Verify Store'];

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const users = await pool.query<{ email: string; created_at: string; confirmed: string }>(
    `select email, created_at::text as created_at,
            (email_confirmed_at is not null)::text as confirmed
       from auth.users order by created_at asc`,
  );
  console.log(`=== auth.users（${users.rows.length} 个）===`);
  for (const u of users.rows) {
    console.log(`  ${u.email}  建 ${u.created_at.slice(0, 19)}  已确认=${u.confirmed}`);
  }

  const tenants = await pool.query<{ id: string; name: string; slug: string; created_at: string }>(
    `select t.id, t.name, t.slug, t.created_at::text as created_at
       from public.tenants t order by t.created_at asc`,
  );
  console.log(`\n=== tenants（${tenants.rows.length} 个）===`);
  for (const t of tenants.rows) {
    const probe = PROBE_NAMES.includes(t.name) ? '  ← 我的探测残留' : '';
    console.log(`  ${t.name.padEnd(24)} ${t.id}  ${t.created_at.slice(0, 19)}${probe}`);
  }

  const businesses = await pool.query<{ n: string }>('select count(*)::text as n from public.businesses');
  const products = await pool.query<{ n: string }>('select count(*)::text as n from public.products');
  console.log(`\nbusinesses=${businesses.rows[0]?.n}  products=${products.rows[0]?.n}`);

  if (!cleanup) {
    console.log('\n（加 --cleanup 删除上面标出的探测残留）');
    return;
  }

  console.log('\n=== 清理探测残留 ===');
  for (const name of PROBE_NAMES) {
    const t = await pool.query<{ id: string }>('select id from public.tenants where name = $1', [name]);
    if (t.rows.length === 0) { console.log(`  ${name}: 无`); continue; }
    const tenantId = t.rows[0].id;
    // 按依赖顺序删：业务表 → 业务 → 租户。只删这个 tenant 名下的。
    const bizIds = (await pool.query<{ id: string }>('select id from public.businesses where tenant_id = $1', [tenantId])).rows.map((r) => r.id);
    if (bizIds.length > 0) {
      await pool.query('delete from public.delivery_positions where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.delivery_orders where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.orders where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.products where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.settings where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.tenant_subscriptions where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.users where tenant_id = $1', [tenantId]);
      await pool.query('delete from public.businesses where tenant_id = $1', [tenantId]);
    }
    await pool.query('delete from public.tenants where id = $1', [tenantId]);
    console.log(`  ${name}: 已删（tenant ${tenantId}）`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
