import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 审计 —— 通知出件"认领失败"不得静默成"没有工作"。
 *
 * ## 被修的是什么
 *
 * `claimNotificationOutbox` 原来是：
 *
 *     if (error) return [];
 *
 * 这是本仓库记录过**三次**的静默兜底形态（`agent/tasks/types.ts:82`、
 * `worker.ts:280` 都留着同样的教训注释，Phase 15 有一条 SQL 缺陷因此隐藏了
 * 11 天）。这里的后果不是崩溃，是**投递循环安静空转**：
 * outbox 里堆着待发通知，每一 tick 都报告"处理了 0 条"，日志里一个字都没有。
 *
 * ## 为什么"抛错"在这里是对的
 *
 * 唯一调用方 `dispatchNotificationOutbox` 被 `scheduler.ts:498-502` 的
 * try/catch 包着，会打 `[scheduler] notification outbox worker failed:` ——
 * 失败变成一条有据可查的日志。
 *
 * 分辨标准（本文件把这个判断写下来，避免以后又有人"顺手"加回静默）：
 *   · 返回**工作清单**的函数：失败不能静默成空清单，因为调用方会据此少做事；
 *   · 返回**统计值**的函数（如 `recoverStaleOutboxItems`）：记日志 + 返回零可以接受。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('claimNotificationOutbox —— 认领失败必须抛错', () => {
  const raw = read('src/lib/notifications/outbox.ts');
  const src = stripComments(raw);

  test('不再有 `if (error) return []`', () => {
    assert.doesNotMatch(
      src,
      /if \(error\) return \[\];/,
      '认领失败被静默成空清单 —— 投递循环会安静空转，而日志里什么都没有',
    );
  });

  test('改为抛出带原因的异常', () => {
    assert.match(src, /throw new Error\(`notification outbox claim failed:/);
  });

  test('负向对照：旧的静默写法必须被上面第一条拒绝', () => {
    const legacy = `
      export async function claimNotificationOutbox() {
        const { data, error } = await client.rpc('claim_notification_outbox', {});
        if (error) return [];
        return data ?? [];
      }`;
    assert.match(legacy, /if \(error\) return \[\];/);
    assert.doesNotMatch(stripComments(read('src/lib/notifications/outbox.ts')), /if \(error\) return \[\];/);
  });

  test('调用方确实会把它变成可查的日志（否则抛错等于崩溃）', () => {
    const scheduler = read('src/lib/scheduler.ts');
    // 这个 try/catch 是"抛错安全"的前提：它必须包住 dispatchNotificationOutbox
    assert.match(
      scheduler,
      /try\s*\{\s*await dispatchNotificationOutbox\(\);[\s\S]{0,200}?catch[\s\S]{0,120}?notification outbox worker failed/,
    );
    // 负向对照：把那个 catch 去掉，本断言必须失败
    const withoutCatch = scheduler.replace(/catch \(notificationErr\)[\s\S]{0,120}?\}/, '');
    assert.doesNotMatch(
      withoutCatch,
      /try\s*\{\s*await dispatchNotificationOutbox\(\);[\s\S]{0,200}?catch[\s\S]{0,120}?notification outbox worker failed/,
    );
  });

  test('同文件的"统计值"函数保持记日志 + 返回零（两种处置不冲突）', () => {
    // 这条把分辨标准钉住：统计值静默成 0 不改变调用方行为，工作清单静默成空会。
    const recover = src.slice(src.indexOf('export async function recoverStaleOutboxItems'));
    const body = recover.slice(0, recover.indexOf('\n}'));
    assert.match(body, /console\.error\('\[notifications\/outbox\] stale lease lookup failed:/);
    assert.match(body, /return \{ requeued: 0, failed: 0 \};/);
  });
});
