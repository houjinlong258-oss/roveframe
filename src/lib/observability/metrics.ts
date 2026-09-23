/**
 * 指标导出（Phase 15）—— 让系统从"可追踪"变成"可采集"。
 *
 * ## 为什么需要
 *
 * 此前只有：请求 id、`tool_gate.jsonl`、`audit_events`、`/api/health`。
 * 这些能**事后追查**，但没有任何东西能被监控系统**定时抓取**，
 * 于是也就没有任何告警 —— 出了问题要人先发现。
 *
 * ## 设计取舍
 *
 * - **文本行格式**（`name{labels} value`），业界标准、任何采集器都能读，
 *   且**不引入任何依赖**（本项目硬约束）。渲染是纯字符串拼接，可单测。
 * - **只导出已有事实**，不新增埋点存储：AI 调用来自 `ai_usage_ledger`，
 *   健康状态来自既有的 boot-check / 调度器心跳 / 运行时探测。
 *   造一套自己的指标库会与本仓库"不新增重复架构"的约束冲突。
 * - **不导出业务数据**（租户数、营收等）。指标端点常被监控系统长期留存，
 *   不应成为第二条数据泄漏路径。
 * - 命名为 `roveframe_*`，与任何采集器的保留前缀都不冲突。
 */

export interface MetricSample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  labels?: Record<string, string>;
  value: number;
}

/** 指标文本格式对 label 值的要求：转义反斜杠、双引号与换行。 */
function escapeLabelValue(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(labels[k])}"`);
  return `{${parts.join(',')}}`;
}

/**
 * 把样本渲染成文本行格式。
 *
 * 同一指标名的 `HELP`/`TYPE` 只输出一次（重复输出会被部分采集器判为格式错误），
 * 因此这里按名字分组后依次渲染。
 */
export function renderMetrics(samples: readonly MetricSample[]): string {
  const byName = new Map<string, MetricSample[]>();
  for (const s of samples) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name)!.push(s);
  }
  const lines: string[] = [];
  for (const name of [...byName.keys()].sort()) {
    const group = byName.get(name)!;
    const { help, type } = group[0];
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const s of group) {
      // NaN / Infinity 不是合法的指标值，显式转成 0 并保留字段存在性
      const value = Number.isFinite(s.value) ? s.value : 0;
      lines.push(`${name}${formatLabels(s.labels)} ${value}`);
    }
  }
  // 结尾空行是文本格式的约定
  return `${lines.join('\n')}\n`;
}

/** 进程级基础指标（无需任何外部依赖） */
export function processMetrics(): MetricSample[] {
  const mem = process.memoryUsage();
  return [
    {
      name: 'roveframe_process_uptime_seconds',
      help: 'Process uptime in seconds',
      type: 'gauge',
      value: Math.round(process.uptime()),
    },
    {
      name: 'roveframe_process_resident_memory_bytes',
      help: 'Resident set size in bytes',
      type: 'gauge',
      value: mem.rss,
    },
    {
      name: 'roveframe_process_heap_used_bytes',
      help: 'V8 heap used in bytes',
      type: 'gauge',
      value: mem.heapUsed,
    },
  ];
}

/** 把健康检查结果转成 0/1 指标 */
export function healthMetrics(input: {
  databaseOk: boolean;
  runtimeOk: boolean;
  schedulerOk: boolean;
  schedulerTickAgeMs: number | null;
}): MetricSample[] {
  const bool = (v: boolean) => (v ? 1 : 0);
  const samples: MetricSample[] = [
    {
      name: 'roveframe_health_database_ok',
      help: '1 when every required table is present',
      type: 'gauge',
      value: bool(input.databaseOk),
    },
    {
      name: 'roveframe_health_runtime_ok',
      help: '1 when the Python agent runtime answers its liveness probe',
      type: 'gauge',
      value: bool(input.runtimeOk),
    },
    {
      name: 'roveframe_health_scheduler_ok',
      help: '1 when the scheduler is evidenced as running (fresh heartbeat)',
      type: 'gauge',
      value: bool(input.schedulerOk),
    },
  ];
  if (input.schedulerTickAgeMs !== null) {
    samples.push({
      name: 'roveframe_scheduler_last_tick_age_seconds',
      help: 'Seconds since the scheduler last wrote its heartbeat',
      type: 'gauge',
      value: Math.round(input.schedulerTickAgeMs / 1000),
    });
  }
  return samples;
}

/** AI 调用计数（来自 ai_usage_ledger 的既有行，按 status 分组） */
export function aiUsageMetrics(rows: readonly { status?: string | null }[]): MetricSample[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const status = String(r.status ?? 'unknown');
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) {
    // 没有数据时也要有样本，否则告警规则会因为"指标不存在"而无法评估
    return [{
      name: 'roveframe_ai_calls_total',
      help: 'AI provider calls recorded in the usage ledger, by status',
      type: 'counter',
      labels: { status: 'none' },
      value: 0,
    }];
  }
  return [...counts.entries()].sort().map(([status, n]) => ({
    name: 'roveframe_ai_calls_total',
    help: 'AI provider calls recorded in the usage ledger, by status',
    type: 'counter' as const,
    labels: { status },
    value: n,
  }));
}

