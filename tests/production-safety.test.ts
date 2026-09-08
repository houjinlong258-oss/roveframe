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
    const previousEnv = process.env.COZE_PROJECT_ENV;
    delete process.env.ENCRYPTION_SECRET;
    process.env.COZE_PROJECT_ENV = 'PROD';
    try {
      assert.throws(() => encrypt('must not use a default key'), /ENCRYPTION_SECRET is required/);
    } finally {
      if (previousSecret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previousSecret;
      if (previousEnv === undefined) delete process.env.COZE_PROJECT_ENV;
      else process.env.COZE_PROJECT_ENV = previousEnv;
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
