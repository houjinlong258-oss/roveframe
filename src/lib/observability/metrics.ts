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
