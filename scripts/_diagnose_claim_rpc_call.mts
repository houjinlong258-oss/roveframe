/**
 * Phase 15 — 直接调用 `claim_agent_task_runs`，确认认领链路通不通（**会写库**）。
 *
 * ## 为什么必须真的调用
 *
 * 事实：21 行 `agent_task_runs` **满足全部认领条件**（pending + 任务 active +
 * available_at 已过 + 未认领），却全部停在 pending，而调度器每 tick 都在跑
 * （心跳可证）。日志里没有任何 worker 报错。
 *
 * 于是只剩两种可能，必须分辨：
 *   (a) RPC 调用本身失败（权限 / 参数 / PostgREST 暴露问题）
 *   (b) 调用根本没发生（上游 `enqueueDueTaskRuns` 提前抛错或被跳过）
 *
 * 直接调一次 RPC 就能区分：成功认领 ⇒ 是 (b)；报错 ⇒ 是 (a)。
 *
 * ## 副作用与可逆性
 *
 * 调用会把至多 limit 行从 pending 改为 running 并写 claimed_at/claimed_by。
 * 这些行**本来就该被执行**，因此这是"补做本该发生的事"，不是破坏。
 * 跑完把结果打印出来；若需要还原，把 status 改回 pending 即可（脚本会给出 SQL）。
 *
 * 用与 worker 相同的路径：Supabase 客户端 `.rpc('claim_agent_task_runs', …)`。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!() as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: unknown; error: { message: string; code?: string; details?: string } | null;
    }>;
  };

  console.log('='.repeat(84));
  console.log('Phase 15 — 直接调用 claim_agent_task_runs');
  console.log('='.repeat(84));

  const workerId = 'diagnose-worker-1';
  console.log(`调用 rpc('claim_agent_task_runs', { p_worker_id: '${workerId}', p_limit: 3 }) …`);
  console.log('');

  const { data, error } = await client.rpc('claim_agent_task_runs', {
    p_worker_id: workerId,
    p_limit: 3,
  });

  if (error) {
    console.log('** RPC 调用失败 **');
    console.log(`  message: ${error.message}`);
    console.log(`  code:    ${error.code ?? '-'}`);
    console.log(`  details: ${error.details ?? '-'}`);
    console.log('');
    console.log('判读: 认领链路断在 RPC 调用本身（(a)），不是"worker 没跑"。');
    return 1;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`RPC 返回 ${rows.length} 行`);
  for (const r of rows) {
    console.log(`  id=${String(r.id).slice(0, 8)}… type=${String(r.task_type)} attempt=${String(r.attempt)}/${String(r.max_attempts)}`);
  }
  console.log('');
  if (rows.length === 0) {
    console.log('判读: RPC 成功但认领 0 行 —— 条件在**调用时刻**不满足（与逐条判定结果冲突，需复查）。');
    return 1;
  }
  console.log('判读: 认领成功 ⇒ RPC 与权限都正常 ⇒ 说明 worker 从未走到这一步（(b)）。');
  console.log('');
  console.log('要还原这 3 行为 pending（如仅做诊断不想执行）：');
  console.log(`  update public.agent_task_runs set status='pending', claimed_by=null, claimed_at=null,`);
  console.log(`         locked_by=null, locked_at=null, started_at=null where claimed_by='${workerId}';`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
