import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { _setAuditSinkForTest, type AuditEntry } from '../src/lib/audit';
import { _clearAuthCaches, _seedRoleForTest } from '../src/lib/auth-guard';
import { runBusinessMutation } from '../src/lib/mutation-guard';
import { hasPermission } from '../src/lib/rbac';

type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ExceptionRule = {
  reason: string;
  methods: readonly MutationMethod[];
  verify: (source: string) => boolean;
};

const ROOT = path.resolve(process.cwd(), 'src/app/api');
const JWT_SECRET = 'rbac-contract-test-secret';
const TENANT_ID = 'tenant-rbac-contract';
const BUSINESS_ID = 'business-rbac-contract';

const EXCEPTIONS: Readonly<Record<string, ExceptionRule>> = {
  'admin/audit-logs/route.ts': {
    reason: 'append-only endpoint explicitly rejects every write method',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    verify: (source) => source.includes('export const POST = methodNotAllowed')
      && source.includes("status: 405"),
  },
  'admin/auth/route.ts': {
    reason: 'separate platform-admin login/logout session boundary',
    methods: ['POST', 'DELETE'],
    verify: (source) => source.includes('loginPlatformAdmin')
      && source.includes('logoutPlatformAdmin')
      && source.includes('writePlatformAudit'),
  },
  'admin/subscriptions/route.ts': {
    reason: 'separate platform-admin RBAC and audit boundary',
    methods: ['POST'],
    verify: (source) => source.includes('adminHandler(request'),
  },
  'admin/support-access/route.ts': {
    reason: 'separate platform-admin RBAC and audit boundary',
    methods: ['POST'],
    verify: (source) => source.includes('adminHandler(request'),
  },
  'admin/tenants/[id]/route.ts': {
    reason: 'separate platform-admin RBAC and audit boundary',
    methods: ['PATCH'],
    verify: (source) => source.includes('adminHandler(request'),
  },
  'admin/tenants/route.ts': {
    reason: 'separate platform-admin RBAC and audit boundary',
    methods: ['POST'],
    verify: (source) => source.includes('adminHandler(request'),
  },
  'agent/approvals/events/route.ts': {
    reason: 'RoveAgent service authentication with exact business-scope verification',
    methods: ['POST'],
    verify: (source) => source.includes('timingSafeEqual')
      && source.includes("body.business_id")
      && source.includes(".eq('tenant_id', tenantId)")
      && source.includes(".eq('id', businessId)"),
  },
  'auth/login/route.ts': {
    reason: 'public merchant authentication boundary',
    methods: ['POST'],
    verify: (source) => source.includes('signInAndGetToken'),
  },
  'auth/logout/route.ts': {
    reason: 'public idempotent session-cookie removal',
    methods: ['POST'],
    verify: (source) => source.includes('clearSessionCookieHeader'),
  },
  'auth/signup/route.ts': {
    reason: 'public tenant bootstrap transaction',
    methods: ['POST'],
    verify: (source) => source.includes('createAuthUserWithTenant')
      && source.includes('createBusinessRow'),
  },
  'customer/favorites/route.ts': {
    reason: 'public customer device-identity boundary',
    methods: ['POST', 'DELETE'],
    verify: (source) => source.includes('getDeviceIdFromRequest')
      && source.includes('device_id'),
  },
  'internal/agent/business-data/route.ts': {
    reason: 'RoveAgent service authentication and mandatory tenant/business adapter scope',
    methods: ['POST'],
    verify: (source) => source.includes('timingSafeEqual')
      && source.includes('assertBusinessScope(tenantId, businessId)'),
  },
  'onboarding/parse/route.ts': {
    reason: 'public bounded parser with no persistence or external side effect',
    methods: ['POST'],
    verify: (source) => !source.includes('getSupabaseClient')
      && source.includes('MAX_ONBOARDING_INPUT'),
  },
  'store/orders/route.ts': {
    reason: 'public opaque-store-token boundary with server-side pricing and idempotency',
    methods: ['POST', 'PATCH'],
    verify: (source) => source.includes('resolvePublicStore')
      && source.includes('isValidIdempotencyKey'),
  },
  'webhooks/[provider]/route.ts': {
    reason: 'provider-signed webhook boundary with replay/idempotency controls',
    methods: ['POST'],
    verify: (source) => source.includes('verifySquareSignature')
      && source.includes('verifyStripeSignature')
      && source.includes("eventReceipt.error?.code === '23505'")
      && source.includes("receipt.error?.code === '23505'"),
  },
};

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(absolute);
    return entry.name === 'route.ts' ? [absolute] : [];
  });
}

