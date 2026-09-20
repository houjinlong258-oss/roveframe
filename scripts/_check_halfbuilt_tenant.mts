/**
 * 核实一个猜测：注册流程是否留下了"半成品"租户。
 *
 * 线索：`auth.users` 里 `houjinlong258@gmail.com` 只有一个（2026-09-09 建），
 * 但 `tenants` 里多了一个 2026-09-19 15:48:42 建的 `424323Hou`。
 * 注册路由的顺序是 建租户 → 建业务 → 建订阅 → 建 auth 用户 → 建 public.users。
 * 若中间某步失败，前面的产物会留下 —— 那就是半成品。
 *
 * 只读，不做任何写入。
 */
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const rows = await pool.query<{
    id: string; name: string; created: string;
    businesses: string; users: string; subs: string; settings: string;
  }>(
    `select t.id, t.name, t.created_at::text as created,
       (select count(*)::text from public.businesses b where b.tenant_id = t.id) as businesses,
       (select count(*)::text from public.users u where u.tenant_id = t.id) as users,
       (select count(*)::text from public.tenant_subscriptions s where s.tenant_id = t.id) as subs,
       (select count(*)::text from public.settings st where st.tenant_id = t.id) as settings
     from public.tenants t order by t.created_at asc`,
  );

  console.log('tenant                        业务  users 订阅 settings   判定');
  console.log('-'.repeat(78));
  for (const r of rows.rows) {
    const complete = Number(r.businesses) > 0 && Number(r.users) > 0;
    const verdict = complete ? '完整' : '**半成品（注册中断）**';
    console.log(
      `${r.name.padEnd(28)} ${r.businesses.padStart(4)} ${r.users.padStart(6)} ${r.subs.padStart(4)} ${r.settings.padStart(8)}   ${verdict}`,
    );
  }

  // 半成品租户的详情：它到底建到哪一步停的
  const broken = await pool.query<{ id: string; name: string }>(
    `select t.id, t.name from public.tenants t
      where not exists (select 1 from public.users u where u.tenant_id = t.id)
      order by t.created_at asc`,
  );
  console.log(`\n没有任何 public.users 行的租户：${broken.rows.length} 个`);
  for (const t of broken.rows) {
    const b = await pool.query<{ name: string; created_at: string }>(
      'select name, created_at::text as created_at from public.businesses where tenant_id = $1', [t.id]);
    console.log(`  ${t.name} (${t.id})`);
    for (const biz of b.rows) console.log(`      业务「${biz.name}」建于 ${biz.created_at.slice(0, 19)}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
