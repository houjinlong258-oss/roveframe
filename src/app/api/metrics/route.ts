import { NextRequest } from 'next/server';
import { runBootChecks } from '@/lib/boot-check';
import { schedulerHealth } from '@/lib/scheduler';
import { roveAgentHealth } from '@/lib/roveagent/client';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  aiUsageMetrics,
  healthMetrics,
  processMetrics,
  renderMetrics,
} from '@/lib/observability/metrics';

/**
 * GET /api/metrics —— 供监控系统定时抓取的指标端点（Phase 15）。
 *
 * ## 鉴权
 *
 * 本路由**不在** `PUBLIC_API_PREFIXES` 里，因此 `src/proxy.ts` 会要求会话。
 * 但采集器没有浏览器会话，所以另接受两种服务间凭据：
 *
 *   - `X-RoveAgent-Key: <ROVEAGENT_API_KEY>`（与运行时共用的服务间密钥）
 *   - 平台管理员会话 cookie（人在浏览器里查看时）
 *
 * 之所以要鉴权而不是照惯例把指标端点做成公开：本端点会暴露调用量与错误率，
 * 属运行状况信息。而且它**不含任何业务数据**（见 metrics.ts 的说明），
 * 所以也不需要更严的权限。
 *
 * ## 为什么不用 SDK
 *
 * 文本行格式是纯字符串渲染，零依赖，且能单测（见 tests/metrics.test.ts）。
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return new Response('unauthorized', { status: 401 });
  }

  const checks = await runBootChecks();
  const databaseOk = checks.every((c) => !c.missing);
  const scheduler = await schedulerHealth();
  const runtime = await roveAgentHealth();

  const SCHEDULER_INTERVAL_MS = 60_000;
  const heartbeatStale = scheduler.tickAgeMs !== null
    && scheduler.tickAgeMs > SCHEDULER_INTERVAL_MS * 5;
  const schedulerOk = !scheduler.degraded
    && scheduler.source !== 'unknown'
    && !heartbeatStale;

  // AI 用量：读既有账本，**不新增埋点存储**。失败不阻断指标输出 ——
  // 采集器更怕端点整体 500（会丢掉全部指标）而不是少一类样本。
  let usageRows: { status?: string | null }[] = [];
  try {
    const client = getSupabaseClient();
    const { data } = await client
      .from('ai_usage_ledger')
      .select('status')
      .limit(5000);
    usageRows = (data ?? []) as { status?: string | null }[];
  } catch {
    usageRows = [];
  }

  const body = renderMetrics([
    ...processMetrics(),
    ...healthMetrics({
      databaseOk,
      runtimeOk: runtime.ok,
      schedulerOk,
      schedulerTickAgeMs: scheduler.tickAgeMs,
    }),
    ...aiUsageMetrics(usageRows),
  ]);

  return new Response(body, {
    status: 200,
    headers: {
      // 文本行格式的标准 content type；no-store 避免采集器拿到缓存副本
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isAuthorized(request: NextRequest): boolean {
  const sharedKey = process.env.ROVEAGENT_API_KEY;
  const provided = request.headers.get('x-roveagent-key');
  if (sharedKey && provided && provided === sharedKey) return true;

  // 人从浏览器查看：复用平台管理员会话 cookie（该 cookie 由 /api/admin/auth 设置）
  const adminCookie = request.cookies.get('rf_admin_session');
  if (adminCookie?.value) return true;

  // 本地开发：非生产且未配置任何服务端密钥时放行，便于 curl 调试。
  // 生产永远不放行（COZE_PROJECT_ENV=PROD 由启动脚本强制）。
  if (process.env.COZE_PROJECT_ENV !== 'PROD' && !sharedKey) return true;

  return false;
}
