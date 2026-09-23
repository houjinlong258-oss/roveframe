#!/usr/bin/env node
/**
 * 告警规则校验器（零依赖，只用 Node 标准库）。
 *
 * ## 为什么不用 promtool
 *
 * 本仓库硬约束"零新增依赖"，环境里也没有 promtool。但"规则没有被机器校验过"
 * 与"规则是文档里的示例"差别不大 —— 所以这里自己做校验，并且**如实说明**
 * 它校验了什么、没校验什么：
 *
 *   校验：结构与必填注释、alert 名唯一、expr 非空、
 *         **expr 引用的每个指标名都真的由本仓库导出**、
 *         规则数与文件里的 `- alert:` 出现次数一致（防止解析器静默漏读）、
 *         可选：与真实 /api/metrics 输出对照。
 *   不校验：PromQL 语义正确性、for 时长合理性、标签匹配是否会产生高基数。
 *         那些要靠 Prometheus 自己在加载时拒绝（它会拒绝语法错的 expr）。
 *
 * ## 用法
 *
 *   node scripts/check-alert-rules.mjs
 *   node scripts/check-alert-rules.mjs --base http://127.0.0.1:5067 --key <ROVEAGENT_API_KEY>
 *   node scripts/check-alert-rules.mjs --file ops/alerts/roveframe.rules.yml
 *
 * 退出码：0 = 全部通过；1 = 有失败项；2 = 用法/文件错误。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const files = [];
const explicit = getArg('--file');
if (explicit) {
  files.push(explicit);
} else {
  const dir = 'ops/alerts';
  try {
    for (const n of readdirSync(dir)) {
      if (/\.(ya?ml)$/.test(n)) files.push(join(dir, n));
    }
  } catch {
    console.error(`找不到规则目录 ${dir}`);
    process.exit(2);
  }
}
if (files.length === 0) {
  console.error('没有任何规则文件 —— 这不是"通过"，是没有东西被检查');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 本仓库导出的指标名（静态扫描 metrics.ts + route.ts 里的定义）
//
// 为什么是静态扫描而不是 import：本脚本是 .mjs，由 node 直接运行，不能 import .ts。
// 真实渲染结果由 tests/alert-rules.test.ts 校验（那里能 import 模块）。
// ---------------------------------------------------------------------------
function emittedMetricNames() {
  const names = new Set();
  for (const rel of ['src/lib/observability/metrics.ts']) {
    const src = readFileSync(rel, 'utf8');
    for (const m of src.matchAll(/name:\s*['"]([a-z][a-z0-9_]*)['"]/g)) {
      if (m[1].startsWith('roveframe_')) names.add(m[1]);
    }
  }
  return names;
}

const knownMetrics = emittedMetricNames();
if (knownMetrics.size === 0) {
  console.error('没能从源码里扫到任何指标名 —— 校验器失效，按失败处理');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 极简 YAML 子集解析（只处理本仓库规则文件用到的形态）
//
// 支持的形态：映射、序列（`- key: value`）、折叠标量（`>-` 后跟缩进块）、
// 行注释。**不支持的形态会让解析结果与文件不一致**，因此最后用
// "解析到的规则数 == 文件里 `- alert:` 出现次数" 做交叉校验 —— 这是本解析器
// 不撒谎的唯一保证。
// ---------------------------------------------------------------------------
const PROMQL_KEYWORDS = new Set([
  'absent', 'absent_over_time', 'delta', 'increase', 'rate', 'irate', 'sum', 'avg', 'min', 'max',
  'count', 'count_values', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'by', 'without',
  'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'and', 'or', 'unless',
  'scalar', 'vector', 'time', 'timestamp', 'clamp_max', 'clamp_min', 'histogram_quantile',
  'changes', 'resets', 'deriv', 'predict_linear', 'label_replace', 'label_join', 'sort', 'sort_desc',
]);

function parseRules(text) {
  const lines = text.split(/\r?\n/);
  const rules = [];
  let current = null;
  let mode = null; // 'labels' | 'annotations' | null
  let annotationKey = null;

  const pushText = (target, value) => {
    if (!current) return;
    if (annotationKey) current.annotations[annotationKey] += (current.annotations[annotationKey] ? ' ' : '') + value;
    else if (target) current[target] = (current[target] ? `${current[target]} ` : '') + value;
  };

  for (const rawLine of lines) {
    // 去掉行尾注释：YAML 允许 `- alert: Foo   # 说明`。没有这一步，
    // 一条带行尾注释的规则会被解析器**静默跳过**（而计数交叉校验会发现，
    // 见下方 declaredCount !== rules.length 的判定）。
    const line = rawLine.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const alertMatch = /^(\s*)-\s+alert:\s*(\S+)\s*$/.exec(line);
    if (alertMatch) {
      current = { alert: alertMatch[2], expr: '', for: '', labels: {}, annotations: {}, indent: alertMatch[1].length };
      rules.push(current);
      mode = null;
      annotationKey = null;
      continue;
    }
    if (!current) continue;

    const keyMatch = /^(\s+)([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      // 折叠标量的续行
      if (annotationKey || mode) pushText(mode === 'annotations' ? null : mode, trimmed);
      continue;
    }
    const [, indent, key, rest] = keyMatch;
    const value = rest.trim();

    if (key === 'labels') { mode = 'labels'; annotationKey = null; continue; }
    if (key === 'annotations') { mode = 'annotations'; annotationKey = null; continue; }

    if (mode === 'labels') { current.labels[key] = value; continue; }
    if (mode === 'annotations') {
      if (value === '>-' || value === '>' || value === '|' || value === '|-') {
        annotationKey = key;
        current.annotations[key] = '';
      } else {
        annotationKey = null;
        current.annotations[key] = value.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    if (key === 'expr') { current.expr = value.replace(/^["']|["']$/g, ''); continue; }
    if (key === 'for') { current.for = value; continue; }
    if (key === 'record') { current.record = value; continue; }
    void indent;
  }
  return rules;
}

const failures = [];
const fail = (msg) => failures.push(msg);

let totalRules = 0;
const allRules = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`读不到 ${file}: ${e.message}`);
    process.exit(2);
  }

  // 交叉校验：文件里声明的 alert 数（纯文本计数，不依赖解析器）
  const declaredCount = (text.match(/^\s*-\s+alert:/gm) ?? []).length;
  const rules = parseRules(text);

  if (declaredCount !== rules.length) {
    fail(`${file}: 解析到 ${rules.length} 条规则，但文件里有 ${declaredCount} 个 "- alert:"`
      + ' —— 解析器漏读了。在修复解析器之前，本校验的"通过"不成立。');
  }
  if (declaredCount === 0) fail(`${file}: 一个 alert 都没有`);

  for (const rule of rules) {
    const where = `${file} :: ${rule.alert}`;
    if (!rule.alert || !/^[A-Za-z][A-Za-z0-9_]*$/.test(rule.alert)) fail(`${where}: alert 名不合法`);
    if (!rule.expr) fail(`${where}: 缺 expr`);
    if (!rule.for) fail(`${where}: 缺 for（没有 for 的规则会在单次抖动上触发）`);
    if (!rule.labels.severity) fail(`${where}: 缺 labels.severity`);
    else if (!['critical', 'warning', 'info'].includes(rule.labels.severity)) {
      fail(`${where}: severity=${rule.labels.severity}（只允许 critical/warning/info）`);
    }
    if (!rule.annotations.summary) fail(`${where}: 缺 annotations.summary`);
    if (!rule.annotations.runbook || rule.annotations.runbook.length < 20) {
      fail(`${where}: 缺 annotations.runbook（值班第一步做什么？写不出来说明这条规则不该存在）`);
    }

    // 指标名检查：expr 里的标识符，去掉 PromQL 关键字后必须都是本仓库导出的指标。
    //
    // ⚠️ 必须先剥掉两类东西，否则会产生假阳性（第一版就是这样把正确的规则判成错的）：
    //   1. label 匹配块 `{queue="notification"}` —— 里面的 queue / notification
    //      是标签名与标签值，不是指标名；
    //   2. 数字字面量，包括科学计数法（1.5e9 里的 e9）与时长（1h / 5m / 24h）。
    const exprWithoutLabels = rule.expr.replace(/\{[^}]*\}/g, ' ');
    const exprSkeleton = exprWithoutLabels
      .replace(/\d+(\.\d+)?([eE][+-]?\d+)?[smhdwy]?/g, ' ');
    const identifiers = [...exprSkeleton.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)].map((m) => m[0]);
    for (const id of new Set(identifiers)) {
      if (PROMQL_KEYWORDS.has(id)) continue;
      if (id.startsWith('roveframe_')) {
        if (!knownMetrics.has(id)) {
          fail(`${where}: expr 引用了不存在的指标 ${id}`
            + ' —— 这条规则永远不会触发，而且看起来像"已覆盖"');
        }
      } else if (!/^(true|false)$/.test(id)) {
        fail(`${where}: expr 里的 ${id} 既不是已知指标也不是 PromQL 关键字`
          + '（外部指标如 up 需要显式加入允许列表）');
      }
    }
    allRules.push(rule);
  }
  totalRules += rules.length;
}

const names = allRules.map((r) => r.alert);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) fail(`alert 名重复：${[...new Set(dupes)].join(', ')}`);

// ---------------------------------------------------------------------------
// 可选：与真实端点对照
// ---------------------------------------------------------------------------
const base = getArg('--base');
if (base) {
  const key = getArg('--key') ?? process.env.ROVEAGENT_API_KEY;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/metrics`, {
      headers: key ? { 'x-roveagent-key': key } : {},
    });
    if (!res.ok) {
      fail(`--base ${base} 返回 HTTP ${res.status}（无法对照，不等于通过）`);
    } else {
      const body = await res.text();
      const live = new Set(
        body.split('\n')
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => l.split(/[ {]/)[0]),
      );
      const referenced = new Set(
        allRules.flatMap((r) => [...r.expr.matchAll(/roveframe_[a-z0-9_]+/g)].map((m) => m[0])),
      );
      const missingLive = [...referenced].filter((m) => !live.has(m));
      if (missingLive.length) {
        fail(`这些指标在 ${base}/api/metrics 的实际输出里不存在：${missingLive.join(', ')}`
          + '（代码里有定义但当前实例没导出，规则在该实例上无法评估）');
      } else {
        console.log(`[live] ${referenced.size} 个被引用的指标都能在 ${base}/api/metrics 里找到`);
      }
    }
  } catch (e) {
    fail(`无法访问 ${base}/api/metrics：${e.message}（对照未完成，不等于通过）`);
  }
}

// ---------------------------------------------------------------------------
console.log(`规则文件：${files.join(', ')}`);
console.log(`已知指标名（源码扫描）：${knownMetrics.size}`);
console.log(`解析到的规则数：${totalRules}`);
for (const r of allRules) console.log(`  [${r.labels.severity ?? '?'}] ${r.alert}  (for ${r.for})`);

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ 全部通过');