function exportedMutations(source: string): MutationMethod[] {
  return Array.from(
    source.matchAll(/export (?:async function|const) (POST|PUT|PATCH|DELETE)\b/g),
    (match) => match[1] as MutationMethod,
  );
}

function isCentrallyProtected(source: string, method: MutationMethod): boolean {
  const pattern = new RegExp(
    `export const ${method} = protect(?:Business|Tenant)Mutation\\(\\s*\\{\\s*permission:\\s*'[^']+'`,
  );
  return pattern.test(source);
}

function makeJwt(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@test.invalid`,
    app_metadata: { tenant_id: TENANT_ID, business_id: BUSINESS_ID },
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function authenticatedRequest(userId: string, body: unknown): Request {
  return new Request('http://localhost/api/contract', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${makeJwt(userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('API mutation RBAC contract', () => {
  test('every exported write method uses the central guard or an exact verified boundary exception', () => {
    const uncovered: string[] = [];
    let mutationCount = 0;

    for (const absolute of routeFiles(ROOT)) {
      const source = readFileSync(absolute, 'utf8');
      const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
      for (const method of exportedMutations(source)) {
        mutationCount += 1;
        if (isCentrallyProtected(source, method)) continue;
        const exception = EXCEPTIONS[relative];
        if (!exception || !exception.methods.includes(method) || !exception.verify(source)) {
          uncovered.push(`${method} /api/${relative.replace(/\/route\.ts$/, '')}`);
        }
      }
    }

    assert.ok(mutationCount >= 70, `route inventory unexpectedly shrank to ${mutationCount}`);
    assert.deepEqual(uncovered, []);
  });

  test('staff permission matrix blocks every explicitly prohibited sensitive action', () => {
    const prohibited = [
      ['modify product price', 'products:write'],
      ['modify product cost', 'products:write'],
      ['modify integration secret', 'integrations:write'],
      ['delete staff', 'staff:delete'],
      ['modify user role', 'users:write'],
      ['modify payment configuration', 'payments:write'],
    ] as const;

    for (const [label, permission] of prohibited) {
      assert.equal(hasPermission('staff', permission), false, label);
      assert.equal(hasPermission('owner', permission), true, label);
    }
  });
});

describe('central mutation boundary behavior', () => {
  let audits: AuditEntry[] = [];

  beforeEach(() => {
    process.env.COZE_SUPABASE_JWT_SECRET = JWT_SECRET;
    _clearAuthCaches();
    _seedRoleForTest('staff-rbac', 'staff');
    _seedRoleForTest('owner-rbac', 'owner');
    audits = [];
    _setAuditSinkForTest((entry) => audits.push(entry));
  });

  after(() => {
    delete process.env.COZE_SUPABASE_JWT_SECRET;
    _setAuditSinkForTest(null);
    _clearAuthCaches();
  });

  test('permission denial occurs before handler execution and records only redacted scope metadata', async () => {
    let executions = 0;
    const response = await runBusinessMutation(
      authenticatedRequest('staff-rbac', { apiKey: 'must-never-enter-audit' }),
      { permission: 'integrations:write', action: 'integration.secret.update', entity: 'integration_configs' },
      async () => {
        executions += 1;
        return Response.json({ ok: true });
      },
    );

    assert.equal(response.status, 403);
    assert.equal(executions, 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'integration.secret.update.denied');
    assert.equal((audits[0]?.after as Record<string, unknown>).business_id, BUSINESS_ID);
    assert.doesNotMatch(JSON.stringify(audits), /must-never-enter-audit/);
  });

  test('required audit failure fails closed before an authorized handler can execute', async () => {
    let executions = 0;
    _setAuditSinkForTest(() => {
      throw new Error('audit unavailable');
    });

    const response = await runBusinessMutation(
      authenticatedRequest('owner-rbac', {}),
      { permission: 'settings:write', action: 'settings.update', entity: 'settings' },
      async () => {
        executions += 1;
        return Response.json({ ok: true });
      },
    );

    assert.equal(response.status, 503);
    assert.equal(executions, 0);
  });

  test('authorized mutation records durable intent before one execution and a final outcome', async () => {
    let executions = 0;
    const response = await runBusinessMutation(
      authenticatedRequest('owner-rbac', {}),
      { permission: 'products:write', action: 'products.update', entity: 'products' },
      async (context) => {
        executions += 1;
        assert.equal(context.tenantId, TENANT_ID);
        assert.equal(context.businessId, BUSINESS_ID);
        return Response.json({ ok: true });
      },
    );

    assert.equal(response.status, 200);
    assert.equal(executions, 1);
    assert.deepEqual(audits.map((entry) => entry.action), [
      'products.update.started',
      'products.update.succeeded',
    ]);
  });
});
