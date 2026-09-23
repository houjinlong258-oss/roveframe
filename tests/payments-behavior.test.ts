import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  currencyExponent,
  mapStripePaymentStatus,
  toMinorUnits,
  validateStripeRuntime,
  verifyStripeSignature,
} from '../src/lib/payments/stripe';
import { verifySquareSignature } from '../src/lib/connectors/square';
import { POST as checkoutPost } from '../src/app/api/payments/checkout/route';
import { POST as refundPost } from '../src/app/api/payments/refund/route';
import { POST as reconcilePost } from '../src/app/api/payments/reconcile/route';

/**
 * 支付路径的**行为**测试（Phase 19 非阻塞项 2）。
 *
 * ## 被修的是什么
 *
 * 独立审查实测：`/api/payments/{checkout,refund,reconcile}` 此前只被**读源码文本**的
 * 断言覆盖 —— 例如 `tests/rate-limit.test.ts` 断言路由文件里出现
 * `checkFixedWindow`，`tests/production-integrations.test.ts` 断言文件里出现某些函数名。
 * 那些断言在**调用点被注释掉**的实现上依然会通过：它们不执行任何一行产品代码。
 *
 * ## 本文件测什么（以及为什么测这些）
 *
 *   · 签名验证：伪造请求必须在**验签那一层**被拒（含正面对照 —— 一个恒返回 false
 *     的实现会通过所有"拒绝"用例，所以必须先有一条必须为 true 的用例）。
 *   · 金额换算：2/0/3 位小数币种都要对（日元没有小数位，写成两位就是 100 倍错账）。
 *   · 状态映射与运行时校验。
 *   · 三条路由**真的可以被调用**且中央守卫先于业务逻辑生效：无凭据 ⇒ 401。
 *
 * ## 刻意不测什么（如实说明）
 *
 * 不测"owner 才能退款"这类**需要真实订阅状态**的路径：`getTenantContext()` 在权限检查
 * **之前**会先做权益门禁（读 `tenant_subscriptions`），因此断言 403 会依赖演示租户
 * 当前是 active 还是 suspended —— 那是会随数据变化的脆弱断言，不是好测试。
 * 该路径的鉴权语义由 `api-rbac-contract.test.ts`（RBAC 矩阵）与
 * `subscription-entitlements.test.ts` 覆盖。这里用"无凭据 ⇒ 401"钉住
 * "守卫先于业务逻辑"，它不依赖任何数据状态。
 */

const WEBHOOK_SECRET = 'whsec_phase19_behaviour_test';

/** 生成一个**真实有效**的 Stripe 签名头（正面对照用）。 */
function stripeSignature(rawBody: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const SQUARE_URL = 'https://example.invalid/api/webhooks/square?tenant=t&business=b';
function squareSignature(rawBody: string, key = 'square-signature-key', url = SQUARE_URL): string {
  return createHmac('sha256', key).update(url + rawBody, 'utf8').digest('base64');
}

describe('支付：Stripe 签名验证', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  test('正面对照：正确签名必须通过（否则"拒绝"用例毫无意义）', () => {
    assert.equal(verifyStripeSignature(body, stripeSignature(body), WEBHOOK_SECRET), true);
  });

  test('篡改 body 必须被拒', () => {
    const sig = stripeSignature(body);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', extra: 'x' });
    assert.equal(verifyStripeSignature(tampered, sig, WEBHOOK_SECRET), false);
  });

  test('错误的 webhook secret 必须被拒', () => {
    assert.equal(verifyStripeSignature(body, stripeSignature(body, 'whsec_wrong'), WEBHOOK_SECRET), false);
  });

  test('过期时间戳必须被拒（重放窗口）', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(verifyStripeSignature(body, stripeSignature(body, WEBHOOK_SECRET, old), WEBHOOK_SECRET), false);
  });

  test('缺失/畸形签名头必须被拒', () => {
    for (const header of ['', 'v1=deadbeef', 't=abc,v1=deadbeef', 't=12345', 'garbage']) {
      assert.equal(
        verifyStripeSignature(body, header, WEBHOOK_SECRET), false,
        `签名头 ${JSON.stringify(header)} 不应被接受`,
      );
    }
  });

  test('长度不同的签名必须被拒（不能只比前缀）', () => {
    const sig = stripeSignature(body);
    assert.equal(verifyStripeSignature(body, sig.slice(0, sig.length - 4), WEBHOOK_SECRET), false);
  });
});

