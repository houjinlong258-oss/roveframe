import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 注册的**补偿回滚**守卫（Phase 18）。
 *
 * ## 被守住的缺陷
 *
 * 注册分七步且**不是事务**。实测（2026-09-19）：用已注册的邮箱注册时，
 * 库里斯增了一个"有业务、有订阅、但没有任何登录凭据"的租户
 * （`424323Hou`：businesses=1, users=0, settings=0），而接口返回 500
 * `create auth user failed: ...`。
 *
 * 后果比"多了条垃圾数据"重得多：
 *   · 用户不知道原因（500 不说明该做什么），于是**重试**；
 *   · 重试累积触发注册限流，最后**连登录都被锁住**；
 *   · 用户的结论是"连不上数据库" —— 与真实原因完全无关。
 *
 * 这个文件守两件事：
 *   1. 邮箱已注册要返回 **409 + 可执行的提示**，不是 500；
 *   2. 任何一步失败都要**回滚**已建产物，不留孤儿租户。
 */

const ROOT = process.cwd();
const SRC = readFileSync(`${ROOT}/src/app/api/auth/signup/route.ts`, 'utf8');

/** 去掉注释：本仓库的注释大量在解释这些缺陷本身，不剥掉会自己触发自己。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SRC);

describe('signup rollback contract', () => {
  test('每个创建步骤的失败分支都调用了回滚', () => {
    // 第 2~7 步的失败点。第 1 步（建租户）失败时还没建任何东西，无需回滚。
    const failureSites = [
      'create business failed',
      'create subscription failed',
      'create public.users failed',
      'create settings failed',
      'sign in failed',
    ];
    for (const site of failureSites) {
      const index = CODE.indexOf(site);
      assert.ok(index > 0, `找不到失败分支: ${site}`);
      // 该分支返回前 600 字符内必须出现 rollbackSignup
      const window = CODE.slice(Math.max(0, index - 600), index);
      assert.match(window, /await rollbackSignup\(created\)/,
        `${site} 之前没有调用 rollbackSignup —— 这一步失败会留下孤儿租户`);
    }
  });

  test('auth 用户创建失败也要回滚（实测那次就是断在这一步）', () => {
    const index = CODE.indexOf('create auth user failed');
    assert.ok(index > 0);
    const window = CODE.slice(Math.max(0, index - 900), index);
    assert.match(window, /await rollbackSignup\(created\)/);
  });

  test('邮箱已注册返回 409 且带可执行提示，不是 500', () => {
    assert.match(CODE, /isEmailAlreadyRegistered\(/);
    // 不用 `s` 标志（dotAll）—— tsconfig 目标是 ES2017，TS1501 会直接报错。
    // 需要跨行匹配时用 [\s\S] 显式表达。
    assert.match(CODE, /already registered[\s\S]{0,200}Sign in instead|Sign in instead/i);
    assert.match(CODE, /,\s*409\)/);
  });

  test('重复邮箱分支不再累加邮箱退避（它是用户能自己解决的情况，不该被惩罚）', () => {
    // 只取 `if (already) { ... }` 这一块。第一版我取的是"从 already 到建
    // public.users"的区间，那把**非**重复邮箱分支的 `noteFailure` 也框了进来 ——
    // 而那一句是对的（真失败本来就该退避）。断言写粗了会把正确代码判成错的。
    const start = CODE.indexOf('if (already) {');
    assert.ok(start > 0, '找不到 if (already) 分支');
    const block = CODE.slice(start, CODE.indexOf('}', CODE.indexOf('409', start)));
    assert.ok(block.includes('409'));
    assert.equal(/noteFailure\(/.test(block), false,
      '重复邮箱分支调用了 noteFailure：用户会被退避惩罚，而这不是他的错');
  });

  test('回滚会清掉引用 business 的表（实测 agent_tasks 外键会挡住删 business）', () => {
    const block = CODE.slice(CODE.indexOf('async function rollbackSignup'), CODE.indexOf('function isEmailAlreadyRegistered'));
    assert.match(block, /agent_task_runs/);
    assert.match(block, /agent_tasks/);
    // 顺序：引用方在前
    assert.ok(block.indexOf('agent_tasks') < block.indexOf("from('businesses')"),
      'agent_tasks 必须在 businesses 之前删，否则撞外键');
  });

  test('回滚单步失败只记日志、继续下一条（不能掩盖原始错误）', () => {
    const block = CODE.slice(CODE.indexOf('async function rollbackSignup'), CODE.indexOf('function isEmailAlreadyRegistered'));
    assert.match(block, /console\.error/);
    // 不能有裸的 catch {} —— 那会让回滚失败彻底静默
    assert.equal(/catch\s*\{\s*\}/.test(block), false, '回滚里出现了静默 catch');
  });

  // -------------------------------------------------------------------------
  // 负向对照：把守卫指向一个**没有**回滚的实现，同样的检查必须失败。
  // 没有这一段，上面的断言无法证明自己能失败。
  // -------------------------------------------------------------------------
  test('负向对照：一个不回滚的实现必须被同一套检查判为不合规', () => {
    const broken = `
      const t = await createTenantRow({ name: business_name });
      const b = await createBusinessRow({ tenantId: t.data.tenantId });
      if (!b.ok) { return jsonError('create business failed: ' + b.error, 500); }
      const a = await createAuthUserWithTenant({ email });
      if (!a.ok) { return jsonError('create auth user failed: ' + a.error, 500); }
    `;
    const index = broken.indexOf('create business failed');
    const window = broken.slice(Math.max(0, index - 600), index);
    assert.doesNotMatch(window, /await rollbackSignup\(created\)/,
      '负向对照失效：检查居然认为一个不回滚的实现是合规的');
  });

  test('负向对照：把 409 改回 500，状态码断言必须失败', () => {
    const broken = `if (already) { return jsonError('This email is already registered.', 500); }`;
    assert.equal(/already registered[\s\S]{0,80}409/.test(broken), false,
      '负向对照失效：检查没看出 500 与 409 的区别');
  });
});
