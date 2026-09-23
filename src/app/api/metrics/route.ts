import { NextRequest } from 'next/server';
import { runBootChecks } from '@/lib/boot-check';
import { schedulerHealth } from '@/lib/scheduler';
import { roveAgentHealth } from '@/lib/roveagent/client';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  aiUsageMetrics,
  collectionMetrics,
  healthMetrics,
  paymentMetrics,
  processMetrics,
  queueMetrics,
  renderMetrics,
  type MetricSample,
  type OutboxSnapshot,
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

  // AI 用量：读既有账本，**不新增埋点存储**。
  //
  // Phase 19：这里原本是 `catch { usageRows = [] }` —— 查询失败会让
  // `roveframe_ai_calls_total{status="none"} 0` 看起来像"没有任何调用"，
  // 也就是**故障伪装成健康**。现在失败时同样把 collector 置 0（见下方），
  // 由 RoveFrameMetricsCollectionFailing 规则叫醒人。
  const collectors: { collector: string; ok: boolean }[] = [];
  let usageRows: { status?: string | null }[] = [];
  let usageOk = true;
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('ai_usage_ledger')
      .select('status')
      .limit(5000);
    if (error) throw new Error(error.message);
    usageRows = (data ?? []) as { status?: string | null }[];
  } catch (error) {
    usageOk = false;
    console.error('[metrics] ai_usage_ledger 采集失败：', error instanceof Error ? error.message : String(error));
  }
  collectors.push({ collector: 'ai_usage', ok: usageOk });

  // 队列与支付（Phase 19）：失败时**不导出数据指标**，只把 collector 置 0 ——
  // 绝不把"查不到"报成 0，那会让积压告警永远不触发。
  const outbox: OutboxSnapshot[] = [];
  let outboxOk = true;
  try {
    outbox.push(await readOutbox('notification', 'notification_outbox'));
    outbox.push(await readOutbox('email', 'email_send_tasks'));
  } catch (error) {
    outboxOk = false;
    console.error('[metrics] outbox 采集失败：', error instanceof Error ? error.message : String(error));
  }
  collectors.push({ collector: 'outbox', ok: outboxOk });

  let paymentSample: MetricSample[] = [];
  let paymentsOk = true;
  try {
    paymentSample = paymentMetrics(await readPaymentSnapshot());
  } catch (error) {
    paymentsOk = false;
    console.error('[metrics] payment 采集失败：', error instanceof Error ? error.message : String(error));
  }
  collectors.push({ collector: 'payments', ok: paymentsOk });

  const body = renderMetrics([
    ...processMetrics(),
    ...healthMetrics({
      databaseOk,
      runtimeOk: runtime.ok,
      schedulerOk,
      schedulerTickAgeMs: scheduler.tickAgeMs,
    }),
    ...aiUsageMetrics(usageRows),
    ...(outboxOk ? queueMetrics(outbox) : []),
    ...paymentSample,
    ...collectionMetrics(collectors),
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

/** 队列状态取值：两种队列用各自的"待处理/失败"状态集合。 */
const PENDING_STATUS: Record<OutboxSnapshot['queue'], string[]> = {
  notification: ['queued', 'pending'],
  email: ['queued', 'pending', 'scheduled'],
};
const FAILED_STATUS: Record<OutboxSnapshot['queue'], string[]> = {
  notification: ['failed', 'dead'],
  email: ['failed', 'dead'],
};

function ageSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/** 一次队列快照：待处理数、最老待处理项的年龄、失败数。 */
async function readOutbox(
  queue: OutboxSnapshot['queue'],
  table: string,
): Promise<OutboxSnapshot> {
  const client = getSupabaseClient();

  const pending = await client
    .from(table)
    .select('id', { count: 'exact' })
    .in('status', PENDING_STATUS[queue]);
  if (pending.error) throw new Error(`${table} pending: ${pending.error.message}`);

  const oldest = await client
    .from(table)
    .select('created_at')
    .in('status', PENDING_STATUS[queue])
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldest.error) throw new Error(`${table} oldest: ${oldest.error.message}`);

  const failed = await client
    .from(table)
    .select('id', { count: 'exact' })
    .in('status', FAILED_STATUS[queue]);
  if (failed.error) throw new Error(`${table} failed: ${failed.error.message}`);

  const oldestRow = (oldest.data ?? [])[0] as { created_at?: string } | undefined;
  return {
    queue,
    pending: pending.count ?? 0,
    oldestPendingAgeSeconds: ageSeconds(oldestRow?.created_at),
    failed: failed.count ?? 0,
  };
}

/** 支付回执积压 + 按状态分组的支付行数。 */
async function readPaymentSnapshot() {
  const client = getSupabaseClient();

  const unprocessed = await client
    .from('payment_events')
    .select('id', { count: 'exact' })
    .is('processed_at', null);
  if (unprocessed.error) throw new Error(`payment_events: ${unprocessed.error.message}`);

  const oldest = await client
    .from('payment_events')
    .select('created_at')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldest.error) throw new Error(`payment_events oldest: ${oldest.error.message}`);

  const payments = await client.from('payments').select('status').limit(10_000);
  if (payments.error) throw new Error(`payments: ${payments.error.message}`);

  const byStatus: Record<string, number> = {};
  for (const row of (payments.data ?? []) as { status?: string | null }[]) {
    const key = String(row.status ?? 'unknown');
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  const oldestRow = (oldest.data ?? [])[0] as { created_at?: string } | undefined;
  return {
    unprocessed: unprocessed.count ?? 0,
    oldestUnprocessedSeconds: ageSeconds(oldestRow?.created_at),
    byStatus,
  };
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
