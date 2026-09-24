import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkBaseUrl } from '../src/lib/ai/url-utils';
import { PROVIDER_CATALOG } from '../src/lib/ai/provider-catalog';

/**
 * 「本地端点配不上」这条死路的守卫。
 *
 * ## 缺陷现场（用户报告「输入模型的 apikey 和 url，保存不了」）
 *
 * catalog 里 `litellm` 的条目是：
 *
 *     category: 'gateway', defaultBaseUrl: 'http://localhost:4000/v1'
 *
 * 而设置页原先只在 `category === 'local' || id === 'custom'` 时渲染
 * 「允许本地/内网地址」开关。于是这个 provider：
 *
 *   1. 弹窗打开时 Base URL 预填 `http://localhost:4000/v1`；
 *   2. `localhost` 落在 REBINDING_HOSTNAME_PATTERNS 里，`checkBaseUrl` 在
 *      `allowLocal:false` 下拒绝它（实测 HTTP 400 `rebinding_hostname_blocked`）；
 *   3. 唯一能授权它的开关**不渲染** → 用户没有任何办法保存。
 *
 * 实测：同一请求补上 `optInLocal:true` 后服务端返回 **200** —— 阻塞点只在 UI
 * 没有把服务端已经支持的 opt-in 暴露出来，不是服务端不支持本地端点。
 *
 * ## 修法与为什么不能按 URL 判断
 *
 * 曾试过「客户端按当前 URL 判断该不该显示开关」，它需要把 `checkBaseUrl` 搬进
 * 客户端包，而它依赖 `node:dns/promises`（构建直接失败），且会让 UI 策略与
 * 服务端策略成为两份实现 —— 那正是本缺陷的成因。最终做法是**开关无条件渲染**：
 * category 只用于分组展示，不该承载安全策略；服务端本来就对任意 provider 承认
 * optInLocal，且云 metadata 地址任何策略下都拒绝。
 *
 * ## 为什么原因串也要管
 *
 * `localhost` 被拒时原本报 `rebinding_hostname_blocked`（DNS 重绑定），
 * 但真实原因是「这是本地地址」。文案错会把人往错的方向引，而正确动作只是勾一下开关。
 */

const ROOT = process.cwd();
const SETTINGS_PAGE = join('src', 'app', '[locale]', 'settings', 'page.tsx');
const settingsSource = readFileSync(join(ROOT, SETTINGS_PAGE), 'utf8');

/**
 * 「允许本地/内网地址」开关是否被 provider 的 category 门控住了。
 *
 * 判据：开关的 `<label>` 之前一段窗口内是否出现 `modelModal.category` 条件。
 * 这个检测器本身由下面的自测用例证明「能返回 true」—— 否则它就是永远为 false 的空断言。
 */
function isSwitchCategoryGated(source: string): boolean {
  const labelAt = source.indexOf("t('optInLocal')");
  if (labelAt === -1) return false;
  const window = source.slice(Math.max(0, labelAt - 600), labelAt);
  const labelStart = window.lastIndexOf('<label');
  return labelStart !== -1 && /modelModal\.category/.test(window.slice(0, labelStart));
}

describe('checkBaseUrl —— 本地端点的拒绝原因与放行', () => {
  test('localhost 的原因串是「需要本地 opt-in」，不是「重绑定域名」', () => {
    const check = checkBaseUrl('http://localhost:11434/v1', { production: true, allowLocal: false });
    assert.equal(check.ok, false);
    assert.equal(
      check.reason,
      'local_address_requires_optin',
      'localhost 被拒的真实原因是本地地址，报 rebinding_hostname_blocked 会误导排查方向',
    );
  });

  test('裸 IP 私网与明文 http 的原因串保持原样（未被本次改动波及）', () => {
    assert.equal(checkBaseUrl('http://192.168.1.20:8000/v1', { production: true, allowLocal: false }).reason, 'local_http_requires_optin');
    assert.equal(checkBaseUrl('https://192.168.1.20/v1', { production: true, allowLocal: false }).reason, 'private_address_blocked_in_production');
    assert.equal(checkBaseUrl('https://127.0.0.1.nip.io/v1', { production: true, allowLocal: false }).reason, 'rebinding_hostname_blocked');
  });

  test('真正的重绑定域名仍然报 rebinding_hostname_blocked', () => {
    assert.equal(checkBaseUrl('https://evil.nip.io/v1', { production: true, allowLocal: false }).reason, 'rebinding_hostname_blocked');
  });

  test('行为未变：给上 opt-in 后 localhost/http 放行，公网明文 http 仍拒', () => {
    assert.equal(checkBaseUrl('http://localhost:11434/v1', { production: true, allowLocal: true }).ok, true);
    assert.equal(checkBaseUrl('http://203.0.113.9/v1', { production: true, allowLocal: true }).reason, 'plaintext_http_to_public_host');
  });

  test('metadata 即使 opt-in 也拒绝（这条不能被本次改动放松）', () => {
    assert.equal(checkBaseUrl('http://169.254.169.254/latest/meta-data', { production: true, allowLocal: true }).ok, false);
    assert.equal(checkBaseUrl('https://metadata.google.internal/', { production: true, allowLocal: true }).ok, false);
  });
});

