import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 15 —— 集成"已连接"语义的行为契约。
 *
 * ## 被守住的误导
 *
 * 真实缺陷：老板在设置页为 ERPNext 填好地址与密钥、点"测试连接"，
 * ping 成功 → 徽章变 "Connected" → 页面还显示条目数与"最近同步"时间。
 * 而 **ERPNext 的同步端点从未实现**（`/api/integrations/[provider]/sync`
 * 对非 square 返回 400）。库存 Tab 显示的是种子/本地数据。
 *
 * 这不是崩溃而是**误导** —— 老板会据此做采购决策。
 *
 * 根因是三处各写各的：`connectIntegration` 无条件写 `status:'connected'`、
 * UI 只看 `status`、同步路由只认 square。现在三者共用
 * `src/lib/connectors/capabilities.ts` 这一个事实源。
 *
 * 本文件断言该事实源的行为，以及**调用方确实在用它的返回值**。
 */

describe('integration "connected" must not overstate capability (Phase 15)', () => {
  test('不可同步的 provider 不得被标成 connected', async () => {
    const { statusAfterConnect } = await import('../src/lib/connectors/capabilities');
    for (const p of ['erpnext', 'shopify', 'stripe', 'paypal']) {
      assert.notEqual(
        statusAfterConnect(p), 'connected',
        `${p} 没有同步实现，却被标成 connected —— UI 会显示"已连接"而数据永远不会到达`,
      );
    }
  });

  test('有同步实现的 provider 才是 connected', async () => {
    const { statusAfterConnect, isSyncable } = await import('../src/lib/connectors/capabilities');
    assert.equal(isSyncable('square'), true);
    assert.equal(statusAfterConnect('square'), 'connected');
  });

  test('未登记的 provider 一律按不可同步处理（fail-closed）', async () => {
    const { isSyncable, isKnownProvider, statusAfterConnect } = await import('../src/lib/connectors/capabilities');
    for (const p of ['brand-new-thing', '', 'SQUARE', 'erpnext ']) {
      assert.equal(isSyncable(p), false, `${JSON.stringify(p)} 不应被当作可同步`);
      assert.notEqual(statusAfterConnect(p), 'connected');
    }
    assert.equal(isKnownProvider('square'), true);
    assert.equal(isKnownProvider('brand-new-thing'), false);
    // 大小写敏感：'SQUARE' 不是 'square'，因此按未知处理（宁可保守）
    assert.equal(isKnownProvider('SQUARE'), false);
  });

  test('capabilityNotice 只为不可同步的 provider 给出说明', async () => {
    const { capabilityNotice } = await import('../src/lib/connectors/capabilities');
    assert.equal(capabilityNotice('square'), null, '可同步的 provider 不需要"仅连通性"说明');
    const notice = capabilityNotice('erpnext');
    assert.ok(notice && notice.length > 0, '不可同步的 provider 必须给出说明');
    assert.match(String(notice), /sync is not implemented|not from this system|local data/i);
  });

  test('connectIntegration 用的是事实源，而不是硬编码 connected', () => {
    // 源码契约：这一条防的是"有人把 status: 'connected' 写回去"
    const src = read('src/app/api/integrations/route.ts');
    assert.match(
      src, /status:\s*statusAfterConnect\(/,
      '/api/integrations 又硬编码了 status —— 不可同步的 provider 会重新显示为已连接',
    );
    assert.doesNotMatch(
      src, /status:\s*'connected'/,
      "/api/integrations 又写回了 status: 'connected'（无条件声称已连接）",
    );
  });

  test('同步路由的可同步判定来自事实源，不再硬编码 square', () => {
    const src = read('src/app/api/integrations/[provider]/sync/route.ts');
    assert.match(
      src, /isSyncable\(provider\)/,
      '同步路由又用硬编码 provider 比较 —— 与徽章、状态写入会再次漂移',
    );
  });

  test('设置页不得仅凭 status 就声称已连接（须看 syncable）', () => {
    const src = read('src/app/[locale]/settings/page.tsx');
    assert.match(
      src, /syncable/,
      '设置页没有使用 syncable —— ERPNext 会重新显示为"已连接"并展示条目数与最近同步时间',
    );
    assert.doesNotMatch(
      src, /i\.provider === 'erpnext' && i\.status === 'connected'/,
      "设置页又只按 status === 'connected' 判断 ERPNext —— 那正是误导的来源",
    );
  });
});

function read(rel: string): string {
  // 延迟 require，避免在模块顶层引入 fs（与其它测试风格一致）
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(process.cwd(), rel), 'utf8');
}
