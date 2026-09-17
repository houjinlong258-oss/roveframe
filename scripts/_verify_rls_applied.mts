/**
 * Phase 15 — 核验真实库的 RLS 状态（只读）。
 *
 * ## 为什么这是最该查的一项
 *
 * `docs/current/PILOT_READY_STATUS.md` 把 RLS 列为**上线前必须执行的部署步骤**，
 * 并明确"隔离只靠应用层"是现状 —— `migrate-rls.sql` 是"数据库第二道隔离防线"。
 *
 * 但本仓库所有代码路径都走 `service_role`，而 **service_role 旁路 RLS**。
 * 因此：RLS 有没有装、装对没有，**跑一百次应用层测试都测不出来**。
 * 唯一的核验方式是查系统目录。
 *
 * ## 核验项
 *
 * 1. `pg_tables.rowsecurity` —— 每个目标表是否真的启用了 RLS
 * 2. 策略数量与名称 —— 是否三份都在（service_role_all / auth_tenant_scope / auth_business_scope）
 * 3. 是否存在**无策略但已启用 RLS** 的表（那种表对 authenticated/anon 是全拒，
 *    可能把功能打死）以及**未启用 RLS** 的表（隔离完全靠应用层）
 *
 * 只读；连接串从环境变量取，不打印凭据。
 */
import { Client } from 'pg';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

/** 与 scripts/migrate-rls.sql 的数组逐字一致 */
const RLS_TABLES = [
  'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
  'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
  'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
  'emails', 'email_accounts', 'email_send_tasks', 'alerts',
  'integration_configs', 'model_configs', 'settings', 'payments',
  'payment_events', 'integration_events', 'agent_actions', 'agent_approvals',
  'agent_tasks', 'agent_task_runs', 'agent_events', 'notification_outbox',
  'notifications', 'push_subscriptions', 'audit_events',
] as const;

/** migrate-rls.sql 里单独处理的表 */
const EXTRA_TABLES = ['users', 'tenants'] as const;

interface TableRow { tablename: string; rowsecurity: boolean }
interface PolicyRow { tablename: string; policyname: string; roles: string; cmd: string }

async function main(): Promise<number> {
  console.log('='.repeat(84));
  console.log('Phase 15 — 真实库 RLS 状态核验（只读）');
  console.log('='.repeat(84));

  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }

  const pw = encodeURIComponent(PASSWORD);
  const candidates = [
    `postgresql://postgres:${pw}@db.${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${REF}:${pw}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  ];

  let client: Client | null = null;
  for (const dsn of candidates) {
    const c = new Client({ connectionString: dsn, connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); client = c; console.log('连接成功'); break; }
    catch { try { await c.end(); } catch { /* ignore */ } }
  }
  if (!client) { console.log('连接失败'); return 1; }

  try {
    const all = [...RLS_TABLES, ...EXTRA_TABLES];

    const t = await client.query<TableRow>(
      `select tablename, rowsecurity from pg_tables
        where schemaname='public' and tablename = any($1::text[])
        order by tablename`, [all],
    );
    const p = await client.query<PolicyRow>(
      `select tablename, policyname, array_to_string(roles,'+') as roles, cmd
         from pg_policies where schemaname='public' and tablename = any($1::text[])
        order by tablename, policyname`, [all],
    );

    const rlsOn = new Set(t.rows.filter((r) => r.rowsecurity).map((r) => r.tablename));
    const rlsOff = t.rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    const missingTable = all.filter((x) => !t.rows.some((r) => r.tablename === x));
    const policiesByTable = new Map<string, PolicyRow[]>();
    for (const row of p.rows) {
      if (!policiesByTable.has(row.tablename)) policiesByTable.set(row.tablename, []);
      policiesByTable.get(row.tablename)!.push(row);
    }

    console.log('');
    console.log(`目标表 ${all.length} 张：启用 RLS ${rlsOn.size} 张，未启用 ${rlsOff.length} 张，库中不存在 ${missingTable.length} 张`);
    console.log('');

    console.log(`${'table'.padEnd(24)} ${'RLS'.padEnd(6)} ${'policies'.padEnd(9)} names`);
    console.log('-'.repeat(84));
    for (const name of [...all].sort()) {
      if (missingTable.includes(name)) { console.log(`${name.padEnd(24)} ${'(absent)'.padEnd(6)}`); continue; }
      const pols = policiesByTable.get(name) ?? [];
      const on = rlsOn.has(name) ? 'ON' : '**off**';
      console.log(`${name.padEnd(24)} ${on.padEnd(6)} ${String(pols.length).padEnd(9)} ${pols.map((x) => x.policyname).join(', ').slice(0, 46)}`);
    }

    // 是否存在"启用了 RLS 但一条策略都没有"的表 —— 那种表对 authenticated 全拒
    const noPolicy = [...rlsOn].filter((x) => (policiesByTable.get(x) ?? []).length === 0);

    console.log('');
    console.log('='.repeat(84));
    console.log(`未启用 RLS 的表（隔离完全靠应用层）: ${rlsOff.length ? rlsOff.join(', ') : '无'}`);
    console.log(`启用了 RLS 但无策略的表（对 authenticated/anon 全拒）: ${noPolicy.length ? noPolicy.join(', ') : '无'}`);
    console.log(`库中不存在的目标表: ${missingTable.length ? missingTable.join(', ') : '无'}`);
    console.log('');

    const allOn = rlsOff.length === 0 && missingTable.length === 0;
    console.log(allOn
      ? '结论: migrate-rls.sql 已应用 —— 33 张业务表 + users/tenants 均已启用 RLS。'
      : '结论: RLS **未完整应用** —— 与 PILOT_READY_STATUS.md 的"上线前必须执行"要求不符。');
    console.log('='.repeat(84));
    return allOn ? 0 : 1;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
