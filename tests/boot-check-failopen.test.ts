import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 15 —— 存在性探测的 fail-open 回归守卫。
 *
 * ## 被守住的东西
 *
 * Phase 14 的验收报告把 `✓ [boot-check] 数据库 schema 完整` 当作通过证据。
 * Phase 15 用对照实验证明它不成立：`src/lib/boot-check.ts` 当时用的是
 *
 *     client.from(table).select('*', { count: 'exact', head: true })
 *
 * 而 `head: true` 让 PostgREST 对**不存在的表**返回 204 且 `error === null`，
 * 于是 `Boolean(error)` 恒为 false —— 每一张表都被判为"存在"。
 * 直接调用生产函数 `runBootChecks()` 时，把 `zzz_definitely_not_a_table_9f3a`
 * 这类绝不可能存在的表名喂进去同样报"不缺失"（见
 * `scripts/_prove_bootcheck_failopen.mts`）。
 *
 * 同一形态还出现在 `src/lib/scheduler.ts` 的 `cron_state` 就绪判定里，
 * 会让 `schedulerHealth().degraded` 永远为 false。
 *
 * ## 为什么是源码契约测试
 *
 * 一个"永远通过"的探针，其失败模式是**它没有失败模式**。要在没有真实库的
 * 单测里复现，必须注入一个会按 404 语义失败的假 client —— 那测的是假 client
 * 而不是生产代码。因此这里断言的是**探针形态本身**：形态对了，语义才有保障。
 * 真实库上的行为验证在 `scripts/_prove_bootcheck_failopen.mts`（阴性对照 + 有效复测）。
 *
 * 这类断言的价值在于：任何把 `head: true` 写回存在性探测的改动都会立刻变红。
 */

const ROOT = process.cwd();

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('existential probes must not fail open (Phase 15)', () => {
  test('boot-check 的存在性探测不使用 head:true', () => {
    const src = readSource('src/lib/boot-check.ts');
    // 只检查非注释行：注释里提到 head:true 是在解释这个坑，不算违规。
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.equal(
      /head:\s*true/.test(code), false,
      'boot-check.ts 又用回了 head:true —— 该形态对不存在的表返回 204 且 error 为 null，'
      + '自检会重新变成"永远通过"。改用列投影（见 PROBE_COLUMN）。',
    );
  });

  test('scheduler 的 cron_state 就绪判定不使用 head:true', () => {
    const src = readSource('src/lib/scheduler.ts');
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.equal(
      /head:\s*true/.test(code), false,
      'scheduler.ts 又用回了 head:true —— _cronStateReady 会在表缺失时仍为 true，'
      + 'schedulerHealth().degraded 永远为 false，/api/health 漏报调度器降级。',
    );
  });

  test('每张 REQUIRED_TABLE 都配了探针列（新增表不得漏配）', async () => {
    const mod = await import('../src/lib/boot-check');
    const tables = mod.BOOT_CHECK_REQUIRED_TABLES;
    const columns = mod.BOOT_CHECK_PROBE_COLUMN;

    assert.ok(tables.length > 0, 'REQUIRED_TABLES 不应为空');

    const unconfigured = tables.filter((t) => !columns[t]);
    assert.deepEqual(
      unconfigured, [],
      `这些表没有配置探针列，会退回默认 'id'：${unconfigured.join(', ')}。`
      + '若该表没有 id 列，探测会报 42703 并被误判为"表缺失"。',
    );
  });

  test('PROBE_COLUMN 的值必须是非空字符串（不得是 * 或空）', async () => {
    const mod = await import('../src/lib/boot-check');
    const columns = mod.BOOT_CHECK_PROBE_COLUMN;
    for (const [table, col] of Object.entries(columns)) {
      assert.equal(typeof col, 'string', `${table} 的探针列不是字符串`);
      assert.ok(col.length > 0, `${table} 的探针列为空`);
      assert.notEqual(col, '*', `${table} 的探针列是 '*' —— 等于退回被证伪的形态`);
    }
  });
});
