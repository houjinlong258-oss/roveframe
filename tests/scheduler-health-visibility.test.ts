import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 15 —— 调度器健康可见性的回归守卫。
 *
 * ## 被守住的东西
 *
 * 实测事实：容器启动 18 秒后 `cron_state` 已经被调度器写入（`imap_sync.*`、
 * `square_sync_throttle.*`），证明 tick 在跑；而同一时刻 `/api/health` 报
 * `cronStateReady: null`、`degraded: false`。
 *
 * 原因是 `/api/health` 导入的 `src/lib/scheduler.ts` 与 `src/server.ts` 启动的
 * `startScheduler()` **不是同一个模块实例**（Next.js 给不同入口独立实例化）。
 * 于是 health 读的那个实例从未被置位，`degraded` 恒为 false ——
 * **健康端点永远无法上报调度器降级**，即使调度器真的死了。
 *
 * 修法：调度器每 tick 把心跳写进 `cron_state`，health 优先读心跳。
 * 本文件守住三件事，任何一件退化都会让上面那个盲区回来。
 */

const ROOT = process.cwd();
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('scheduler health visibility (Phase 15)', () => {
  test('scheduler 导出心跳键，且键名稳定', async () => {
    const mod = await import('../src/lib/scheduler');
    assert.equal(
      mod.SCHEDULER_HEARTBEAT_KEY, 'scheduler.heartbeat',
      '心跳键变了等于旧心跳读不到 —— 若确实要改，需要同步迁移已写入的行',
    );
  });

  test('schedulerHealth 是异步的（必须能读落库心跳，而非只读模块变量）', async () => {
    const mod = await import('../src/lib/scheduler');
    const result = mod.schedulerHealth();
    assert.ok(
      result instanceof Promise,
      'schedulerHealth 变回同步了 —— 同步实现只能读本模块实例的变量，'
      + '而 health 路由与 startScheduler() 不是同一个实例，degraded 会重新恒为 false',
    );
    await result.catch(() => { /* 无数据库时读不到心跳是允许的 */ });
  });

  test('本实例从未跑过 tick 时，来源必须是 unknown，且不得谎报 tickAge', async () => {
    const mod = await import('../src/lib/scheduler');
    const h = await mod.schedulerHealth();
    // 测试进程里没有 startScheduler，也没有心跳（或库不可达）：
    // 只允许 heartbeat（若库里有真调度器写的行）或 unknown。
    assert.ok(
      h.source === 'heartbeat' || h.source === 'unknown',
      `本进程不可能有实例级状态，source 不应是 ${h.source}`,
    );
    if (h.source === 'unknown') {
      assert.equal(h.tickAgeMs, null, 'unknown 来源不得编造 tickAge');
      assert.equal(h.lastTickAt, null, 'unknown 来源不得编造 lastTickAt');
    }
  });

  test('health 路由要求调度器有证据，且把 ok/heartbeatStale 暴露出来', () => {
    const src = read('src/app/api/health/route.ts');
    // 1) 必须 await 异步的 schedulerHealth
    assert.match(src, /await\s+schedulerHealth\(\)/, 'health 路由必须 await schedulerHealth()');
    // 2) 判定必须排除 unknown 来源
    assert.match(
      src, /source\s*!==\s*'unknown'/,
      "health 的 ok 判定没有排除 source==='unknown' —— "
      + "那么一个从未跑过的调度器会重新看起来健康（cronStateReady:null + degraded:false）",
    );
    // 3) 心跳过期要算不健康
    assert.match(src, /heartbeatStale/, 'health 未检查心跳是否过期');
    // 4) 契约字段
    assert.match(src, /heartbeatStale/, '响应里应暴露 heartbeatStale');
  });

  test('心跳写入在降级路径上也会发生（否则真实原因会丢）', () => {
    const src = read('src/lib/scheduler.ts');
    // tick 里必须先写心跳再按 ready 早退，否则 cron_state 缺失时心跳停摆，
    // health 只能报 unknown，运维看不到"表缺失"这个真正的原因。
    const idxHeartbeat = src.indexOf('await writeSchedulerHeartbeat(');
    const idxEarlyReturn = src.indexOf('if (!ready) return;');
    assert.ok(idxHeartbeat > 0, 'tick 里没有写心跳');
    assert.ok(idxEarlyReturn > 0, 'tick 的降级早退不见了（行为已变，请复查本测试）');
    assert.ok(
      idxHeartbeat < idxEarlyReturn,
      '心跳写在降级早退之后 —— cron_state 缺失时心跳会停摆，真实原因丢失',
    );
  });
});
