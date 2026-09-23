import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  aiUsageMetrics,
  collectionMetrics,
  healthMetrics,
  paymentMetrics,
  processMetrics,
  queueMetrics,
  renderMetrics,
} from '../src/lib/observability/metrics';

/**
 * 告警规则（Phase 19 上线阻断项 3）。
 *
 * ## 被修的是什么
 *
 * 独立审查的结论："指标端点存在，但仓库里零个告警规则文件。
 * '有指标'不等于'会有人被叫醒'。" 此前唯一的"规则"是
 * `docs/current/Monitoring_And_Alerts.md` 里的散文与 YAML 片段 —— 那不是可执行的东西。
 *
 * 现在规则在 `ops/alerts/roveframe.rules.yml`，由 `scripts/check-alert-rules.mjs`
 * 做机器校验（零依赖）。本文件把校验接进 `pnpm validate`，并补上两件
 * CLI 做不到的事（因为它跑在 node 下，不能 import .ts）：
 *
 *   1. 用**真实渲染出来的指标名**核对规则里的引用（而不是静态扫字符串）；
 *   2. 核对 label 匹配器里的标签名真的存在（拼错标签名 = 规则永不触发，
 *      而且看起来像"已覆盖"）。
 *
 * ## 另一半在 CLI 里，且都有负向对照
 *
 * 结构与注释完备性、alert 名唯一、解析器计数交叉校验在
 * `scripts/check-alert-rules.mjs`；7 种注入（假指标名、缺 runbook、缺 severity、
 * 重复 alert 名、截断文件、缺 for、解析器少读）全部实测会让它变红。
 */

const RULE_FILE = 'ops/alerts/roveframe.rules.yml';
const RULES_SRC = readFileSync(RULE_FILE, 'utf8');

/** 本仓库真的会导出的指标名（用渲染结果取，不用正则扫源码）。 */
function reallyEmittedMetricNames(): Set<string> {
  const body = renderMetrics([
    ...processMetrics(),
    ...healthMetrics({ databaseOk: true, runtimeOk: true, schedulerOk: true, schedulerTickAgeMs: 1000 }),
    ...aiUsageMetrics([{ status: 'ok' }, { status: 'error' }]),
    ...queueMetrics([
      { queue: 'notification', pending: 3, oldestPendingAgeSeconds: 900, failed: 1 },
      { queue: 'email', pending: 0, oldestPendingAgeSeconds: null, failed: 0 },
    ]),
    ...paymentMetrics({
      unprocessed: 2,
      oldestUnprocessedSeconds: 700,
      byStatus: { paid: 5, failed: 1 },
    }),
    ...collectionMetrics([{ collector: 'outbox', ok: true }]),
  ]);
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    names.add(line.split(/[ {]/)[0]);
  }
  return names;
}

/** 渲染出的样本 labels（指标名 → 出现过的标签名集合）。 */
function reallyEmittedLabels(): Map<string, Set<string>> {
  const body = renderMetrics([
    ...queueMetrics([{ queue: 'notification', pending: 3, oldestPendingAgeSeconds: 900, failed: 1 }]),
    ...paymentMetrics({ unprocessed: 2, oldestUnprocessedSeconds: 700, byStatus: { paid: 5, failed: 1 } }),
    ...collectionMetrics([{ collector: 'outbox', ok: true }]),
    ...healthMetrics({ databaseOk: true, runtimeOk: true, schedulerOk: true, schedulerTickAgeMs: 1000 }),
  ]);
  const out = new Map<string, Set<string>>();
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-z_][a-z0-9_]*)(\{(.*)\})?\s/.exec(line);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], new Set());
    if (m[3]) for (const kv of m[3].split(',')) out.get(m[1])!.add(kv.split('=')[0]);
  }
  return out;
}

/** 从规则文件里取出每条规则的 expr（只做这一件事，结构校验在 CLI 里）。 */
function ruleExprs(): { alert: string; expr: string }[] {
  const out: { alert: string; expr: string }[] = [];
  const lines = RULES_SRC.split(/\r?\n/);
  let current: string | null = null;
  for (const line of lines) {
    const a = /^\s*-\s+alert:\s*(\S+)\s*$/.exec(line);
    if (a) { current = a[1]; continue; }
    const e = /^\s*expr:\s*(.+?)\s*$/.exec(line);
    if (e && current) { out.push({ alert: current, expr: e[1] }); current = null; }
  }
  return out;
}

