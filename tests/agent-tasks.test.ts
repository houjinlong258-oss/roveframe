import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerTaskHandler } from '../src/lib/agent/tasks/worker';

const read = (path: string): string => readFileSync(path, 'utf8');

test('Agent Task Worker: registers custom task handlers cleanly', () => {
  let executed = false;
  registerTaskHandler('test_task_handler', async (ctx) => {
    executed = true;
    return { ok: true, payload: ctx.payload };
  });

  assert.equal(typeof registerTaskHandler, 'function');
  assert.equal(executed, false);
});

describe('P0-20 worker ↔ 迁移 schema 契约（真实 schema 断言）', () => {
  test('worker 只使用权威列与状态词汇（不再写不存在的列）', () => {
    const worker = read('src/lib/agent/tasks/worker.ts');
    // 权威词汇：任务 active；运行 pending/running/completed/failed
    assert.ok(!worker.includes("status: 'QUEUED'"), '禁止 QUEUED 词汇');
    assert.ok(!worker.includes("'COMPLETED'"), '禁止 COMPLETED 词汇');
    assert.ok(!worker.includes('WAITING_APPROVAL'), '禁止 WAITING_APPROVAL 词汇');
    assert.ok(!worker.includes('attempt_number'), '列名必须是 attempt');
    assert.ok(!worker.includes('agent_type'), 'agent_tasks 无 agent_type 列');
    assert.ok(!worker.includes("priority,"), 'agent_tasks 无 priority 列');
    assert.ok(!worker.includes('scheduled_at:'), 'agent_tasks 无 scheduled_at 列（用 next_run_at/available_at）');
    assert.ok(!worker.includes("context,"), 'agent_tasks 无 context 列（并入 payload）');
    assert.match(worker, /status: 'active'/);
    assert.match(worker, /status: 'pending'/);
    assert.match(worker, /attempt: 1/);
    assert.match(worker, /task_type: opts\.taskType/);
    assert.match(worker, /payload,\s*\n\s*next_run_at: scheduledAt/);
  });

  test('claim RPC 语义对齐：run.pending + task.active + out_* 返回列 + 15min 租约', () => {
    const sql = read('scripts/migrate.sql');
    assert.match(sql, /where r\.status = 'pending'/);
    assert.match(sql, /and t\.status = 'active'/);
    // Phase 15：返回列必须带 out_ 前缀别名。
    // 旧写法 `returning r.id, …, r.attempt, …` 与同名的 OUT 参数冲突，
    // PL/pgSQL 每次调用都报 42702 ambiguous —— 而且只在**真正调用时**才炸，
    // 因此 `pnpm validate` 曾长期全绿而队列从未被消费过。
    assert.match(sql, /r\.attempt as out_attempt, r\.max_attempts as out_max_attempts/);
    assert.match(sql, /returns table \(\s*out_id varchar\(36\)/);
    // 反例：不得再出现与 OUT 参数同名的裸返回列
    assert.doesNotMatch(
      sql,
      /returning r\.id, r\.tenant_id, r\.business_id, r\.task_id, t\.task_type, t\.payload,\s*\n\s*r\.attempt/,
      'claim_agent_task_runs 又写回了会与 OUT 参数冲突的裸返回列',
    );
    assert.match(sql, /status = 'running'[\s\S]{0,120}coalesce\(claimed_at, locked_at\) < now\(\) - interval '15 minutes'/);
    const worker = read('src/lib/agent/tasks/worker.ts');
    assert.match(worker, /rpc\('claim_agent_task_runs'/);
  });

  test('claim 失败必须抛出，不得静默降级为"本轮没有任务"', () => {
    const worker = read('src/lib/agent/tasks/worker.ts');
    // 旧代码是 `if (error) return [];` —— 把每次 RPC 失败都变成"队列为空"，
    // 于是调度器看起来一切正常而任务永不执行（实测最久积压 11 天）。
    assert.doesNotMatch(
      worker,
      /if \(error\) return \[\];/,
      'claimTaskRuns 又静默吞掉了 RPC 错误 —— 队列故障会再次变成"没有任务"',
    );
    assert.match(
      worker,
      /claim_agent_task_runs failed/,
      'claimTaskRuns 需要把 RPC 失败抛出并带上原因',
    );
    // 字段名与 SQL 的 out_* 必须一致，否则 worker 拿到 undefined 静默跑偏
    assert.match(worker, /run\.out_id/);
    assert.match(worker, /run\.out_task_id/);
  });

  test('schema.ts 与迁移 SQL 任务表口径一致', () => {
    const schema = read('src/storage/database/shared/schema.ts');
    const sql = read('scripts/migrate.sql');
    for (const column of ['task_type', 'schedule_cron', 'payload', 'next_run_at', 'last_run_at']) {
      assert.ok(schema.includes(`"${column}"`), `schema.ts 缺 ${column}`);
      assert.ok(sql.includes(column), `migrate.sql 缺 ${column}`);
    }
    for (const column of ['attempt', 'available_at', 'claimed_by', 'claimed_at', 'idempotency_key', 'input']) {
      assert.ok(schema.includes(`"${column}"`), `schema.ts agent_task_runs 缺 ${column}`);
      assert.ok(sql.includes(`agent_task_runs add column if not exists ${column}`) || sql.includes(` ${column} `), `migrate.sql agent_task_runs 缺 ${column}`);
    }
  });

  test('detector 不再创建无 handler 的三类死任务', () => {
    const detector = read('src/lib/agent/events/detector.ts');
    assert.ok(!detector.includes('INVENTORY_ALERT_TASK'), 'INVENTORY_ALERT_TASK 必须移除');
    assert.ok(!detector.includes('REVIEW_ANALYSIS_TASK'), 'REVIEW_ANALYSIS_TASK 必须移除');
    assert.ok(!detector.includes('SALES_DROP_ANALYSIS_TASK'), 'SALES_DROP_ANALYSIS_TASK 必须移除');
    assert.ok(!detector.includes('triggerEventTask'), '死任务创建函数必须移除');
    // 事件与通知路径保留
    assert.match(detector, /agent_events/);
    assert.match(detector, /enqueueNotification/);
  });

  test('worker 仅注册 DAILY_BRIEFING/EVENT_DETECTION handler', () => {
    const worker = read('src/lib/agent/tasks/worker.ts');
    assert.match(worker, /registerTaskHandler\('DAILY_BRIEFING'/);
    assert.match(worker, /registerTaskHandler\('EVENT_DETECTION'/);
  });
});