describe('支付：Square 签名验证', () => {
  const body = JSON.stringify({ event_id: 'e1', type: 'order.created' });

  test('正面对照：正确签名必须通过', () => {
    assert.equal(verifySquareSignature(body, squareSignature(body), 'square-signature-key', SQUARE_URL), true);
  });

  test('篡改 body 必须被拒', () => {
    assert.equal(verifySquareSignature(body + ' ', squareSignature(body), 'square-signature-key', SQUARE_URL), false);
  });

  test('通知 URL 不匹配必须被拒（签名覆盖 URL）', () => {
    assert.equal(
      verifySquareSignature(body, squareSignature(body), 'square-signature-key', 'https://example.invalid/other'),
      false,
    );
  });
});

describe('支付：金额换算（写错就是 100 倍错账）', () => {
  test('两位小数币种', () => {
    assert.equal(currencyExponent('USD'), 2);
    assert.equal(currencyExponent('usd'), 2);
    assert.equal(toMinorUnits(38, 'USD'), 3800);
    assert.equal(toMinorUnits(0.01, 'USD'), 1);
  });

  test('零位小数币种（日元没有分）', () => {
    assert.equal(currencyExponent('JPY'), 0);
    assert.equal(toMinorUnits(1000, 'JPY'), 1000, '1000 日元就是 1000 个最小单位，不是 100000');
  });

  test('三位小数币种', () => {
    assert.equal(currencyExponent('BHD'), 3);
    assert.equal(toMinorUnits(1, 'BHD'), 1000);
  });

  test('非法金额必须抛错（fail-closed，不得静默变成 0）', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => toMinorUnits(bad, 'USD'), /amount must be greater than zero/,
        `金额 ${bad} 应当被拒绝`);
    }
    assert.throws(() => toMinorUnits(1e9, 'USD'), /out of range/);
  });
});

describe('支付：状态映射与运行时校验', () => {
  test('Stripe 状态映射', () => {
    assert.equal(mapStripePaymentStatus('succeeded'), 'paid');
    assert.equal(mapStripePaymentStatus('canceled'), 'cancelled');
    assert.equal(mapStripePaymentStatus('requires_payment_method'), 'failed');
    assert.equal(mapStripePaymentStatus('processing'), 'processing');
  });

  test('密钥格式校验（正反两面）', () => {
    assert.doesNotThrow(() => validateStripeRuntime('sk_test_abc123', 'https://app.example.com'));
    assert.throws(() => validateStripeRuntime('pk_live_abc123', 'https://app.example.com'),
      /secret key format is invalid/);
    assert.throws(() => validateStripeRuntime('', 'https://app.example.com'));
  });
});

describe('支付：三条路由可被调用，且中央守卫先于业务逻辑', () => {
  /**
   * 这一节回答独立审查的具体指控："支付路由只有源码文本断言，没有行为测试"。
   * 无凭据时，`protectBusinessMutation` 必须在触达任何业务逻辑（更不用说数据库写入）
   * 之前返回 401 —— 这条断言不依赖任何数据状态，因此不会随演示数据变化而变红。
   */
  const cases: [string, (r: Request) => Promise<Response>][] = [
    ['checkout', checkoutPost as unknown as (r: Request) => Promise<Response>],
    ['refund', refundPost as unknown as (r: Request) => Promise<Response>],
    ['reconcile', reconcilePost as unknown as (r: Request) => Promise<Response>],
  ];

  for (const [name, handler] of cases) {
    test(`${name}：无凭据必须 401（不是 200/500）`, async () => {
      const res = await handler(new Request(`http://localhost/api/payments/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 1, currency: 'USD', payment_id: 'x' }),
      }));
      assert.equal(res.status, 401, `${name} 无凭据时应当 401，实际 ${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert.ok(body.error, '401 必须带错误说明');
    });
  }

  test('负向对照：同一处理器在凭据格式畸形时同样被拒（不是因为"没解析 body"而 401）', async () => {
    const res = await refundPost(new Request('http://localhost/api/payments/refund', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
      body: JSON.stringify({ payment_id: 'x', amount_minor: 100 }),
    }));
    assert.equal(res.status, 401, '格式错误的凭据也必须 401');
  });
});