// ---------------------------------------------------------------------------
// Phase 19：队列积压 / 支付事件积压 —— 让"没人被叫醒"这件事可被告警
// ---------------------------------------------------------------------------
//
// 上线阻断项 3 要求告警至少覆盖"队列积压（外发邮件/推送）"与"支付 webhook
// 失败或对账不一致"。而这两类此前**没有任何指标** —— 没有指标就写不出可执行的
// 规则，只能写出永远不触发的规则。所以先补指标，再写规则。
//
// 全部取自既有表，不新增埋点存储（沿用本模块的设计取舍）：
//   · notification_outbox —— 推送队列
//   · email_send_tasks    —— 外发邮件队列
//   · payment_events      —— 支付 webhook 回执

export interface OutboxSnapshot {
  /** 队列名，出现在 label 里。 */
  queue: 'notification' | 'email';
  /** 仍在等待处理的行数。 */
  pending: number;
  /** 最老一条待处理项的年龄（秒）；没有待处理项时为 null。 */
  oldestPendingAgeSeconds: number | null;
  /** 已进入失败/死信状态的行数。 */
  failed: number;
}

/**
 * 队列快照 → 指标。
 *
 * 为什么用"最老一条的年龄"而不只是"行数"：一次正常的批量入队会产生瞬时堆积，
 * 按行数告警会误报；而**有东西排了很久没人处理**才是真正的故障信号。
 * 两个都导出，规则按年龄触发、按行数写进注释值。
 */
export function queueMetrics(snapshots: readonly OutboxSnapshot[]): MetricSample[] {
  const pending: MetricSample[] = [];
  const oldest: MetricSample[] = [];
  const failed: MetricSample[] = [];
  for (const s of snapshots) {
    pending.push({
      name: 'roveframe_outbox_pending',
      help: 'Rows still waiting to be processed, by queue',
      type: 'gauge',
      labels: { queue: s.queue },
      value: s.pending,
    });
    failed.push({
      name: 'roveframe_outbox_failed_total',
      help: 'Rows in a failed/dead-letter state, by queue',
      type: 'gauge',
      labels: { queue: s.queue },
      value: s.failed,
    });
    if (s.oldestPendingAgeSeconds !== null) {
      oldest.push({
        name: 'roveframe_outbox_oldest_pending_seconds',
        help: 'Age of the oldest row still waiting, by queue',
        type: 'gauge',
        labels: { queue: s.queue },
        value: s.oldestPendingAgeSeconds,
      });
    }
  }
  return [...pending, ...oldest, ...failed];
}

export interface PaymentEventSnapshot {
  /** `payment_events.processed_at is null` 的行数（webhook 收到了但没处理完）。 */
  unprocessed: number;
  /** 最老一条未处理回执的年龄（秒）。 */
  oldestUnprocessedSeconds: number | null;
  /** 按 status 分组的支付行数。 */
  byStatus: Record<string, number>;
}

export function paymentMetrics(snapshot: PaymentEventSnapshot): MetricSample[] {
  const samples: MetricSample[] = [
    {
      name: 'roveframe_payment_events_unprocessed',
      help: 'Payment webhook receipts that have not been marked processed',
      type: 'gauge',
      value: snapshot.unprocessed,
    },
  ];
  if (snapshot.oldestUnprocessedSeconds !== null) {
    samples.push({
      name: 'roveframe_payment_events_oldest_unprocessed_seconds',
      help: 'Age of the oldest unprocessed payment webhook receipt',
      type: 'gauge',
      value: snapshot.oldestUnprocessedSeconds,
    });
  }
  for (const [status, n] of Object.entries(snapshot.byStatus).sort()) {
    samples.push({
      name: 'roveframe_payments_total',
      help: 'Payment rows by current status',
      type: 'gauge',
      labels: { status },
      value: n,
    });
  }
  return samples;
}

/**
 * 采集自检：**每个采集器的查询是否成功**。
 *
 * ## 为什么必须有这个指标（这是"会撒谎的探针"的防线）
 *
 * 如果队列查询失败时把 `roveframe_outbox_pending` 报成 0，那么后端故障会表现为
 * "队列是空的" —— 依赖它的告警永远不会触发，而且看起来一切正常。
 * 那比没有指标更糟。所以：查询失败时**不导出数据指标**，并把
 * `roveframe_metrics_collection_ok{collector=...}` 置 0，让"采集失败"本身可被告警。
 */
export function collectionMetrics(
  results: readonly { collector: string; ok: boolean }[],
): MetricSample[] {
  return results.map((r) => ({
    name: 'roveframe_metrics_collection_ok',
    help: '1 when this collector queried successfully; 0 means the data metric is absent/misleading',
    type: 'gauge' as const,
    labels: { collector: r.collector },
    value: r.ok ? 1 : 0,
  }));
}

