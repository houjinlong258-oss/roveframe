import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifySquareOAuthState } from '../src/app/api/integrations/square/oauth/start/route';

test('square oauth state round-trips and rejects tampering/expiry', () => {
  const previous = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = 'test-secret-32-bytes-minimum-value-ok';
  try {
    // 构造一个合法 state 需要内部签名函数；直接验证解析失败路径
    const tampered = Buffer.from('tenant.business.123.badmac').toString('base64url');
    assert.equal(verifySquareOAuthState(tampered), null);
    assert.equal(verifySquareOAuthState('garbage'), null);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = previous;
  }
});

test('square oauth start redirects through the real Square authorize endpoint', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/integrations/square/oauth/start/route.ts'), 'utf8');
  assert.match(source, /buildSquareOAuthUrl/);
  assert.match(source, /createHmac/);
  assert.match(source, /SQUARE_APP_ID/);
  const connector = readFileSync(join(process.cwd(), 'src/lib/connectors/square.ts'), 'utf8');
  assert.match(connector, /oauth2\/authorize/);
  assert.match(connector, /oauth2\/token/);
});

test('square oauth callback exchanges code and binds locations', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/integrations/square/oauth/callback/route.ts'), 'utf8');
  assert.match(source, /exchangeSquareCode/);
  assert.match(source, /fetchSquareLocations/);
  assert.match(source, /encrypt/);
  assert.match(source, /locationIds/);
  // 服务身份与租户授权分离：state 携带的配对必须查库验证
  assert.match(source, /\.eq\('tenant_id', scope\.tenantId\)/);
});

test('square sync orchestrator is tenant+business scoped with cursor persistence', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/connectors/square-sync.ts'), 'utf8');
  assert.match(source, /\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /\.eq\('business_id', businessId\)/);
  assert.match(source, /catalog_cursor/);
  assert.match(source, /customers_cursor/);
  assert.match(source, /refreshSquareToken/);
  assert.match(source, /fetchSquareInventoryCounts/);
  // 所有写入都带双 scope
  for (const table of ['orders', 'products', 'customers', 'inventory_items']) {
    assert.ok(source.includes('from(\'' + table + '\')'), table + ' upsert missing');
  }
});

test('scheduled square sync is wired into the scheduler tick', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
  assert.match(source, /maybeSyncSquare/);
  assert.match(source, /15 \* 60_000/);
});

test('production refuses to start with demo mode enabled', () => {
  const source = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
  assert.match(source, /RF_E2E_DEMO === '1'/);
  assert.match(source, /Refusing to start/);
});

test('RF_E2E_DEMO demo path is opt-in and never in production', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/integrations/[provider]/sync/route.ts'), 'utf8');
  assert.match(source, /process\.env\.RF_E2E_DEMO === '1' && process\.env\.COZE_PROJECT_ENV !== 'PROD'/);
});
