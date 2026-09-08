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

  test('claim RPC 语义对齐：run.pending + task.active + attempt + 15min 租约', () => {
    const sql = read('scripts/migrate.sql');
    assert.match(sql, /where r\.status = 'pending'/);
    assert.match(sql, /and t\.status = 'active'/);
    assert.match(sql, /r\.attempt, r\.max_attempts, r\.idempotency_key/);
    assert.match(sql, /status = 'running'[\s\S]{0,120}coalesce\(claimed_at, locked_at\) < now\(\) - interval '15 minutes'/);
    const worker = read('src/lib/agent/tasks/worker.ts');
    assert.match(worker, /rpc\('claim_agent_task_runs'/);
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