describe('告警规则：可执行、被机器校验、有人负责', () => {
  test('规则文件存在且不是空的（"零个告警规则文件"正是被修的问题）', () => {
    assert.ok(RULES_SRC.length > 2000, '规则文件过小，可能是占位');
    assert.ok(/^groups:/m.test(RULES_SRC), '缺少顶层 groups');
  });

  test('CLI 校验器通过（结构 / 必填注释 / 指标名 / 解析器交叉校验）', () => {
    // 非零退出会抛错 —— 这正是断言。stdio:inherit 避免管道（沙箱会拦管道）。
    execFileSync(process.execPath, ['scripts/check-alert-rules.mjs'], { stdio: 'inherit' });
  });

  test('每条规则引用的指标都真的会被导出（用渲染结果，不用正则扫源码）', () => {
    const emitted = reallyEmittedMetricNames();
    assert.ok(emitted.size >= 10, `只渲染出 ${emitted.size} 个指标名，渲染逻辑可能失效`);
    assert.ok(emitted.has('roveframe_health_scheduler_ok'), '健康类指标必须在');

    const missing: string[] = [];
    for (const { alert, expr } of ruleExprs()) {
      for (const m of expr.matchAll(/roveframe_[a-z0-9_]+/g)) {
        if (!emitted.has(m[0])) missing.push(`${alert} 引用了 ${m[0]}`);
      }
    }
    assert.deepEqual(missing, [], '这些规则引用了不会导出的指标（永远不会触发）：\n  ' + missing.join('\n  '));
  });

  test('label 匹配器里的标签名真的存在于该指标上（拼错 = 永不触发）', () => {
    const labels = reallyEmittedLabels();
    const problems: string[] = [];
    for (const { alert, expr } of ruleExprs()) {
      const metric = /(roveframe_[a-z0-9_]+)\s*\{/.exec(expr);
      if (!metric) continue;
      const matchers = /\{([^}]*)\}/.exec(expr)?.[1] ?? '';
      const known = labels.get(metric[1]);
      if (!known) { problems.push(`${alert}: 渲染结果里没有 ${metric[1]}`); continue; }
      for (const kv of matchers.split(',')) {
        const key = kv.split('=')[0].trim();
        if (key && !known.has(key)) {
          problems.push(`${alert}: ${metric[1]} 没有标签 ${key}（实际有：${[...known].join(',')}）`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n  '));
  });

  test('覆盖了任务书要求的四类：可达性 / 调度器 / 队列积压 / 支付', () => {
    const names = ruleExprs().map((r) => r.alert);
    const exprs = ruleExprs().map((r) => r.expr).join('\n');
    assert.ok(names.some((n) => /Scrape|Absent/i.test(n)), '缺可达性规则');
    assert.ok(exprs.includes('roveframe_health_runtime_ok'), '缺运行时不可用规则');
    assert.ok(exprs.includes('roveframe_scheduler_last_tick_age_seconds'), '缺调度器不推进规则');
    assert.ok(exprs.includes('roveframe_outbox_oldest_pending_seconds'), '缺队列积压规则');
    assert.ok(exprs.includes('roveframe_payment_events_unprocessed')
      || exprs.includes('roveframe_payment_events_oldest_unprocessed_seconds'), '缺支付 webhook 规则');
    assert.ok(exprs.includes('roveframe_payments_total'), '缺支付状态/对账规则');
  });

  test('负向对照：指标名核对能发现一个不存在的指标', () => {
    const emitted = reallyEmittedMetricNames();
    // 一条人为写坏 expr 的"规则"必须被判出来
    const bogus = 'roveframe_zzz_not_a_metric == 0';
    const found = [...bogus.matchAll(/roveframe_[a-z0-9_]+/g)].filter((m) => !emitted.has(m[0]));
    assert.equal(found.length, 1, '指标名核对不具检测能力 —— 它必须能发现不存在的指标');
  });
});
