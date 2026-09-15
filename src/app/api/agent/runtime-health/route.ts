/**
 * Runtime 健康探测（Step 3.1 任务 1）。
 *
 * 为什么需要这条路由而不是浏览器直连 Runtime：
 * `src/lib/roveagent/client.ts` 经 `signature.ts` 依赖 `node:crypto`，
 * 无法被 `'use client'` 组件引入；即便能，`ROVEAGENT_API_KEY` 也绝不能下发到浏览器。
 * 因此由服务端代探，只回一个**脱敏**结论。
 *
 * 契约：
 * - 200 + `{ ok: true,  mode: 'roveagent',   … }`  → Runtime 可达，前端恢复
 * - 200 + `{ ok: false, mode: 'unavailable', … }` → 保持错误并显示原因
 * - 401（未登录）
 *
 * 注意：**不用 5xx 表达「Runtime 挂了」** —— 那是本服务对 Runtime 的
 * 一份正常观测结果。用 5xx 会让前端把「Runtime 不可用」和
 * 「本路由自己出错」混为一谈。
 */
import { errorResponse } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { roveAgentConfigGaps, roveAgentConfigured, roveAgentHealth } from '@/lib/roveagent/client';
import type { RuntimeHealthReport } from '@/lib/agent/runtime-availability';

export const runtime = 'nodejs';
/** 健康探测必须实时，不得被缓存。 */
export const dynamic = 'force-dynamic';

/** `api-helpers.json()` 不接受自定义头，这里用原生 Response 带 no-store。 */
function healthJson(report: RuntimeHealthReport): Response {
  return Response.json(report, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  try {
    // 与 /api/agent/chat 相同的作用域校验：未登录 401，不泄露 Runtime 拓扑
    await getTenantContext(request);
  } catch (error) {
    return errorResponse(error, 401);
  }

  if (!roveAgentConfigured()) {
    const gaps = roveAgentConfigGaps();
    return healthJson({
      ok: false,
      mode: 'unavailable',
      detail: `runtime not configured (missing ${gaps.join(', ') || 'ROVEAGENT_API_URL/ROVEAGENT_API_KEY'})`,
      latencyMs: null,
    });
  }

  const health = await roveAgentHealth(3_000);
  return healthJson({
    ok: health.ok,
    mode: health.ok ? 'roveagent' : 'unavailable',
    detail: health.ok ? '' : `${health.status}: ${health.detail}`,
    latencyMs: health.latencyMs,
  });
}
