/**
 * 一次性验收脚本：用应用自身 src/lib/payments/stripe.ts 代码路径创建 Stripe 测试 Checkout Session。
 * 用法: STRIPE_TEST_SECRET_KEY=sk_test_... pnpm tsx scripts/test-stripe-checkout.ts
 * 密钥只经环境变量传入，不落盘。test mode 下创建的是测试对象，不产生真实扣款。
 */
import { createStripeCheckoutSession } from '@/lib/payments/stripe';

async function main() {
  const secretKey = process.env.STRIPE_TEST_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_TEST_SECRET_KEY not set');
    process.exit(1);
  }
  const session = await createStripeCheckoutSession({
    secretKey,
    amount: 1.0,
    currency: 'USD',
    description: 'RoveFrame acceptance test (do not pay)',
    successUrl: 'http://localhost:5000/payments/success',
    cancelUrl: 'http://localhost:5000/payments/cancelled',
    metadata: { tenant_id: '00000000-0000-0000-0000-000000000000', purpose: 'acceptance-test' },
    idempotencyKey: 'acceptance-test-checkout-v1',
  });
  console.log(JSON.stringify({ ok: true, session_id: session.id, has_url: Boolean(session.url) }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(2);
});
