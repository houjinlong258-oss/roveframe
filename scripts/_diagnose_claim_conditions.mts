/**
 * Phase 15 — 为什么 21 行 pending 运行没有被认领：逐条件判定（只读）。
 *
 * `claim_agent_task_runs` 的候选条件是：
 *   r.status='pending'
 *   AND t.status='active'
 *   AND coalesce(r.available_at, r.created_at) <= now()
 *   AND r.claimed_at is null
 *
 * 把这四个条件**逐个**在真实数据上求值，就能定位是哪一条挡住了，
 * 而不是猜"worker 没跑"。
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

  console.log('='.repeat(88));
  console.log('Phase 15 — 认领条件逐条判定');
  console.log('='.repeat(88));

  try {
    const now = await client.query<{ now: string }>('select now()::text as now');
    console.log(`数据库当前时间: ${now.rows[0].now}`);
    console.log('');

    const r = await client.query<{
      id: string; status: string; task_status: string | null; task_type: string | null;
      task_name: string | null; available_at: string | null; created_at: string;
      claimed_at: string | null; attempt: number; max_attempts: number; cond_ok: boolean;
    }>(
      `select r.id, r.status, t.status as task_status, t.task_type, t.name as task_name,
              r.available_at::text, r.created_at::text, r.claimed_at::text,
              r.attempt, r.max_attempts,
              (r.status='pending' and t.status='active'
               and coalesce(r.available_at, r.created_at) <= now()
               and r.claimed_at is null) as cond_ok
         from public.agent_task_runs r
         left join public.agent_tasks t on t.id = r.task_id
        order by r.created_at`,
    );

    console.log(`${'status'.padEnd(9)} ${'task_status'.padEnd(12)} ${'type'.padEnd(26)} ${'available_at'.padEnd(20)} ${'claimed'.padEnd(20)} att  ok`);
    console.log('-'.repeat(110));
    for (const row of r.rows) {
      console.log(
        `${row.status.padEnd(9)} ${String(row.task_status ?? '(NO TASK)').padEnd(12)} `
        + `${String(row.task_type ?? '-').slice(0, 24).padEnd(26)} `
        + `${String(row.available_at ?? 'null').slice(0, 19).padEnd(20)} `
        + `${String(row.claimed_at ?? 'null').slice(0, 19).padEnd(20)} `
        + `${row.attempt}/${row.max_attempts}  ${row.cond_ok ? 'YES' : 'no'}`,
      );
    }

    const okCount = r.rows.filter((x) => x.cond_ok).length;
    console.log('');
    console.log(`满足全部认领条件的行: ${okCount}/${r.rows.length}`);

    // 各条件分别挡住了多少行
    const orphan = r.rows.filter((x) => x.task_status === null).length;
    const taskInactive = r.rows.filter((x) => x.task_status !== null && x.task_status !== 'active').length;
    const futureAvail = r.rows.filter((x) => x.available_at !== null && new Date(x.available_at) > new Date(now.rows[0].now)).length;
    const claimed = r.rows.filter((x) => x.claimed_at !== null).length;
    const notPending = r.rows.filter((x) => x.status !== 'pending').length;

    console.log('');
    console.log('逐条件统计:');
    console.log(`  非 pending 状态           : ${notPending}`);
    console.log(`  关联任务不存在（孤儿）    : ${orphan}`);
    console.log(`  关联任务非 active         : ${taskInactive}`);
    console.log(`  available_at 在未来      : ${futureAvail}`);
    console.log(`  已被 claimed_at          : ${claimed}`);

    // 任务侧概览
    const tasks = await client.query<{ name: string; status: string; task_type: string; next_run_at: string | null; runs: string }>(
      `select t.name, t.status, t.task_type, t.next_run_at::text,
              (select count(*)::text from public.agent_task_runs r where r.task_id = t.id) as runs
         from public.agent_tasks t order by t.name`,
    );
    console.log('');
    console.log('agent_tasks 概览:');
    for (const t of tasks.rows) {
      console.log(`  ${t.status.padEnd(8)} ${String(t.task_type).padEnd(26)} runs=${t.runs.padEnd(4)} next_run=${String(t.next_run_at ?? '-').slice(0, 19)}  ${t.name}`);
    }
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
