/**
 * Phase 15 —— scheduler 实际行为观察（只读 + 一次显式 tick）。
 *
 * ## 待解释的观测
 *
 * `/api/health` 的 `scheduler.cronStateReady` 在容器跑了几分钟后**仍是 null**。
 * 该字段由 `ensureCronState()` 置位（`src/lib/scheduler.ts:42-63`），而
 * `server.ts:106` 在启动时就调用 `startScheduler()`，后者**立即**跑一次
 * `runScheduledJobs()`。所以正常情况下一秒内就该是 true/false，不该长期为 null。
 *
 * 两种假设，必须分辨：
 *   1. scheduler 的模块实例与 `/api/health` 的模块实例**不是同一个**
 *      （本仓库已知：Next.js 可能给不同路由独立模块实例）；
 *   2. scheduler 的 tick 从未真正执行（启动路径异常）。
 *
 * ## 怎么分辨（不依赖模块状态）
 *
 * 直接查**副作用**：`cron_state` 表。若 tick 跑过，`ensureCronState()` 会真的
 * `select` 该表；`runScheduledJobsInner` 会读取 tenants 并为每个 business 读写
 * cron 水位线。因此：
 *
 *   - `cron_state` 有行 → tick 跑过（假设 2 排除）
 *   - 全空但表存在 → tick 没跑到写水位线那一步
 *
 * 另外用 `_resetTickLockForTests` 之外的方式无法直接触发 tick，因此这里
 * 只做**观察**，不做注入。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string; code?: string } | null; status?: number };

function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    const value = bag?.[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(`cannot resolve export '${name}'`);
}

const getSupabaseClient = resolveExport<() => {
  from(t: string): {
    select(c: string, o?: unknown): { limit(n: number): Promise<Res> };
  };
}>(supabaseModule, 'getSupabaseClient');

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;

async function healthScheduler(): Promise<unknown> {
  const res = await fetch(`${BASE}/api/health`);
  const body = (await res.json()) as Row;
  return body.scheduler;
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — scheduler 实际行为观察');
  console.log('='.repeat(78));
  console.log('');

  const client = getSupabaseClient();

  // ---- 1. cron_state 副作用（tick 的权威证据） ---------------------------
  const { data: cronRows, error: cronErr } = await client
    .from('cron_state').select('key, value, updated_at').limit(50);

  console.log('[1] cron_state 表内容（scheduler 水位线）:');
  if (cronErr) {
    console.log(`    ERR ${cronErr.code ?? ''} ${cronErr.message}`);
  } else {
    console.log(`    行数: ${cronRows?.length ?? 0}`);
    for (const r of cronRows ?? []) {
      console.log(`      key=${JSON.stringify(r.key)} updated_at=${String(r.updated_at)} value=${JSON.stringify(r.value).slice(0, 120)}`);
    }
  }
  console.log('');

  // ---- 2. health 的 scheduler 字段（模块状态） ---------------------------
  console.log('[2] /api/health 的 scheduler 字段:');
  for (let i = 1; i <= 3; i += 1) {
    const s = await healthScheduler();
    console.log(`    第 ${i} 次: ${JSON.stringify(s)}`);
    if (i < 3) await new Promise((r) => setTimeout(r, 4_000));
  }
  console.log('');

  // ---- 3. 两个模块实例是否同一份（用 _deployEnvLoadCount 之类的模块级量无法跨进程取，\
  //         因此改用"行为"判定：tick 若跑过，邮箱队列/通知出件会有痕迹） ----------
  console.log('[3] tick 的其他副作用（是否真的执行过 worker）:');
  const queues: Array<[string, string]> = [
    ['email_send_tasks', 'status'],
    ['notification_outbox', 'status'],
    ['agent_tasks', 'status'],
  ];
  for (const [table, col] of queues) {
    const { data, error } = await client.from(table).select(col).limit(200);
    if (error) { console.log(`    ${table.padEnd(22)} ERR ${error.message.slice(0, 60)}`); continue; }
    const counts = (data ?? []).reduce<Record<string, number>>((acc, r) => {
      const k = String(r[col] ?? 'null');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`    ${table.padEnd(22)} ${JSON.stringify(counts)}`);
  }
  console.log('');

  const ticked = (cronRows?.length ?? 0) > 0;
  console.log('='.repeat(78));
  console.log('判读:');
  console.log(`  · cron_state 有行? ${ticked ? '是 ⇒ scheduler 的 tick 确实跑过（假设 2 排除）' : '否 ⇒ tick 未留下水位线'}`);
  console.log('  · 若 tick 跑过而 /api/health 仍报 cronStateReady=null，则');
  console.log('    scheduler 模块与 health 路由**不是同一个模块实例**，');
  console.log('    health 里的 scheduler 状态字段不代表真实调度器 —— 这正是');
  console.log('    Phase 12 §6 记录过的"模块实例级共享"问题的具体表现。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('观察崩溃:', error); process.exitCode = 2; });
