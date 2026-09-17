/**
 * Phase 15 — pg_policies 查询有效性核验（只读）。
 *
 * `_verify_rls_applied.mts` 报"33 张表启用了 RLS 但 0 条策略"。这个结论有冲击力，
 * 因此必须先用**对照**确认查询本身没问题，而不是接受一个可能查错的结论。
 *
 * 本脚本做三件事：
 *   1. 不带任何过滤统计 `pg_policies` 全库行数（若为 0，先怀疑权限/视图）
 *   2. 用 postgres 身份尝试 `create policy` 的可行性探测 —— **不创建**，
 *      只读 `pg_class.relrowsecurity` 与 `pg_policy` 系统表交叉验证
 *   3. 直查 `pg_policy` 原始表（pg_policies 是视图，可能受权限影响）
 */
import { Client } from 'pg';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

async function main(): Promise<number> {
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }
  const pw = encodeURIComponent(PASSWORD);
  const client = new Client({
    connectionString: `postgresql://postgres:${pw}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('='.repeat(80));
  console.log('Phase 15 — pg_policies / pg_policy 有效性核验（只读）');
  console.log('='.repeat(80));

  try {
    // 1) pg_policies 全库计数（不带过滤）
    const allPolicies = await client.query<{ n: string }>('select count(*)::text as n from pg_policies');
    console.log(`[1] pg_policies 全库行数: ${allPolicies.rows[0].n}`);

    // 2) pg_policy 原始表计数（视图可能因权限返回空）
    const rawPolicies = await client.query<{ n: string }>('select count(*)::text as n from pg_policy');
    console.log(`[2] pg_policy  全库行数: ${rawPolicies.rows[0].n}`);

    // 3) 当前角色与权限
    const who = await client.query<{ current_user: string; is_super: boolean; rolbypassrls: boolean }>(
      `select current_user, rolsuper as is_super, rolbypassrls
         from pg_roles where rolname = current_user`,
    );
    console.log(`[3] 当前角色: ${who.rows[0].current_user}  superuser=${who.rows[0].is_super}  bypassrls=${who.rows[0].rolbypassrls}`);

    // 4) 原始表按表统计策略数（交叉验证视图结论）
    const byTable = await client.query<{ tablename: string; n: string }>(
      `select c.relname as tablename, count(p.oid)::text as n
         from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where ns.nspname = 'public' and c.relkind = 'r'
        group by c.relname
        having count(p.oid) > 0
        order by c.relname`,
    );
    console.log(`[4] pg_policy 中"有策略"的表数: ${byTable.rows.length}`);
    for (const r of byTable.rows) console.log(`      ${r.tablename}: ${r.n}`);

    // 5) 启用 RLS 的表数（pg_class.relrowsecurity）
    const rlsCount = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
        where ns.nspname='public' and c.relkind='r' and c.relrowsecurity`,
    );
    console.log(`[5] public schema 中启用 RLS 的表数: ${rlsCount.rows[0].n}`);

    // 6) FORCE RLS 情况（表 owner 是否也受策略约束）
    const forced = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
        where ns.nspname='public' and c.relkind='r' and c.relforcerowsecurity`,
    );
    console.log(`[6] 启用 FORCE RLS 的表数: ${forced.rows[0].n}`);

    console.log('');
    console.log('='.repeat(80));
    console.log('判读:');
    console.log('  若 [1] 与 [2] 一致且 >0，而 [4] 为空 → 策略确实不存在（不是查询问题）。');
    console.log('  若 [2] > [1] → pg_policies 视图受权限过滤，需以 pg_policy 为准。');
    console.log('='.repeat(80));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 400).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