describe('catalog 不变量 —— 默认 URL 需要 opt-in 的条目必须保存得了', () => {
  /**
   * 设置页 `openModelModal` 的默认值：`optInLocal: conn?.optInLocal ?? p.category === 'local'`。
   * 即：只有 category 为 local 的条目，开关**默认就勾上**；其余条目要用户自己勾。
   */
  const grantsOptInWithoutUserAction = (entry: { category: string; id: string }) =>
    entry.category === 'local' || entry.id === 'custom';

  /** 默认 URL 必须显式 opt-in 才允许、且默认勾选也救不了它的条目 —— 真正会死路的一组。 */
  const needsUserToTickTheBox = PROVIDER_CATALOG.filter((entry) => {
    if (entry.defaultBaseUrl.length === 0) return false;
    if (grantsOptInWithoutUserAction(entry)) return false;
    return checkBaseUrl(entry.defaultBaseUrl, { production: true, allowLocal: false }).ok === false;
  });

  test('前置事实：这样的条目确实存在（否则本组是空转的）', () => {
    assert.ok(
      needsUserToTickTheBox.length >= 1,
      '若这一组为空，说明 catalog 已不存在需要用户手动勾选的条目；此时应重新评估本守卫是否还有意义，而不是直接删掉它',
    );
    assert.ok(
      needsUserToTickTheBox.some((e) => e.id === 'litellm'),
      'litellm 是本次缺陷的原始触发条目，不应从这一组里消失',
    );
  });

  test('这些条目的默认 URL 在未勾选时必然被拒（死路的成因）', () => {
    for (const entry of needsUserToTickTheBox) {
      const check = checkBaseUrl(entry.defaultBaseUrl, { production: true, allowLocal: false });
      assert.equal(
        check.ok,
        false,
        `${entry.id} 的默认 URL (${entry.defaultBaseUrl}) 未勾选时竟然能通过，说明本守卫前提已变`,
      );
    }
  });

  test('勾上开关后这些条目的默认 URL 都可保存（阻塞点只在 UI 有没有给开关）', () => {
    for (const entry of needsUserToTickTheBox) {
      const check = checkBaseUrl(entry.defaultBaseUrl, { production: true, allowLocal: true });
      assert.equal(check.ok, true, `${entry.id} 勾上 opt-in 后仍不可保存：${check.reason}`);
    }
  });

  test('设置页确实渲染了「允许本地/内网地址」开关（否则上面的结论无法兑现）', () => {
    assert.match(settingsSource, /checked=\{modelForm\.optInLocal\}/, '设置页必须渲染 optInLocal 开关');
    assert.match(settingsSource, /t\('optInLocal'\)/, '开关必须有可见文案');
  });

  test('开关不得被 provider 的 category 门控（否则 litellm 这类条目又变成死路）', () => {
    assert.equal(
      isSwitchCategoryGated(settingsSource),
      false,
      "「允许本地/内网地址」开关的渲染不能带 modelModal.category 条件。\n" +
        'category 只用于分组展示，不该承载安全策略：litellm 的默认 URL 是本机地址但 category 是 gateway，' +
        '按 category 判断会让它永远保存不了。',
    );
  });

  test('负向对照：该检测器本身能把「被 category 门控」的写法判为 true', () => {
    const gatedSnippet = [
      "{/* 注释里提到 modelModal.category 不算数，只看 label 之前 */}",
      "{modelModal.category === 'local' && (",
      '  <label className="flex items-center gap-2.5">',
      "    {t('optInLocal')}",
      '  </label>',
      ')}',
    ].join('\n');
    assert.equal(isSwitchCategoryGated(gatedSnippet), true, '检测器必须能识别被门控的写法，否则它是条空断言');

    const ungatedSnippet = [
      '<label className="flex items-center gap-2.5">',
      "  {t('optInLocal')}",
      '</label>',
    ].join('\n');
    assert.equal(isSwitchCategoryGated(ungatedSnippet), false, '检测器不得把无条件渲染误判为门控');
  });
});
