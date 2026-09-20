/**
 * 通用清理：删除指定的探测/半成品租户及其全部从属行。
 *
 * ## 为什么不是一串手写的 delete
 *
 * 第一次尝试按"我猜的依赖顺序"删，被 `agent_tasks_business_id_fkey` 挡住了 ——
 * 说明这个库里的从属关系比我记得的多。手写清单必然漏，而且漏的表现是**删到一半停住**，
 * 留下更乱的半成品。
 *
 * 因此改成：从 information_schema 里**枚举**所有带 tenant_id / business_id 的表，
 * 反复迭代删除（每轮跳过仍被引用的），直到某轮没有任何行被删掉为止。
 * 这样新加的表会被自动纳入，不需要维护第二份清单。
 *
 * 只删白名单里的租户，按名字精确匹配 —— 删数据不靠"看起来像"。
 */
import { Pool } from 'pg';

const TARGET_NAMES = ['Probe Store', 'Verify Store', '424323Hou', 'Rollback Fresh', 'Rollback Probe'];

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const tenants = await pool.query<{ id: string; name: string }>(
    'select id, name from public.tenants where name = any($1::text[])', [TARGET_NAMES],
  );
  if (tenants.rows.length === 0) { console.log('没有匹配的租户，无需清理'); return; }

  const tenantIds = tenants.rows.map((r) => r.id);
  for (const t of tenants.rows) console.log(`目标: ${t.name}  ${t.id}`);

  // 1) 枚举所有带 tenant_id / business_id 的 public 表
  const cols = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema='public' and column_name in ('tenant_id','business_id')
      order by table_name`,
  );
  const tables = [...new Set(cols.rows.map((r) => r.table_name))];
  console.log(`\n涉及 ${tables.length} 张表（自动枚举，非手写清单）`);

  // 2) 反复迭代：先删得动的，直到一轮下来一行都没删掉
  let total = 0;
  for (let pass = 1; pass <= 12; pass += 1) {
    let deletedThisPass = 0;
    for (const table of tables) {
      for (const column of ['business_id', 'tenant_id']) {
        try {
          const r = await pool.query(
            `delete from public.${table} where ${column} = any($1::text[])`, [tenantIds],
          );
          if (r.rowCount && r.rowCount > 0) {
            deletedThisPass += r.rowCount;
            console.log(`  pass${pass}  ${table}.${column}  -${r.rowCount}`);
          }
        } catch {
          // 仍被引用 → 这轮跳过，下一轮再试。不报错、不中断：
          // 中断会留下比清理前更乱的状态。
        }
      }
    }
    total += deletedThisPass;
    if (deletedThisPass === 0) { console.log(`  pass${pass}  无进展，停止`); break; }
  }

  // 3) 最后删租户本身
  const t = await pool.query('delete from public.tenants where id = any($1::text[])', [tenantIds]);
  console.log(`\n共删除从属行 ${total} 行，租户 ${t.rowCount} 个`);

  const left = await pool.query<{ n: string }>('select count(*)::text as n from public.tenants');
  console.log(`剩余租户: ${left.rows[0]?.n}`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
