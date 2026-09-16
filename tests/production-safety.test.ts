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

  test('production encryption refuses a missing secret even when the service key is present', () => {
    const previousSecret = process.env.ENCRYPTION_SECRET;
    const previousServiceKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    const previousEnv = process.env.COZE_PROJECT_ENV;
    delete process.env.ENCRYPTION_SECRET;
    // Phase 12 / R-03: the service key must NOT rescue a missing secret. Before
    // the fix this test had to delete the service key too, because its presence
    // silently supplied the encryption key — meaning the production guard could
    // never actually fire in a real deployment, where that key always exists.
    process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'present-but-must-not-be-used';
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

  // Phase 12 / R-03：旧契约（「缺 ENCRYPTION_SECRET 时回落到 service_role_key 并告警」）
  // 已被删除。该回落把数据库超级凭据复用为加密密钥，轮换即导致全部已落库凭据
  // 永久不可解密 —— 从"已知有害但保留"升级为"不再存在"。
  // 下面三个用例锁定替代它的契约。
  test('the service key is never used as an encryption key', () => {
    const previousSecret = process.env.ENCRYPTION_SECRET;
    const previousServiceKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    try {
      process.env.ENCRYPTION_SECRET = 'dedicated-encryption-secret';
      process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-that-must-be-ignored';

      const payload = encrypt('tenant credential');
      assert.equal(decrypt(payload), 'tenant credential');

      // 用 service_role_key 派生的密钥必须**解不开**它。
      // 这是整个 R-03 修复的核心保证，且与环境（prod/dev）无关，
      // 因此不需要操纵 NODE_ENV（它是只读属性，直接赋值过不了 ts-check）。
      const forbiddenKey = crypto
        .createHash('sha256')
        .update('service-role-key-that-must-be-ignored')
        .digest();
      const [ivB64, tagB64, dataB64] = payload.split('.');
      assert.throws(() => {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          forbiddenKey,
          Buffer.from(ivB64, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
      }, 'service_role_key 不得能解开任何密文');
    } finally {
      if (previousSecret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previousSecret;
      if (previousServiceKey === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
      else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
    }
  });

  test('ENCRYPTION_SECRET_PREVIOUS decrypts old ciphertext but never encrypts', () => {
    const saved = {
      secret: process.env.ENCRYPTION_SECRET,
      previous: process.env.ENCRYPTION_SECRET_PREVIOUS,
      env: process.env.COZE_PROJECT_ENV,
    };
    try {
      // 1) 用「旧密钥」写一条密文（模拟历史数据）
      process.env.ENCRYPTION_SECRET = 'old-rotated-secret';
      delete process.env.ENCRYPTION_SECRET_PREVIOUS;
      const legacy = encrypt('legacy credential');

      // 2) 轮换：新密钥生效，旧密钥降级为只读
      process.env.ENCRYPTION_SECRET = 'new-dedicated-secret';
      process.env.ENCRYPTION_SECRET_PREVIOUS = 'old-rotated-secret';

      // 历史数据仍可读 —— 轮换不再是破坏性操作
      assert.equal(decrypt(legacy), 'legacy credential');

      // 新写入必须用新密钥：拿旧密钥解不开
      const fresh = encrypt('fresh credential');
      delete process.env.ENCRYPTION_SECRET_PREVIOUS;
      assert.equal(decrypt(fresh), 'fresh credential');

      process.env.ENCRYPTION_SECRET = 'old-rotated-secret';
      delete process.env.ENCRYPTION_SECRET_PREVIOUS;
      assert.throws(() => decrypt(fresh), '新密文不得能用旧密钥解开');
    } finally {
      if (saved.secret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = saved.secret;
      if (saved.previous === undefined) delete process.env.ENCRYPTION_SECRET_PREVIOUS;
      else process.env.ENCRYPTION_SECRET_PREVIOUS = saved.previous;
      if (saved.env === undefined) delete process.env.COZE_PROJECT_ENV;
      else process.env.COZE_PROJECT_ENV = saved.env;
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
