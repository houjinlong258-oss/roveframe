import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_MAX_LENGTH,
  hashFingerprint,
} from '../src/lib/fingerprint';
import { deliveryContentFingerprint } from '../src/lib/delivery';
import { orderContentFingerprint } from '../src/app/api/store/orders/route';

/**
 * 幂等指纹的长度与内容守卫（Phase 18）。
 *
 * ## 被守住的缺陷（实测复现过，阻断级）
 *
 * `orders.idempotency_fingerprint` 是 `varchar(128)`（scripts/migrate-email-compliance.sql:60）。
 * 指纹原先是拼出来的字符串：
 *
 *   外卖：`<商品uuid>x<qty>,…|<小计>|<配送费>|<地址>|<电话>`
 *   堂食：`<商品uuid>x<qty>,…|<小计>|<小费>|<桌号>`
 *
 * 一个商品 uuid 占 36 字符，加上 `x<qty>` 与逗号约 37。所以：
 *   · 外卖两件商品 + 一个正常的纽约地址 = **147 字符** → 插入抛 22001 →
 *     接口 **500 `value too long for type character varying(128)`**
 *   · 堂食 50 件商品（MAX_ORDER_ITEMS）≈ 1850 字符 → 同样超
 *
 * 也就是说：**两件商品的外卖单在真实地址下根本下不成功**。这不是边界情况，
 * 是常规下单路径。
 *
 * 另一个代价不属于宽度问题但同样真实：外卖指纹原文里**含顾客的地址与电话**，
 * 明文落进一个语义上不该有 PII 的列。
 *
 * ## 现在的契约
 *
 * 两条路径都返回 sha256 十六进制，恒为 64 字符，与商品数、地址长度无关，
 * 且不含原文。拼接规则未变，所以"同内容同指纹 / 不同内容不同指纹"仍然成立
 * （由 tests/delivery-backend.test.ts 与 tests/store-order-idempotency.test.ts 覆盖）。
 */

const UUID = '00000000-0000-0000-0000-000000000001';

describe('fingerprint length contract', () => {
  test('哈希恒为 64 字符十六进制，且不超列宽', () => {
    assert.equal(FINGERPRINT_LENGTH, 64);
    const out = hashFingerprint('anything');
    assert.equal(out.length, FINGERPRINT_LENGTH);
    assert.match(out, /^[0-9a-f]{64}$/);
    assert.ok(out.length <= FINGERPRINT_MAX_LENGTH);
  });

  test('外卖：两件商品 + 正常长地址（实测 147 字符的那一例）也不再超宽', () => {
    const out = deliveryContentFingerprint({
      items: [{ product_id: UUID, qty: 1 }, { product_id: `${UUID}x`, qty: 2 }],
      subtotal: 24.99,
      fee: 3,
      addressLine: '455 W 37th St, Apt 12F, New York, NY 10018',
      recipientPhone: '+1 212 555 0184',
    });
    assert.equal(out.length, FINGERPRINT_LENGTH);
    assert.ok(out.length <= FINGERPRINT_MAX_LENGTH, '修复后仍然超宽');
  });

  test('外卖：地址再长也不影响长度（长度与输入无关）', () => {
    const short = deliveryContentFingerprint({
      items: [{ product_id: UUID, qty: 1 }], subtotal: 1, fee: 0,
      addressLine: 'A', recipientPhone: '1',
    });
    const long = deliveryContentFingerprint({
      items: [{ product_id: UUID, qty: 1 }], subtotal: 1, fee: 0,
      addressLine: 'x'.repeat(200), recipientPhone: '1',
    });
    assert.equal(short.length, long.length);
    assert.notEqual(short, long, '内容变了指纹必须变');
  });

  test('堂食：50 件商品（MAX_ORDER_ITEMS 上限）也不再超宽', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      product_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      qty: 1,
    }));
    const out = orderContentFingerprint({ items, subtotal: 100, tipAmount: 0, tableNo: 'A1' });
    assert.equal(out.length, FINGERPRINT_LENGTH);
    assert.ok(out.length <= FINGERPRINT_MAX_LENGTH);
  });

  test('指纹里不含顾客地址与电话（PII 不进这一列）', () => {
    const address = '455 W 37th St, Apt 12F, New York, NY 10018';
    const phone = '+1 212 555 0184';
    const out = deliveryContentFingerprint({
      items: [{ product_id: UUID, qty: 1 }], subtotal: 24.99, fee: 3,
      addressLine: address, recipientPhone: phone,
    });
    assert.equal(out.includes(address), false, '地址出现在指纹里');
    assert.equal(out.includes(phone), false, '电话出现在指纹里');
    assert.equal(/[^0-9a-f]/.test(out), false, '指纹包含非十六进制字符，说明不是纯哈希');
  });

  // -------------------------------------------------------------------------
  // 负向对照：把实现换回"返回原文"，同一套断言必须失败。
  // 没有这一段，上面的"长度恒为 64"无法证明自己真的能失败。
  // -------------------------------------------------------------------------
  test('负向对照：拼原文的实现必须被判超宽', () => {
    const legacy = (items: { product_id: string; qty: number }[], address: string) =>
      `${items.map((i) => `${i.product_id}x${i.qty}`).sort().join(',')}|24.99|3.00|${address}|+1 212 555 0184`;
    const legacyOut = legacy(
      [{ product_id: UUID, qty: 1 }, { product_id: `${UUID}x`, qty: 2 }],
      '455 W 37th St, Apt 12F, New York, NY 10018',
    );
    assert.ok(
      legacyOut.length > FINGERPRINT_MAX_LENGTH,
      `负向对照失效：旧实现只有 ${legacyOut.length} 字符，没超宽，那这个缺陷就不存在`,
    );
    assert.notEqual(legacyOut.length, FINGERPRINT_LENGTH);
  });
});
