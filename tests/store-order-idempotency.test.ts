import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { orderContentFingerprint } from '../src/app/api/store/orders/route';

/**
 * Phase 16 任务 5 —— 订单幂等指纹。
 *
 * ## 被这批测试钉住的真实缺陷
 *
 * 第一次实现用 `item.name` 拼指纹，而**请求里的 items 只有 `{product_id, qty}`**
 * （名字要查商品表才有）。于是请求侧拼出 `?x2`，库里是 `Phase16 Test Dishx2`，
 * 永不相等 ⇒ **同一个 key 的合法重试被判成 409 冲突**。
 *
 * 实测证据（`scripts/_verify_phase16_core.mts`）：第二次同内容请求返回
 * `HTTP 409`，而 `external_id` 的库内计数是 1 —— 也就是说顾客**再也下不了这一单**。
 * 这比"重复下单"更糟，所以必须有可失败的测试守住它。
 *
 * ## 现在的不变量
 *
 *   - 指纹只用请求里**真实存在**的字段（product_id / qty / subtotal / tip / table）；
 *   - 顺序无关（同一份内容换顺序必须同指纹）；
 *   - 换菜、改数量、改小计、改桌号、改小费都必须变指纹；
 *   - 指纹在**解析商品之后**计算并随订单落库，比较是一次字符串相等。
 */

const base = {
  items: [
    { product_id: 'prod-a', qty: 2 },
    { product_id: 'prod-b', qty: 1 },
  ],
  subtotal: 37.5,
  tipAmount: 0,
  tableNo: 'A1' as string | null,
};

describe('orderContentFingerprint — 内容相同必须同指纹', () => {
  test('同一份内容重复计算得到同一个值（幂等重试的前提）', () => {
    assert.equal(orderContentFingerprint({ ...base }), orderContentFingerprint({ ...base }));
  });

  test('items 顺序不同不影响指纹（顾客点击顺序不该改变身份）', () => {
    const reordered = { ...base, items: [...base.items].reverse() };
    assert.equal(orderContentFingerprint(reordered), orderContentFingerprint(base));
  });

  test('指纹只由请求里真实存在的字段决定（不含商品名）', () => {
    // 这一条直接对应那个缺陷：如果实现又用了 name，两份 items 都没有 name 时
    // 会拼出同样的占位符，而"换了菜"就检测不出来 —— 下面 swap 用例会变红。
    const withNames = {
      ...base,
      items: base.items.map((item) => ({ ...item, name: 'unused' })),
    };
    assert.equal(orderContentFingerprint(withNames), orderContentFingerprint(base));
  });
});

describe('orderContentFingerprint — 内容不同必须不同指纹（否则加单被静默吞掉）', () => {
  const cases: Array<[string, typeof base]> = [
    ['改数量', { ...base, items: [{ product_id: 'prod-a', qty: 3 }, { product_id: 'prod-b', qty: 1 }] }],
    ['换菜', { ...base, items: [{ product_id: 'prod-a', qty: 2 }, { product_id: 'prod-c', qty: 1 }] }],
    ['换桌', { ...base, tableNo: 'A2' }],
    ['加小费', { ...base, tipAmount: 5 }],
    ['小计变化（价格变动）', { ...base, subtotal: 40 }],
    ['无桌号', { ...base, tableNo: null }],
  ];

  for (const [label, variant] of cases) {
    test(`${label} ⇒ 指纹不同`, () => {
      assert.notEqual(
        orderContentFingerprint(variant),
        orderContentFingerprint(base),
        `${label} 必须改变指纹，否则那一单会被当成重试丢掉`,
      );
    });
  }
});

describe('接线契约：指纹必须落库并用于比较', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/app/api/store/orders/route.ts'), 'utf8');

  test('指纹写入订单行', () => {
    assert.match(src, /idempotency_fingerprint: requestFingerprint/);
  });

  test('比较用的是落库指纹，而不是从订单内容反推', () => {
    assert.match(src, /idempotency_fingerprint\?: string \| null/);
    // 反推函数不应再存在（它必然会拼错）
    assert.doesNotMatch(src, /function storedOrderFingerprint/);
  });

  test('指纹在解析商品之后计算（解析前 product_id 未经核验）', () => {
    const productQuery = src.indexOf(".from('products').select(");
    const fingerprint = src.indexOf('const requestFingerprint = orderContentFingerprint(');
    assert.ok(productQuery > 0 && fingerprint > 0);
    assert.ok(
      fingerprint > productQuery,
      '指纹必须在商品解析之后计算：解析前无法确认商品属于本商户、也无法算小计',
    );
  });

  test('并发竞态路径（23505）同样比对指纹', () => {
    assert.match(src, /raceError/);
    assert.match(src, /racedFingerprint/);
  });

  test('迁移里有这一列（否则写入会整单失败）', () => {
    const sql = readFileSync(path.join(process.cwd(), 'scripts/migrate-email-compliance.sql'), 'utf8');
    assert.match(sql, /add column if not exists idempotency_fingerprint/i);
  });
});
