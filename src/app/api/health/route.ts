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
    const scheduler = schedulerHealth();

    // 运行时探测：客户端自带 2s 超时并吞掉异常，返回结构化结果。
    const runtime = await roveAgentHealth();

    // 加密密钥必须与数据库凭据解耦（R-03）。service_role_key 不再计入。
    const encryptionConfigured = Boolean(process.env.ENCRYPTION_SECRET);

    const databaseOk = missing.length === 0;
    const ok = databaseOk && !scheduler.degraded && runtime.ok;

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
        scheduler,
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
