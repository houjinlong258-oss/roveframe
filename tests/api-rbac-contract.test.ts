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
  // Phase 16 任务 4：邮件退订是**公开**边界 —— 收件人没有本站会话，
  // 凭 32 字节随机令牌证明身份（令牌即能力，且只能退订它对应的那一个地址）。
  // 它不是"忘了加守卫"，而是"必须没有会话"：要求登录才能退订等于没有退订。
  'email/unsubscribe/route.ts': {
    reason: 'public unsubscribe boundary authenticated by a per-recipient random token',
    methods: ['POST'],
    verify: (source) => source.includes('findUnsubscribeByToken')
      && source.includes('recordUnsubscribe')
      && source.includes('invalid token'),
  },
  // Phase 17：官网预约。访客没有会话，是公开写入口。
  // verify 要求三件事同时出现，缺一不可：
  //   · 租户由 slug 服务端解析（resolvePublishedSiteBySlug）—— 客户端不得指定 tenant
  //   · 限流（checkFixedWindow）—— 公开写接口必须有
  //   · 落库状态固定为 pending —— 官网不能直接把桌子占掉
  'site/reservations/route.ts': {
    reason: 'public booking boundary; tenant resolved server-side from the site slug, rate limited, always pending',
    methods: ['POST'],
    verify: (source) => source.includes('resolvePublishedSiteBySlug')
      && source.includes('checkFixedWindow')
      && source.includes("status: 'pending'"),
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
  // Phase 18：顾客账号管理（改资料 / 改密码 / 注销）。
  // 顾客身份与商家身份**刻意隔离**，因此这四条不可能走中央守卫 ——
  // 它们登记的是"经过审阅的边界"，verify 断言 handler 内确实解析了顾客会话
  // 并显式拒绝（而不是忘了加守卫）。
  'customer/me/route.ts': {
    reason: 'public customer-account boundary; the account id comes only from the customer session cookie',
    methods: ['PATCH'],
    verify: (source) => source.includes('resolveCustomerSession(request)')
      && source.includes("jsonError('unauthorized', 401)"),
  },
  'customer/auth/change-password/route.ts': {
    reason: 'public customer password change; the current password is verified before the new hash is stored',
    methods: ['POST'],
    verify: (source) => source.includes('verifyPassword')
      && source.includes('hashPassword')
      && source.includes('resolveCustomerSession(request)'),
  },
  'customer/account/close/route.ts': {
    reason: 'public customer account closure; marks pending_deletion and revokes sessions, never a hard delete',
    methods: ['POST'],
    verify: (source) => source.includes('pending_deletion')
      && source.includes('resolveCustomerSession(request)'),
  },
  'customer/favorites/route.ts': {
    reason: 'public customer device-identity boundary',
    methods: ['POST', 'DELETE'],
    verify: (source) => source.includes('getDeviceIdFromRequest')
      && source.includes('device_id'),
  },
  // Phase 18：顾客账号边界。顾客是与商家**隔离的第二套身份**，不持有商家 JWT，
  // 因此不能走中央守卫（它认的是商家会话）。
  //
  // 这里 verify 强制要求两件事同时出现，缺一不可：
  //   · `resolveCustomerSession(request)` —— 身份只从顾客自己的 cookie 解析，
  //     不接受任何客户端传入的 account_id / tenant_id
  //   · `jsonError('unauthorized', 401)` —— 无会话时显式拒绝
  // 只写其中一条的实现会被拦下：前者保证"有校验"，后者保证"校验失败是拒绝"。
  'customer/addresses/route.ts': {
    reason: 'public customer-account boundary resolved from the customer session cookie',
    methods: ['POST', 'DELETE', 'PATCH'],
    verify: (source) => source.includes('resolveCustomerSession(request)')
      && source.includes("jsonError('unauthorized', 401)"),
  },
  'customer/auth/login/route.ts': {
    reason: 'public customer login boundary; no session exists yet',
    methods: ['POST'],
    verify: (source) => source.includes('verifyPassword')
      && source.includes('createCustomerSession')
      && source.includes('checkFixedWindow'),
  },
  'customer/auth/logout/route.ts': {
    reason: 'public idempotent customer session revocation',
    methods: ['POST'],
    verify: (source) => source.includes('revokeCustomerSession')
      && source.includes('clearCustomerSessionHeader'),
  },
  'customer/auth/register/route.ts': {
    reason: 'public customer self-registration; tenant resolved server-side from the site slug',
    methods: ['POST'],
    verify: (source) => source.includes('hashPassword')
      && source.includes('resolvePublishedSiteBySlug')
      && source.includes('createCustomerSession'),
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
  // Phase 18：外卖下单与堂食同属"公开 + 不透明 token"边界，但**多一层**：
  // 配送费与起送价必须由服务端按 settings.delivery 计算，因此 verify 额外要求
  // 出现 quoteDelivery / getDeliveryRules —— 只写 resolvePublicStore 是不够的，
  // 那会把"金额由客户端决定"的实现也放行。
  'store/delivery-orders/route.ts': {
    reason: 'public opaque-store-token boundary with server-side pricing, delivery rules and idempotency',
    methods: ['POST'],
    verify: (source) => source.includes('resolvePublicStore')
      && source.includes('isValidIdempotencyKey')
      && source.includes('quoteDelivery')
      && source.includes('getDeliveryRules'),
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
