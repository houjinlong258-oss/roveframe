import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 保存反馈的可见性闸门 —— 一个真实发生过的「假保存」缺陷。
 *
 * ## 缺陷现场
 *
 * 用户报告：设置页输入模型 API Key 与 Base URL 后「保存不了 / 假保存」。
 *
 * 服务端并没有问题：三条写分支（新建 / 更新已有行 / 不重发 key 只改 URL）与
 * DELETE 都实测通过，被拒绝的请求也确实返回 400 且带明确原因。问题在于**反馈看不见**：
 *
 *   · 保存成功 → `setModelModal(null)` 先关弹窗，再提示 → 用户看得见。
 *   · 保存失败 → `flashSaveError()` 设置错误文案，而**关弹窗那行在 await 之后**，
 *     所以弹窗不关；此时错误提示渲染在**页头的正常文档流**里（position: static、
 *     z-index: auto），而本页所有弹窗都是 `fixed inset-0 z-50` 的全屏遮罩 ——
 *     提示被压在遮罩底下。
 *
 * 实测证据（命中测试，不是读代码）：`document.elementFromPoint(提示中心)` 在弹窗
 * 打开时返回的是**弹窗内部的 INPUT**，关掉弹窗后返回的才是提示元素本身 ——
 * 同一元素、同一时刻，只有遮罩不同。
 *
 * 这也是一个「探针不能失败」的教训：第一次复现时用 `document.body.innerText`
 * 判断错误是否可见，读到文案就判 PASS。但 `innerText` 只排除 `display:none` 与
 * `visibility:hidden`，**不做遮挡判定**，被盖住的文字照样读得到。断言必须用命中测试。
 *
 * ## 本测试守住什么
 *
 * 保存反馈容器必须 `fixed`，且 z-index **严格高于本页所有弹窗遮罩的 z-index**
 * （不写死 50：弹窗层级从源码里解析，改弹窗层级时这个测试会跟着动）。
 * 同时要求反馈文案的渲染点全部位于该容器之后，防止有人再补一个页面流里的副本。
 *
 * 负向对照（已实际执行，见交付说明）：
 *   · 把 `z-[60]` 改成 `z-10` → 变红；
 *   · 删掉 `fixed` → 变红。
 */

const ROOT = process.cwd();
const SETTINGS_PAGE = join('src', 'app', '[locale]', 'settings', 'page.tsx');

/** 从 className 里取 z-index 数值，支持 `z-50` 与 `z-[60]` 两种写法。 */
function zIndexOf(className: string): number | null {
  const arbitrary = /(?:^|\s)z-\[(\d+)\](?:\s|$)/.exec(className);
  if (arbitrary) return Number(arbitrary[1]);
  const plain = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(className);
  if (plain) return Number(plain[1]);
  return null;
}

const source = readFileSync(join(ROOT, SETTINGS_PAGE), 'utf8');

/** 本页所有弹窗遮罩：类名以 `fixed inset-0` 开头。 */
const modalZIndexes = [...source.matchAll(/className="(fixed inset-0[^"]*)"/g)]
  .map((m) => zIndexOf(m[1]))
  .filter((n): n is number => n !== null);

/** 保存反馈容器：`{(savedTip || saveError) && (<div className="...">`。 */
const feedbackMatch = /\{\(savedTip \|\| saveError\)\s*&&\s*\(\s*<div className="([^"]+)"/.exec(source);

describe('设置页保存反馈的可见性', () => {
  test('前置事实：本页确实有多个弹窗遮罩，且层级可解析', () => {
    assert.ok(
      modalZIndexes.length >= 4,
      `应能从 ${SETTINGS_PAGE} 解析出多个弹窗遮罩的 z-index，实际 ${modalZIndexes.length} 个。` +
        '若弹窗类名不再以 "fixed inset-0" 开头，请同步更新本测试。',
    );
  });

  test('保存反馈容器存在（否则本测试是空转的）', () => {
    assert.ok(
      feedbackMatch,
      `在 ${SETTINGS_PAGE} 中找不到保存反馈容器 {(savedTip || saveError) && (<div className="...">。` +
        '若改写为其他形式，请同步更新本测试，不要直接删掉这条断言。',
    );
  });

  test('保存反馈容器是 fixed（不是文档流里的页头提示）', () => {
    assert.ok(feedbackMatch);
    const className = feedbackMatch[1];
    assert.match(
      className,
      /(?:^|\s)fixed(?:\s|$)/,
      `保存反馈容器必须 fixed，否则会被 z-50 的弹窗遮罩盖住。当前 className: ${className}`,
    );
  });

  test('保存反馈容器的 z-index 严格高于所有弹窗遮罩', () => {
    assert.ok(feedbackMatch);
    const className = feedbackMatch[1];
    const feedbackZ = zIndexOf(className);
    const maxModalZ = Math.max(...modalZIndexes);
    assert.notEqual(
      feedbackZ,
      null,
      `保存反馈容器必须显式声明 z-index（当前 className: ${className}）。` +
        `显式 z-index:auto 不参与层级竞争，会被 z-${maxModalZ} 的遮罩盖住。`,
    );
    assert.ok(
      (feedbackZ as number) > maxModalZ,
      `保存反馈的 z-index (${feedbackZ}) 必须 > 弹窗遮罩最大 z-index (${maxModalZ})，` +
        '否则保存被拒时用户看不到任何提示 —— 即「假保存」。',
    );
  });

  test('反馈文案只在固定浮层里渲染，没有残留的页面流副本', () => {
    assert.ok(feedbackMatch);
    const containerStart = feedbackMatch.index;
    for (const token of ['{savedTip}', '{saveError}']) {
      const at = source.indexOf(token);
      assert.notEqual(at, -1, `找不到渲染点 ${token}`);
      assert.ok(
        at > containerStart,
        `${token} 出现在保存反馈浮层之前（页面流里），会与浮层重复显示且被弹窗遮住。`,
      );
    }
  });

  test('负向对照：zIndexOf 对常见写法都能解析，且不误判无层级的类名', () => {
    assert.equal(zIndexOf('fixed top-4 right-4 z-[60] pointer-events-none'), 60);
    assert.equal(zIndexOf('fixed inset-0 bg-black/50 z-50'), 50);
    assert.equal(zIndexOf('fixed inset-0 z-50 flex'), 50);
    assert.equal(zIndexOf('inline-flex items-center text-error'), null);
    assert.equal(zIndexOf('z-50ish'), null, 'z-50ish 不是合法的 z-index 工具类，不能误判为 50');
  });
});
