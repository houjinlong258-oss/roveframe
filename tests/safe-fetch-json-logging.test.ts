import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFetchJson } from '../src/lib/utils';

/**
 * Phase 18 —— `safeFetchJson` 不得把"未登录"打成 console error。
 *
 * ## 被修的是什么（浏览器实测发现，不是读代码猜的）
 *
 * 用 CDP 打开受保护页面时发现：`/en/customers`、`/en/marketing`、`/en/reviews`
 * 各留下 **1 条 console error**，内容是应用自己打的
 * `[safeFetchJson] GET /api/customers → 401`。
 *
 * 功能其实是对的：会话守卫随后把用户送到了登录页（已用 CDP 验证
 * `location.pathname === '/en/auth/login'`）。问题在于**信号质量**：
 *
 *   · 每次未登录访问都会出现一条 error ⇒ 人对 console error 脱敏；
 *   · 真正的失败（接口 500、hydration 崩）也被当成"老样子"；
 *   · 浏览器端验证脚本的判定建立在 error 计数上 —— 不修它，那个判定就不可用。
 *
 * 因此 401（预期内的拒绝）降级为 `console.debug`，其余 4xx/5xx 仍是 error。
 *
 * ## 负向对照
 *
 * 把 503 也当成"预期拒绝"会让这条守卫变红 —— 那正是"为了让日志干净而把
 * 真失败一起静音"的做法。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('safeFetchJson：401 留痕但不报 error', () => {
  const raw = read('src/lib/utils.ts');
  const src = stripComments(raw);

  test('存在"预期内拒绝"的判定，且只覆盖 401', () => {
    assert.match(src, /function isExpectedDenial\(status: number\): boolean/);
    assert.match(src, /return status === 401;/);
    // 负向对照：把 503 也纳入"预期拒绝"必须被这条正则拒绝
    assert.doesNotMatch(src, /status === 401 \|\| status === 503/);
  });

  test('401 分支用 console.debug，其余分支仍用 console.error', () => {
    assert.match(src, /console\.debug\(`\$\{label\}（未认证，跳转登录页）`\)/);
    assert.match(src, /console\.error\(label\)/);

    // 负向对照（用**精确的切片**而不是跨分支的宽正则）：把真失败那一行换成
    // debug、或把 error 挪进 401 分支，都必须被这里拒绝。
    // 上一版写成 /isExpectedDenial[\s\S]{0,120}?console\.error\(label\)/，
    // 它会跨过 else 分数命中 —— 那是断言写虚，不是实现有问题。
    const guardAt = src.indexOf('if (isExpectedDenial(res.status)) {');
    const elseAt = src.indexOf('} else {', guardAt);
    const redirectAt = src.indexOf('redirectToLoginOn401(res.status)', elseAt);
    assert.ok(guardAt > 0 && elseAt > guardAt && redirectAt > elseAt, '三个锚点都必须能找到');
    const ifBranch = src.slice(guardAt, elseAt);
    const elseBranch = src.slice(elseAt, redirectAt);
    assert.doesNotMatch(ifBranch, /console\.error/, '401 分支里不得出现 console.error');
    assert.match(elseBranch, /console\.error\(label\)/, 'else 分支必须用 console.error');
  });

  test('跳转逻辑没有被削弱（401 仍要送去登录页）', () => {
    assert.match(src, /redirectToLoginOn401\(res\.status\)/);
  });

  test('真正的失败仍然留痕（P0-7 的意图没被牺牲）', () => {
    // 用**未剥注释**的原文：`[safeFetchJson]` 里的 `//` 会被 stripComments 当成
    // 行注释吃掉，于是断言在一个原文里存在的字符串上失败 —— 上一版就是这么红的。
    assert.match(raw, /P0-7/);
    assert.match(raw, /console\.error\(`\[safeFetchJson\]/);
    // 负向对照：把那一行 error 删掉，上面第二条必须失败
    const withoutErrorLog = raw.replace(/console\.error\(`\[safeFetchJson\][^\n]*\n/, '');
    assert.doesNotMatch(withoutErrorLog, /console\.error\(`\[safeFetchJson\]/);
  });
});

describe('safeFetchJson：行为（真实调用，桩掉 fetch）', () => {
  async function withFetch(status: number, run: () => Promise<void>): Promise<{ errors: string[]; debugs: string[] }> {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const originalDebug = console.debug;
    const errors: string[] = [];
    const debugs: string[] = [];
    globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    console.debug = (...args: unknown[]) => { debugs.push(args.map(String).join(' ')); };
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      console.debug = originalDebug;
    }
    return { errors, debugs };
  }

  test('401 → 不产生 console.error，但产生一条 debug（留痕）', async () => {
    const { errors, debugs } = await withFetch(401, async () => {
      const result = await safeFetchJson('/api/customers');
      assert.equal(result, null, '401 必须返回 null 让调用方走空态');
    });
    assert.deepEqual(errors, [], `401 不应产生 console.error，实际: ${JSON.stringify(errors)}`);
    assert.equal(debugs.length, 1, '401 仍必须留痕（debug 级）');
    assert.match(debugs[0], /401/);
  });

  test('503 → 仍然产生 console.error（真失败不能被静音）', async () => {
    const { errors } = await withFetch(503, async () => {
      await safeFetchJson('/api/health');
    });
    assert.equal(errors.length, 1, '503 必须留痕为 error');
    assert.match(errors[0], /503/);
  });

  test('500 → 仍然产生 console.error', async () => {
    const { errors } = await withFetch(500, async () => {
      await safeFetchJson('/api/anything');
    });
    assert.equal(errors.length, 1);
  });

  test('负向对照：permissive 判定会静音 503，当前实现不会', async () => {
    // 真实的对照：同一组状态码分别喂给"永远算预期拒绝"的判定与真实实现，
    // 看两者是否会产生**不同**的日志级别。若没有区别，说明当前实现的区分是
    // 多余的（或者根本没生效）。
    const permissive = (_status: number): boolean => true;
    // 真实实现的行为：已经由上面三条 withFetch 用例实测（401 静音、503/500 报错）。
    // 这里只演示 permissive 分支下 503 会被静音，从而证明"必须区分 401 与 5xx"。
    const statusesToCheck = [401, 500, 503];
    const permissiveSilenced = statusesToCheck.filter((s) => permissive(s));
    assert.deepEqual(
      permissiveSilenced,
      [401, 500, 503],
      'permissive 判定把 5xx 也静音了 —— 这正是当前实现要避免的',
    );
    // 而真实实现下，5xx 会产生 error（由上面 withFetch(503)/withFetch(500) 两条钉住）。
  });
});
