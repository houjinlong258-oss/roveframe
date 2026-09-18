/**
 * Phase 15 — 读取 `claim_agent_task_runs` 的定义（只读）。
 *
 * 背景：`agent_task_runs` 有 21 行**全部停在 pending**，而 worker.ts 记录的
 * 权威生命周期是 `pending → running → completed|failed`。
 * 也就是说**没有任何一次运行被真正认领过**。
 *
 * 要判断这是缺陷还是"没有到执行时间"，必须读 RPC 的认领条件
 * （租约、attempt 上限、时间窗等），而不是猜。
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

  console.log('='.repeat(84));
  console.log('Phase 15 — claim_agent_task_runs 定义与运行状态（只读）');
  console.log('='.repeat(84));

  try {
    const def = await client.query<{ pg_get_functiondef: string }>(
      `select pg_get_functiondef(p.oid) as pg_get_functiondef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'claim_agent_task_runs'`,
    );
    if (def.rows.length === 0) {
      console.log('** 数据库里没有 claim_agent_task_runs 函数 **');
      console.log('   ⇒ worker 调用它会失败，任务永远无法被认领（正是 pending 堆积的原因）');
      return 1;
    }
    console.log('');
    console.log('函数定义:');
    console.log(def.rows[0].pg_get_functiondef);

    // 运行行的真实状态与 attempt 分布
    const runs = await client.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from public.agent_task_runs group by status order by status`,
    );
    console.log('');
    console.log('agent_task_runs 状态分布:');
    for (const r of runs.rows) console.log(`  ${r.status}: ${r.n}`);

    const cols = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='agent_task_runs' order by ordinal_position`,
    );
    console.log('');
    console.log(`agent_task_runs 列: ${cols.rows.map((c) => c.column_name).join(', ')}`);
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
