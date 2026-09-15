import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/lib/crypto';
import { isValidIdempotencyKey } from '../src/lib/storefront';
import { verifyStripeSignature, toMinorUnits } from '../src/lib/payments/stripe';
import crypto from 'node:crypto';

describe('production safety boundaries', () => {
  test('encryption round-trips with an explicit deployment secret', () => {
    const previous = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = 'test-only-secret';
    try {
      const payload = encrypt('tenant credential');
      assert.equal(decrypt(payload), 'tenant credential');
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previous;
    }
  });

  test('production encryption refuses a missing secret', () => {
    const previousSecret = process.env.ENCRYPTION_SECRET;
    const previousServiceKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    const previousEnv = process.env.COZE_PROJECT_ENV;
    delete process.env.ENCRYPTION_SECRET;
    // 必须同时清掉 service_role_key：getKey() 在 ENCRYPTION_SECRET 缺失时会回落到它。
    // 原用例只删 ENCRYPTION_SECRET，在 service_role_key 存在时不会抛错 —— 它此前
    // 之所以是绿的，只是因为那个进程恰好没有加载 scripts/deploy.env。属于偶然通过。
    delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    process.env.COZE_PROJECT_ENV = 'PROD';
    try {
      assert.throws(() => encrypt('must not use a default key'), /ENCRYPTION_SECRET is required/);
    } finally {
      if (previousSecret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previousSecret;
      if (previousServiceKey === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
      else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
      if (previousEnv === undefined) delete process.env.COZE_PROJECT_ENV;
      else process.env.COZE_PROJECT_ENV = previousEnv;
    }
  });

  // 锁定「不得静默回落」这一契约，并记录已知有害但暂时保留的兼容行为
  // （技术债登记 P1-15：数据库超级凭据被复用为加密密钥，轮换即导致
  // 全部已落库凭据永久不可解密）。彻底修复需部署侧先提供 ENCRYPTION_SECRET。
  test('missing ENCRYPTION_SECRET falls back to the service key and warns', () => {
    const previousSecret = process.env.ENCRYPTION_SECRET;
    const previousServiceKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ENCRYPTION_SECRET;
    process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-as-encryption-key';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const payload = encrypt('tenant credential');

      // 1) 功能仍然可用（非破坏性改动）
      assert.equal(decrypt(payload), 'tenant credential');

      // 2) 密钥确实派生自 service_role_key，而不是开发默认值
      const expectedKey = crypto
        .createHash('sha256')
        .update('service-role-key-as-encryption-key')
        .digest();
      const [ivB64, tagB64, dataB64] = payload.split('.');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        expectedKey,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      assert.equal(plain, 'tenant credential');

      // 3) 必须打印告警 —— 静默回落是不可接受的
      assert.ok(
        warnings.some((line) => line.includes('COZE_SUPABASE_SERVICE_ROLE_KEY')),
        '回落到数据库超级凭据时必须打印告警',
      );
    } finally {
      console.warn = originalWarn;
      if (previousSecret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previousSecret;
      if (previousServiceKey === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
      else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
    }
  });

  test('idempotency keys are bounded and header-safe', () => {
    assert.equal(isValidIdempotencyKey('order-2026-09-04-001'), true);
    assert.equal(isValidIdempotencyKey('short'), false);
    assert.equal(isValidIdempotencyKey('order key with spaces'), false);
    assert.equal(isValidIdempotencyKey('x'.repeat(129)), false);
  });

  test('Stripe webhook signatures require a fresh, matching timestamped HMAC', () => {
    const now = 1_757_000_000;
    const body = '{"id":"evt_1"}';
    const secret = 'whsec_test';
    const digest = crypto.createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    assert.equal(verifyStripeSignature(body, `t=${now},v1=${digest}`, secret, 300, now), true);
    assert.equal(verifyStripeSignature(body, `t=${now - 301},v1=${digest}`, secret, 300, now), false);
    assert.equal(verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)}`, secret, 300, now), false);
  });

  test('Stripe amounts are converted to bounded minor units', () => {
    assert.equal(toMinorUnits(12.34), 1234);
    assert.equal(toMinorUnits(1234, 'JPY'), 1234);
    assert.equal(toMinorUnits(12.345, 'KWD'), 12345);
    assert.throws(() => toMinorUnits(0), /greater than zero/);
  });
});
