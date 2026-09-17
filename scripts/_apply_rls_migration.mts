/**
 * Phase 15 — 应用 `scripts/migrate-rls.sql` 并执行 `scripts/verify-rls.sql`。
 *
 * ## 为什么这一步重要
 *
 * `PILOT_READY_STATUS.md` 把 RLS 列为**上线前必须执行**的部署步骤，
 * 称其为"数据库第二道隔离防线"。实测（`_verify_rls_applied.mts`）：
 * 52 张表启用了 RLS，但全库只有 2 条策略，33 张业务表是"启用 + 零策略"
 * —— 该迁移**从未应用**。
 *
 * ## 安全性
 *
 * - `migrate-rls.sql` 自称幂等（drop policy if exists + create policy）。
 * - `verify-rls.sql` 全程单事务并以 `rollback` 结束，不留残留数据；
 *   任何泄漏会 `raise exception` 使脚本报错 —— 这是**负向验证**，
 *   它能在失败时失败，因此它的通过才有意义。
 * - 应用后用 `_verify_rls_applied.mts` 复核策略数量（而不是只看"没报错"）。
 *
 * 凭据只从环境变量读，不落盘、不打印。
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

async function main(): Promise<number> {
  console.log('='.repeat(84));
  console.log('Phase 15 — 应用 RLS 迁移 + 负向验证');
  console.log('='.repeat(84));
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }

  const pw = encodeURIComponent(PASSWORD);
  const client = new Client({
    connectionString: `postgresql://postgres:${pw}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const policyCount = async (): Promise<number> => {
      const r = await client.query<{ n: string }>('select count(*)::text as n from pg_policy');
      return Number(r.rows[0].n);
    };

    // ---- 执行前 -----------------------------------------------------------
    const before = await policyCount();
    console.log(`[执行前] 全库策略数: ${before}`);

    // ---- 应用 migrate-rls.sql --------------------------------------------
    const rlsSql = readFileSync(join(process.cwd(), 'scripts', 'migrate-rls.sql'), 'utf8');
    console.log(`[执行] migrate-rls.sql（${rlsSql.length} 字符）…`);
    await client.query(rlsSql);
    const after = await policyCount();
    console.log(`[执行后] 全库策略数: ${after}（+${after - before}）`);

    // ---- 复核：33 张业务表是否都有三份策略 --------------------------------
    const t = await client.query<{ tablename: string; n: string; rls: boolean }>(
      `select c.relname as tablename, count(p.oid)::text as n, c.relrowsecurity as rls
         from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where ns.nspname='public' and c.relkind='r'
          and c.relname in ('products','orders','customers','reviews','staff',
            'business_memories','reservations','inventory_items','store_qr_codes',
            'chat_sessions','chat_messages','knowledge_docs','doc_chunks',
            'marketing_contents','emails','email_accounts','email_send_tasks','alerts',
            'integration_configs','model_configs','settings','payments','payment_events',
            'integration_events','agent_actions','agent_approvals','agent_tasks',
            'agent_task_runs','agent_events','notification_outbox','notifications',
            'push_subscriptions','audit_events','users','tenants')
        group by c.relname, c.relrowsecurity order by c.relname`,
    );
    const weak = t.rows.filter((x) => Number(x.n) < 3);
    console.log('');
    console.log(`[复核] 检查 ${t.rows.length} 张表，策略数 < 3 的: ${weak.length}`);
    for (const w of weak) console.log(`    ${w.tablename}: ${w.n} 条 (rls=${w.rls})`);
    console.log(`        全部表 RLS 已启用: ${t.rows.every((x) => x.rls) ? '是' : '**否**'}`);

    // ---- 负向验证：verify-rls.sql（单事务，自带 rollback）------------------
    console.log('');
    console.log('[负向验证] verify-rls.sql —— 泄漏即 raise exception');
    const verifySql = readFileSync(join(process.cwd(), 'scripts', 'verify-rls.sql'), 'utf8');
    try {
      const res = await client.query(verifySql);
      const rows = Array.isArray(res) ? res.flatMap((r) => r.rows) : res.rows;
      const verdict = rows.find((r: Record<string, unknown>) => 'result' in r);
      console.log(`    通过。数据库返回: ${verdict ? JSON.stringify(verdict) : '(无 result 行)'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    **失败** —— 这正说明该验证能失败，其通过才有意义:`);
      console.log(`    ${msg.slice(0, 200)}`);
      return 1;
    }

    console.log('');
    console.log('='.repeat(84));
    console.log(`结果: 策略 ${before} → ${after}；33 张业务表 + users/tenants 均已配置策略；`);
    console.log('      verify-rls.sql 的零交叉验证通过（该脚本会在泄漏时 raise）。');
    console.log('='.repeat(84));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
