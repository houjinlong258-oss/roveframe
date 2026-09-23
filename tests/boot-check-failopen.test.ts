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
  /**
   * ⚠️ 本节在 Phase 19 被**收窄**过，原文保留在此：
   *
   *   原文断言的是"每张 REQUIRED_TABLE 都配了探针列"与"PROBE_COLUMN 的值不是 *"。
   *   那两条守卫的对象是**探针形态**（11 张手写表 + 每表一个探针列）。
   *   Phase 19 上线阻断项 6 把 boot-check 换成**从 schema.ts 派生的全量漂移检测**，
   *   探针列这个机制整个不存在了 —— 继续断言它只会锁住一个已被淘汰的设计。
   *
   *   取而代之的守卫在 `tests/schema-drift-gate.test.ts`：期望清单必须覆盖
   *   全部表与全部列（而不是子集），且缺表/缺列必须被报出来。
   *
   * 仍然保留的 `head:true` 两条：那条形态是"永远通过"的根源，与本次改造无关，
   * 且 scheduler.ts 里还有同一形态。任何把它写回去的改动都必须立刻变红。
   */
  test('boot-check 不使用 head:true', () => {
    const src = readSource('src/lib/boot-check.ts');
    // 只检查非注释行：注释里提到 head:true 是在解释这个坑，不算违规。
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.equal(
      /head:\s*true/.test(code), false,
      'boot-check.ts 又用回了 head:true —— 该形态对不存在的表返回 204 且 error 为 null，'
      + '自检会重新变成"永远通过"。',
    );
  });

  test('boot-check 不再维护手写的表子集清单（期望值必须派生）', () => {
    const src = readSource('src/lib/boot-check.ts');
    assert.equal(
      /const REQUIRED_TABLES\s*=/.test(src), false,
      'boot-check.ts 又出现了手写的 REQUIRED_TABLES —— 手写清单会腐烂，且腐烂是静默的'
      + '（migrate-rls.sql 漏掉 12 张表就是同一形态）。期望值必须从 schema.ts 派生。',
    );
    assert.match(src, /expectedSchemaFromModule/, '期望值必须来自 schema.ts');
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

  test('从 schema.ts 派生的期望清单是完整的（≥52 张表）', async () => {
    // Phase 19：探针列机制已随全量漂移检测一起移除（见本节顶部说明）。
    // 这里改为断言"派生出的期望清单是完整的"，而不是断言子集的配置完整性。
    const { expectedSchemaFromModule } = await import('../src/lib/schema-drift');
    const schema = await import('../src/storage/database/shared/schema');
    const expected = expectedSchemaFromModule(schema as unknown as Record<string, unknown>);
    const tables = Object.keys(expected);
    assert.ok(
      tables.length >= 52,
      `从 schema.ts 只派生出 ${tables.length} 张表（应为 52 张）—— 派生逻辑失效会让漂移检查静默通过`,
    );
  });
});
