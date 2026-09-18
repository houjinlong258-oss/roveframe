/**
 * Phase 15 — agent_tasks 队列消费取证（只读）。
 *
 * 上一版脚本按 `attempts` 列查询，报 "column agent_tasks.attempts does not exist" ——
 * **是我的查询写错了列名，不是数据问题**。这里先取真实列名再判断。
 *
 * 要回答的问题：`agent_tasks` 此前实测有 10 行 `active`。
 * 如果任务只进不出（created 后 updated 长期不变、无运行记录），
 * 说明 worker 没有真正消费队列 —— 那是"看着在跑、实际不干活"。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const q = (client: unknown, table: string, cols: string): Promise<Res> =>
  (client as { from(x: string): { select(c: string): { limit(n: number): Promise<Res> } } })
    .from(table).select(cols).limit(2000);

async function main(): Promise<number> {
  const client = getSupabaseClient!();

  console.log('='.repeat(84));
  console.log('Phase 15 — agent_tasks 队列消费取证（只读）');
  console.log('='.repeat(84));

  // 1) 先取真实列名（不猜）
  const { data: sample, error: se } = await q(client, 'agent_tasks', '*');
  if (se) { console.log(`读取失败: ${se.message}`); return 2; }
  const rows = sample ?? [];
  console.log('');
  console.log(`agent_tasks 共 ${rows.length} 行`);
  if (rows.length === 0) {
    console.log('（空表 —— 无法判断消费行为）');
    return 0;
  }
  console.log(`真实列: ${Object.keys(rows[0]).sort().join(', ')}`);

  // 2) 按状态分组
  const statusKey = 'status' in rows[0] ? 'status' : null;
  if (statusKey) {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r[statusKey] ?? '(null)'), (m.get(String(r[statusKey] ?? '(null)')) ?? 0) + 1);
    console.log(`按 status: ${JSON.stringify([...m.entries()].sort())}`);
  }

  // 3) 逐行列明细
  const timeCol = ['updated_at', 'last_run_at', 'completed_at'].find((c) => c in rows[0]);
  console.log('');
  console.log(`时间列: created_at${timeCol ? ` / ${timeCol}` : '（无 updated/run 列）'}`);
  console.log('');
  console.log(`  ${'status'.padEnd(10)} ${'name'.padEnd(28)} ${'created'.padEnd(20)} ${(timeCol ?? '-').padEnd(20)} 同刻?`);
  console.log('  ' + '-'.repeat(94));
  let sameTimestamp = 0;
  for (const r of rows.slice(0, 20)) {
    const c = String(r.created_at ?? '').slice(0, 19);
    const u = timeCol ? String(r[timeCol] ?? '').slice(0, 19) : '-';
    const same = timeCol && c === u;
    if (same) sameTimestamp += 1;
    console.log(`  ${String(r.status ?? '-').padEnd(10)} ${String(r.name ?? '').slice(0, 26).padEnd(28)} ${c.padEnd(20)} ${u.padEnd(20)} ${same ? 'YES' : ''}`);
  }

  // 4) agent_task_runs：有没有真的跑过
  const { data: runs, error: re } = await q(client, 'agent_task_runs', '*');
  console.log('');
  if (re) {
    console.log(`agent_task_runs 读取失败: ${re.message}`);
  } else {
    const runRows = runs ?? [];
    console.log(`agent_task_runs 共 ${runRows.length} 行`);
    if (runRows.length > 0) {
      const rStatus = new Map<string, number>();
      for (const r of runRows) rStatus.set(String(r.status ?? '(null)'), (rStatus.get(String(r.status ?? '(null)')) ?? 0) + 1);
      console.log(`  按 status: ${JSON.stringify([...rStatus.entries()].sort())}`);
      const times = runRows.map((r) => String(r.created_at ?? '')).filter(Boolean).sort();
      if (times.length) console.log(`  时间跨度: ${times[0].slice(0, 19)} → ${times[times.length - 1].slice(0, 19)}`);
    }
  }

  console.log('');
  console.log('='.repeat(84));
  console.log('判读:');
  console.log('  · agent_task_runs 有行 ⇒ worker 真的跑过任务（消费链路通）');
  console.log(`  · active 行 created==${timeCol ?? 'updated'} ⇒ 从未被 worker 触碰过`);
  console.log(`  本次: ${sameTimestamp}/${Math.min(rows.length, 20)} 行的两个时间戳完全相同`);
  console.log('='.repeat(84));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
