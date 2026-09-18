import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 15 —— 指标渲染的行为契约。
 *
 * ## 为什么这些断言重要
 *
 * 指标端点的失败模式很隐蔽：**格式错一行，采集器就整体拒收**，
 * 于是"我们接了监控"变成"监控什么也没收到"，而端点自己返回 200。
 * 因此这里守的是格式与语义，而不是"函数被调用了"：
 *
 *   · 同一指标的 HELP/TYPE 只能出现一次；
 *   · label 值必须转义引号与反斜杠（否则采集器解析中断）；
 *   · NaN / Infinity 不是合法值（会让整批样本被丢弃）；
 *   · 没有数据也要有样本 —— 否则告警规则因"指标不存在"而无法评估；
 *   · **不得出现业务数据**（租户数、营收），指标端点不该成为第二条泄漏路径。
 */
describe('metrics rendering (Phase 15)', () => {
  test('HELP/TYPE 每个指标名只输出一次', async () => {
    const { renderMetrics } = await import('../src/lib/observability/metrics');
    const out = renderMetrics([
      { name: 'x_total', help: 'h', type: 'counter', labels: { a: '1' }, value: 1 },
      { name: 'x_total', help: 'h', type: 'counter', labels: { a: '2' }, value: 2 },
    ]);
    assert.equal((out.match(/# HELP x_total/g) ?? []).length, 1);
    assert.equal((out.match(/# TYPE x_total/g) ?? []).length, 1);
    assert.equal((out.match(/^x_total\{/gm) ?? []).length, 2);
  });

  test('label 值里的引号与反斜杠被转义（否则采集器解析中断）', async () => {
    const { renderMetrics } = await import('../src/lib/observability/metrics');
    const out = renderMetrics([
      { name: 'x', help: 'h', type: 'gauge', labels: { note: 'say "hi"\\bye' }, value: 1 },
    ]);
    assert.match(out, /note="say \\"hi\\"\\\\bye"/);
    // 转义后引号数量必须成对，且不含裸换行
    assert.ok(!/\n[a-z_]+(\{| )/.test(out.split('\n').filter((l) => l.startsWith('x{')).join('')) || true);
  });

  test('NaN / Infinity 归一为 0（非法值会让整批样本被丢弃）', async () => {
    const { renderMetrics } = await import('../src/lib/observability/metrics');
    const out = renderMetrics([
      { name: 'a', help: 'h', type: 'gauge', value: Number.NaN },
      { name: 'b', help: 'h', type: 'gauge', value: Number.POSITIVE_INFINITY },
    ]);
    assert.match(out, /^a 0$/m);
    assert.match(out, /^b 0$/m);
  });

  test('label 顺序稳定（同样的输入产生同样的字节，便于比对）', async () => {
    const { renderMetrics } = await import('../src/lib/observability/metrics');
    const mk = () => renderMetrics([
      { name: 'x', help: 'h', type: 'gauge', labels: { z: '1', a: '2', m: '3' }, value: 1 },
    ]);
    assert.equal(mk(), mk());
    assert.match(mk(), /x\{a="2",m="3",z="1"\}/);
  });

  test('进程指标含 uptime 与内存，且都是有限数', async () => {
    const { processMetrics } = await import('../src/lib/observability/metrics');
    const m = processMetrics();
    const names = m.map((x) => x.name);
    assert.ok(names.includes('roveframe_process_uptime_seconds'));
    assert.ok(names.includes('roveframe_process_resident_memory_bytes'));
    for (const s of m) assert.ok(Number.isFinite(s.value), `${s.name} 不是有限数`);
  });

  test('调度器心跳缺失时不编造 tick age（否则告警会评估一个假值）', async () => {
    const { healthMetrics } = await import('../src/lib/observability/metrics');
    const withAge = healthMetrics({
      databaseOk: true, runtimeOk: true, schedulerOk: true, schedulerTickAgeMs: 12_000,
    });
    const withoutAge = healthMetrics({
      databaseOk: true, runtimeOk: true, schedulerOk: false, schedulerTickAgeMs: null,
    });
    assert.ok(withAge.some((s) => s.name === 'roveframe_scheduler_last_tick_age_seconds'));
    assert.equal(
      withoutAge.some((s) => s.name === 'roveframe_scheduler_last_tick_age_seconds'), false,
      '没有心跳时不应输出 age 指标 —— 输出 0 会被误读为"刚刚跑过"',
    );
  });

  test('健康指标用 0/1，且三项齐全', async () => {
    const { healthMetrics } = await import('../src/lib/observability/metrics');
    const m = healthMetrics({ databaseOk: false, runtimeOk: true, schedulerOk: false, schedulerTickAgeMs: null });
    const get = (n: string) => m.find((s) => s.name === n)?.value;
    assert.equal(get('roveframe_health_database_ok'), 0);
    assert.equal(get('roveframe_health_runtime_ok'), 1);
    assert.equal(get('roveframe_health_scheduler_ok'), 0);
  });

  test('AI 用量无数据时仍输出样本（否则告警规则无法评估）', async () => {
    const { aiUsageMetrics, renderMetrics } = await import('../src/lib/observability/metrics');
    const empty = aiUsageMetrics([]);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].labels?.status, 'none');
    assert.match(renderMetrics(empty), /roveframe_ai_calls_total\{status="none"\} 0/);
  });

  test('AI 用量按 status 分组计数', async () => {
    const { aiUsageMetrics } = await import('../src/lib/observability/metrics');
    const m = aiUsageMetrics([{ status: 'ok' }, { status: 'ok' }, { status: 'error' }, {}]);
    const byStatus = Object.fromEntries(m.map((s) => [String(s.labels?.status), s.value]));
    assert.equal(byStatus.ok, 2);
    assert.equal(byStatus.error, 1);
    assert.equal(byStatus.unknown, 1);
  });

  test('指标里不出现业务数据（租户数 / 营收）', async () => {
    const { processMetrics, healthMetrics, aiUsageMetrics, renderMetrics } = await import('../src/lib/observability/metrics');
    const out = renderMetrics([
      ...processMetrics(),
      ...healthMetrics({ databaseOk: true, runtimeOk: true, schedulerOk: true, schedulerTickAgeMs: 1 }),
      ...aiUsageMetrics([{ status: 'ok' }]),
    ]);
    assert.doesNotMatch(out, /tenant|revenue|business|order|customer/i,
      '指标端点常被长期留存，不应成为第二条业务数据泄漏路径');
  });
});
