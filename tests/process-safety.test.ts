import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverSource = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');

/**
 * Phase 12 / R-04 — 进程级兜底与启动路径的接线契约。
 *
 * ## 这个测试能证明什么、不能证明什么
 *
 * 它**不能**证明处理器在真实崩溃场景下的行为 —— 那需要启动一个真实进程并
 * 令其崩溃。它**能**证明的是：接线存在，且没有被后续改动悄悄摘掉。
 *
 * 之所以需要这层保护，是因为 `src/` 全树此前**没有任何**进程级处理器，
 * 而启动路径上有两处未被 await 的 promise。事后从"服务莫名重启"的日志里
 * 反推根因的成本，远高于在这里钉住接线。这类断言在审计中被归类为
 * "源码契约"级（非行为级），此处如实标注。
 */
describe('process-level safety wiring (src/server.ts)', () => {
  test('registers an unhandledRejection handler that does not exit', () => {
    assert.match(
      serverSource,
      /process\.on\(\s*'unhandledRejection'/,
      'server 入口必须注册 unhandledRejection 处理器',
    );
  });

  test('registers an uncaughtException handler that exits for a clean restart', () => {
    const match = serverSource.match(
      /process\.on\(\s*'uncaughtException'[\s\S]*?\n\}\);/,
    );
    assert.ok(match, 'server 入口必须注册 uncaughtException 处理器');
    assert.match(
      match![0],
      /process\.exit\(1\)/,
      'uncaughtException 后必须退出：同步异常可能已让进程状态不一致，继续服务比崩溃更危险',
    );
  });

  test('the startup migrate/boot-check IIFE is caught', () => {
    // 未捕获时，autoMigrate() 在缺少 scripts/*.sql 的精简镜像上会抛出，
    // 直接杀死进程并形成 crash-loop（且日志里只有 Node 的默认提示）。
    assert.match(
      serverSource,
      /void \(async \(\) => \{[\s\S]*?\}\)\(\s*\)\s*\.catch\(/,
      '启动 IIFE 必须有 .catch() —— 缺表可以降级运行，进程死掉不行',
    );
  });

  test('app.prepare() rejection is handled', () => {
    assert.match(
      serverSource,
      /app\s*\n?\s*\.prepare\(\)[\s\S]*?\.catch\(/,
      'app.prepare() 必须有 .catch()，否则未就绪的进程会静默退出',
    );
  });
});
