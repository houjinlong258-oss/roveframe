import { NextResponse } from 'next/server';
import { runBootChecks } from '@/lib/boot-check';
import { schedulerHealth } from '@/lib/scheduler';
import { roveAgentHealth } from '@/lib/roveagent/client';

/**
 * GET /api/health — 部署 preflight / 运行健康检查。
 *
 * 此端点**无鉴权**（见 `src/lib/auth-guard.ts` 的公开列表），因此它只返回
 * 汇总信息，不返回任何可枚举内部结构的内容。
 *
 * ## Phase 12 修复（R-02 / P2）
 *
 * 1. **不再对 Python 运行时视而不见。** 旧实现只查数据库，运行时挂掉时依然
 *    返回 `ok: true` —— 也就是说整个 AI 能力已经不可用，而健康检查是绿的。
 *    现在 `runtime` 是一个一等字段，并且纳入总体 `ok`。
 * 2. **不再公开表名。** 旧实现把 `missingTables: [{table, missing, message}]`
 *    原样返回给任何匿名调用者，等于对外提供数据库 schema 清单。
 *    现在公开响应只有数量；具体表名写入服务端日志供运维排查。
 * 3. **加密判定与 R-03 对齐。** 旧实现把 `COZE_SUPABASE_SERVICE_ROLE_KEY`
 *    也算作「加密已配置」，而那个回落已经在 `src/lib/crypto.ts` 中删除。
 *    这里如果继续认它，健康检查就会报告一个并不存在的安全状态。
 */
export async function GET() {
  try {
    const checks = await runBootChecks();
    const missing = checks.filter((c) => c.missing);
    // Phase 15：schedulerHealth 现在是异步的 —— 它优先读**落库的心跳**
    // （真调度器写的），而不是本模块实例的变量。原因见 scheduler.ts 的
    // SCHEDULER_HEARTBEAT_KEY 注释：health 路由与 startScheduler() 不是同一个
    // 模块实例，读实例变量会恒为 null，使 degraded 永远上报不出来。
    const scheduler = await schedulerHealth();

    // 运行时探测：客户端自带 2s 超时并吞掉异常，返回结构化结果。
    const runtime = await roveAgentHealth();

    // 加密密钥必须与数据库凭据解耦（R-03）。service_role_key 不再计入。
    const encryptionConfigured = Boolean(process.env.ENCRYPTION_SECRET);

    const databaseOk = missing.length === 0;

    /**
     * 调度器判定（Phase 15）。
     *
     * `degraded` 只能证明"明确坏了"，不能证明"活着"。因此额外要求**有心跳证据**
     * 且心跳足够新：
     *
     *   - `source: 'unknown'`（没有任何 tick 留下心跳）→ 不健康。
     *     这正是修这个缺陷的初衷：`cronStateReady: null` + `degraded: false`
     *     会让一个从未跑过的调度器看起来一切正常。
     *   - 心跳过期（超过 `interval × 5`）→ 不健康。
     *     调度器的 `setInterval` 失败（例如未捕获异常打断 tick 循环）时，
     *     心跳会停摆，这里能看出来。
     *
     * 这条**不会**在正常启动时误报：`startScheduler()` 在 `server.ts` 里立即
     * 触发一次 tick（`startScheduler` 的第一行就是 `void runScheduledJobs()`），
     * 而容器健康检查有 90s 的 `start-period` 宽限。
     */
    const SCHEDULER_INTERVAL_MS = 60_000;
    const heartbeatStale = scheduler.tickAgeMs !== null
      && scheduler.tickAgeMs > SCHEDULER_INTERVAL_MS * 5;
    const schedulerOk = !scheduler.degraded
      && scheduler.source !== 'unknown'
      && !heartbeatStale;

    const ok = databaseOk && schedulerOk && runtime.ok;

    if (missing.length > 0) {
      // 公开响应不给表名，但运维必须能看到 —— 落到服务端日志。
      console.error(
        '[health] database is missing required tables:',
        missing.map((c) => c.table).join(', '),
      );
    }
    if (!encryptionConfigured) {
      console.error(
        '[health] ENCRYPTION_SECRET is not set — credential encryption will refuse to operate',
      );
    }
    if (!schedulerOk) {
      console.error(
        '[health] scheduler not evidenced as running:',
        `source=${scheduler.source}`,
        `degraded=${scheduler.degraded}`,
        `lastTickAt=${scheduler.lastTickAt ?? '(none)'}`,
        `tickAgeMs=${scheduler.tickAgeMs ?? '(none)'}`,
        `lastSkipReason=${scheduler.lastSkipReason ?? '(none)'}`,
      );
    }

    return NextResponse.json(
      {
        ok,
        database: {
          ok: databaseOk,
          missingCount: missing.length,
        },
        runtime: {
          ok: runtime.ok,
          status: runtime.status,
          latencyMs: runtime.latencyMs,
          detail: runtime.detail,
        },
        scheduler: {
          ...scheduler,
          ok: schedulerOk,
          heartbeatStale,
        },
        encryptionConfigured,
      },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
