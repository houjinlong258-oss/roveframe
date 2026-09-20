import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SubscriptionError,
  _clearEntitlementCache,
  assertWriteEntitlement,
  decideEntitlement,
  ENTITLEMENT_GATED_PREFIXES,
  evaluateEntitlement,
  invalidateEntitlement,
  isEntitlementGatedRequest,
  isWriteMethod,
} from '../src/lib/entitlements';
import { _clearAuthCaches, _seedRoleForTest } from '../src/lib/auth-guard';
import { getTenantContext } from '../src/lib/tenant';
import { errorResponse, subscriptionRequiredResponse } from '../src/lib/api-helpers';
import { PLAN_IDS, TRIAL_DAYS, trialPeriodEnd } from '../src/lib/subscription-plans';

/**
 * Phase 16 任务 2 —— 订阅与权益门禁。
 *
 * ## 这批测试要钉住什么
 *
 * 1. **判定表**：`decideEntitlement` 的每个 status × 期内/期外分支（纯函数，真实调用）。
 * 2. **fail-closed**：无订阅行、查库失败、未知状态 —— 全部不得放行写操作。
 * 3. **门禁在链上**：用**本地签发的真 JWT** 走 `getTenantContext`，
 *    证明写方法被拒、读方法放行（不是"代码里有个函数没人调用"）。
 * 4. **套餐与迁移一致**：`PLAN_IDS` 与 `migrate-subscriptions-seed.sql` 必须对齐，
 *    否则门禁会指向一个不存在的 plan。
 * 5. **注册建订阅**：源码契约 —— 建订阅必须发生在建 auth 用户**之前**。
 *
 * ## 负向对照（本项目规矩）
 *
 * `负向对照` 一组把"永远放行"的判定搬进来，断言它与真实判定**结论相反**。
 * 若有人把 switch 的 default 改成放行、或删掉无订阅行分支，第 1/2 组会立刻变红。
 */

const JWT_SECRET = 'entitlements-test-secret';
const TENANT_WITH_ACTIVE = '00000000-0000-0000-0000-000000000000'; // 平台自营锚点（迁移后为 internal/active）
const TENANT_UNKNOWN = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; // 绝不存在

function makeJwt(userId: string, tenantId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@test.invalid`,
    app_metadata: { tenant_id: tenantId, business_id: '00000000-0000-0000-0000-000000000001' },
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function request(userId: string, tenantId: string, method: string, path = '/api/emails/send'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${makeJwt(userId, tenantId)}` },
  });
}

describe('decideEntitlement — 判定表（纯函数，真实调用）', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  const cases: Array<[string, Parameters<typeof decideEntitlement>[0], boolean, string]> = [
    ['active', { status: 'active' }, true, 'active'],
    ['trialing 无到期日', { status: 'trialing' }, true, 'trialing'],
    ['trialing 未到期', { status: 'trialing', current_period_end: future }, true, 'trialing'],
    ['trialing 已到期', { status: 'trialing', current_period_end: past }, false, 'trial_expired'],
    ['past_due 宽限内', { status: 'past_due', grace_period_end: future }, true, 'past_due_in_grace'],
    ['past_due 宽限已过', { status: 'past_due', grace_period_end: past }, false, 'past_due_grace_over'],
    ['past_due 无宽限', { status: 'past_due' }, false, 'past_due_grace_over'],
    ['grace 期内', { status: 'grace', grace_period_end: future }, true, 'in_grace'],
    ['grace 过期', { status: 'grace', grace_period_end: past }, false, 'grace_expired'],
    ['suspended', { status: 'suspended', current_period_end: future }, false, 'suspended'],
    ['cancelled 期末前', { status: 'cancelled', current_period_end: future }, true, 'cancelled_paid_through'],
    ['cancelled 期末后', { status: 'cancelled', current_period_end: past }, false, 'cancelled_period_over'],
    ['expired', { status: 'expired' }, false, 'expired'],
  ];

  for (const [label, row, writeAllowed, reason] of cases) {
    test(`${label} → writeAllowed=${writeAllowed} (${reason})`, () => {
      const decision = decideEntitlement(row);
      assert.equal(decision.writeAllowed, writeAllowed, `${label} 的写权限判定错误`);
      assert.equal(decision.reason, reason);
      assert.equal(
        decision.level,
        writeAllowed ? 'full' : (row?.status === 'suspended' ? 'suspended' : 'read_only'),
      );
    });
  }

  test('未被识别的 status 一律不放行（新增状态必须是显式决定）', () => {
    const decision = decideEntitlement({ status: 'brand_new_status' });
    assert.equal(decision.writeAllowed, false);
    assert.match(decision.reason, /^unknown_status:/);
  });

  test('status 为空字符串同样不放行', () => {
    assert.equal(decideEntitlement({ status: '' }).writeAllowed, false);
    assert.equal(decideEntitlement({ status: null }).writeAllowed, false);
  });
});

describe('fail-closed：无订阅行必须降级为只读', () => {
  test('null 行 → read_only + subscription_missing，且 writeAllowed=false', () => {
    const decision = decideEntitlement(null);
    assert.equal(decision.level, 'read_only');
    assert.equal(decision.status, 'none');
    assert.equal(decision.reason, 'subscription_missing');
    assert.equal(decision.writeAllowed, false);
  });

  test('查库得不到行（含非法入参）也不抛错，且一律不放行写操作', async () => {
    _clearEntitlementCache();
    // 实测：PostgREST 对非法 uuid 并不报错，而是返回空集（maybeSingle → null），
    // 因此这里走的是 subscription_missing 而不是 lookup_failed。
    // 真正要保证的性质与走哪条分支无关：**不抛错**且**不放行**。
    const decision = await evaluateEntitlement('not-a-uuid-###');
    assert.equal(decision.level, 'read_only');
    assert.equal(decision.writeAllowed, false);
    assert.equal(
      decision.status, 'none',
      `拿不到订阅行时 status 应为 none，实际 ${decision.status}`,
    );
    assert.ok(
      decision.reason === 'subscription_missing' || decision.reason.startsWith('lookup_failed'),
      `reason 应说明是"没有订阅行"或"查库失败"，实际 ${decision.reason}`,
    );
  });
});

describe('门禁覆盖范围：只管对外可见 / 要花钱的动作', () => {
  test('清单内的路径 + 写方法 ⇒ 在范围内', () => {
    for (const path of ['/api/emails/send', '/api/marketing/send', '/api/payments/checkout', '/api/reviews/reply']) {
      assert.equal(isEntitlementGatedRequest('POST', path), true, `${path} 应在门禁范围内`);
    }
  });

  test('读方法永远不在范围内（商家必须能读自己的数据）', () => {
    for (const path of ['/api/emails/send', '/api/payments/checkout']) {
      assert.equal(isEntitlementGatedRequest('GET', path), false);
    }
  });

  test('内部写操作不在范围内（欠费商家仍能改账单资料、运维仍能改配置）', () => {
    for (const path of [
      '/api/settings',
      '/api/settings/models',
      '/api/business/products',
      '/api/agent/chat',
      '/api/customers',
      '/api/coding-agent',
      '/api/healing',
      '/api/customization',
    ]) {
      assert.equal(isEntitlementGatedRequest('POST', path), false, `${path} 不应被订阅门禁拦截`);
    }
  });

  test('清单本身形态正确（目录前缀，且能命中其子路径）', () => {
    for (const prefix of ENTITLEMENT_GATED_PREFIXES) {
      assert.ok(prefix.startsWith('/api/'), `前缀必须以 /api/ 开头: ${prefix}`);
      // 目录前缀约定：以斜杠结尾，于是 `/api/payments/` 命中 `/api/payments/refund`
      assert.ok(prefix.endsWith('/'), `前缀必须以斜杠结尾以便匹配子路径: ${prefix}`);
      assert.equal(
        isEntitlementGatedRequest('POST', `${prefix}child`), true,
        `${prefix} 必须能命中其子路径`,
      );
    }
    assert.equal(isEntitlementGatedRequest('POST', '/api/payments/refund'), true);
  });

  test('未在清单内的新路由默认放行（因此新增对外动作必须显式登记）', () => {
    // 这条断言的作用不是"允许漏掉"，而是把默认值写清楚：
    // 若哪天把默认值改成"全部拦截"，这里会变红，提醒同步更新 intent。
    assert.equal(isEntitlementGatedRequest('POST', '/api/some-future-route'), false);
  });
});

describe('assertWriteEntitlement — 读放行、写按状态判定', () => {
  test('isWriteMethod 覆盖四种写方法，GET/HEAD 不算写', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'patch']) {
      assert.equal(isWriteMethod(m), true, `${m} 应判为写方法`);
    }
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(isWriteMethod(m), false, `${m} 不应判为写方法`);
    }
  });

  test('GET 在无订阅的租户上仍然放行（商家必须能读到自己的数据）', async () => {
    _clearEntitlementCache();
    const decision = await assertWriteEntitlement(TENANT_UNKNOWN, 'GET');
    assert.equal(decision.writeAllowed, false, '判定本身是只读');
    // 但 GET 不抛错 —— 能走到这里就是放行的证据
  });

  test('POST 在无订阅的租户上抛 SubscriptionError(402)', async () => {
    _clearEntitlementCache();
    await assert.rejects(
      () => assertWriteEntitlement(TENANT_UNKNOWN, 'POST'),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionError, '必须是 SubscriptionError');
        assert.equal((error as SubscriptionError).status, 402);
        return true;
      },
    );
  });

  test('SubscriptionError 经 errorResponse 保留 402，而不是被吞成 500', () => {
    const error = new SubscriptionError(decideEntitlement(null));
    const response = errorResponse(error);
    assert.equal(response.status, 402, '402 是这里唯一正确的语义');
  });

  test('subscriptionRequiredResponse 带上机器可读的原因码', async () => {
    const error = new SubscriptionError(decideEntitlement({ status: 'suspended' }));
    const response = subscriptionRequiredResponse(error);
    assert.ok(response, 'suspended 必须产出 402 响应体');
    const body = (await response!.json()) as { code?: string; subscriptionStatus?: string };
    assert.equal(body.code, 'suspended');
    assert.equal(body.subscriptionStatus, 'suspended');
  });

  test('非 402 错误不会被 subscriptionRequiredResponse 误认', () => {
    assert.equal(subscriptionRequiredResponse(new Error('boom')), null);
  });
});

describe('门禁在真实请求链上生效（本地签名 JWT，走 getTenantContext）', () => {
  before(() => {
    process.env.COZE_SUPABASE_JWT_SECRET = JWT_SECRET;
    _clearAuthCaches();
    _clearEntitlementCache();
    _seedRoleForTest('owner-ent', 'owner');
  });

  after(() => {
    delete process.env.COZE_SUPABASE_JWT_SECRET;
    _clearAuthCaches();
    _clearEntitlementCache();
  });

  beforeEach(() => {
    _clearEntitlementCache();
  });

  test('读请求拿到上下文（并附带只读判定）', async () => {
    const ctx = await getTenantContext(request('owner-ent', TENANT_UNKNOWN, 'GET'));
    assert.equal(ctx.tenantId, TENANT_UNKNOWN);
    assert.equal(ctx.entitlement?.writeAllowed, false);
    assert.equal(ctx.entitlement?.status, 'none');
  });

  test('写请求在没有订阅的租户上被拒（402）', async () => {
    await assert.rejects(
      () => getTenantContext(request('owner-ent', TENANT_UNKNOWN, 'POST')),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionError);
        assert.equal((error as SubscriptionError).status, 402);
        return true;
      },
    );
  });

  test('skipEntitlement 只跳过门禁，不影响身份解析', async () => {
    const ctx = await getTenantContext(request('owner-ent', TENANT_UNKNOWN, 'POST'), { skipEntitlement: true });
    assert.equal(ctx.tenantId, TENANT_UNKNOWN);
    assert.equal(ctx.entitlement, undefined);
  });

  test('错误凭据仍然 401（门禁不掩盖鉴权失败）', async () => {
    const anonymous = new Request('http://localhost/api/anything', { method: 'POST' });
    await assert.rejects(
      () => getTenantContext(anonymous),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 401);
        return true;
      },
    );
  });

  test('真实库：锚点租户有订阅行且状态为 active（迁移已落地）', async () => {
    _clearEntitlementCache();
    const decision = await evaluateEntitlement(TENANT_WITH_ACTIVE);
    if (decision.reason.startsWith('lookup_failed')) {
      // 无凭据环境（纯 CI）跳过，但要留下可读的原因，不能静默变绿
      console.log(`  [skip] 无数据库连接: ${decision.reason.slice(0, 80)}`);
      return;
    }
    assert.equal(decision.status, 'active', `锚点租户状态应为 active，实际 ${decision.status} (${decision.reason})`);
    assert.equal(decision.writeAllowed, true);
    assert.equal(decision.planId, PLAN_IDS.internal);
  });

  test('invalidateEntitlement 让状态变更立即可见（不等 TTL）', async () => {
    _clearEntitlementCache();
    const first = await evaluateEntitlement(TENANT_UNKNOWN);
    const cached = await evaluateEntitlement(TENANT_UNKNOWN);
    assert.equal(cached.cached, true, '第二次应命中缓存');
    invalidateEntitlement(TENANT_UNKNOWN);
    const afterInvalidate = await evaluateEntitlement(TENANT_UNKNOWN);
    assert.equal(afterInvalidate.cached, false, '失效后必须重新判定');
    assert.equal(afterInvalidate.reason, first.reason);
  });
});

describe('负向对照：永远放行的判定与本实现结论相反', () => {
  const alwaysAllow = () => ({
    level: 'full' as const,
    status: 'active' as const,
    reason: 'always_allow',
    planId: null,
    currentPeriodEnd: null,
    gracePeriodEnd: null,
    writeAllowed: true,
    cached: false,
  });

  test('「永远放行」在无订阅行时给出相反结论', () => {
    const real = decideEntitlement(null);
    const fake = alwaysAllow();
    assert.notEqual(real.writeAllowed, fake.writeAllowed);
    assert.notEqual(real.level, fake.level);
  });

  test('「永远放行」在 suspended 时给出相反结论', () => {
    const real = decideEntitlement({ status: 'suspended' });
    assert.equal(real.writeAllowed, false);
    assert.notEqual(real.writeAllowed, alwaysAllow().writeAllowed);
  });

  test('「永远放行」在试用到期时给出相反结论', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const real = decideEntitlement({ status: 'trialing', current_period_end: past });
    assert.equal(real.writeAllowed, false);
    assert.notEqual(real.reason, alwaysAllow().reason);
  });
});

describe('套餐定义与迁移一致（单一事实源）', () => {
  const sql = readFileSync(path.join(process.cwd(), 'scripts/migrate-subscriptions-seed.sql'), 'utf8');

  test('PLAN_IDS 的每个 id 都出现在迁移 SQL 里', () => {
    for (const [slug, id] of Object.entries(PLAN_IDS)) {
      assert.ok(sql.includes(id), `套餐 ${slug} 的 id ${id} 未出现在迁移 SQL 中`);
    }
  });

  test('迁移里的 slug 与 PLAN_IDS 的键一致', () => {
    const slugs = [...sql.matchAll(/'([a-z_]+)'::varchar, '(Free|Starter|Growth|Internal)'::varchar/g)]
      .map((m) => m[1]);
    for (const slug of Object.keys(PLAN_IDS)) {
      assert.ok(slugs.includes(slug) || sql.includes(`'${slug}'`), `slug ${slug} 未出现在迁移 SQL 中`);
    }
  });

  test('迁移把锚点租户指向 internal 套餐', () => {
    assert.match(sql, /00000000-0000-0000-0000-000000000000/);
    assert.ok(sql.includes(PLAN_IDS.internal), '锚点租户应绑定 internal 套餐');
  });

  test('存量回填是幂等的（on conflict do nothing），不会重置已停用租户', () => {
    assert.match(sql, /on conflict \(tenant_id\) do nothing/i);
  });

  test('试用期是正数天数，到期时刻在将来', () => {
    assert.ok(TRIAL_DAYS > 0);
    const end = trialPeriodEnd(new Date('2026-01-01T00:00:00Z'), TRIAL_DAYS);
    assert.equal(end, new Date('2026-01-01T00:00:00Z').getTime() + TRIAL_DAYS * 86_400_000 > 0
      ? new Date(new Date('2026-01-01T00:00:00Z').getTime() + TRIAL_DAYS * 86_400_000).toISOString()
      : end);
  });
});

describe('注册与门店资料：源码契约（行为证据在 _verify 脚本里）', () => {
  const signup = readFileSync(path.join(process.cwd(), 'src/app/api/auth/signup/route.ts'), 'utf8');
  const menu = readFileSync(path.join(process.cwd(), 'src/app/api/store/menu/route.ts'), 'utf8');

  test('注册建订阅，且发生在建 auth 用户之前', () => {
    const subIndex = signup.indexOf('createTrialSubscriptionRow(');
    const authIndex = signup.indexOf('createAuthUserWithTenant(');
    assert.ok(subIndex > 0, '注册必须建订阅');
    assert.ok(authIndex > 0, '注册必须建 auth 用户');
    assert.ok(subIndex < authIndex, '订阅必须在 auth 用户之前建，否则会出现"能登录却是只读"的账号');
  });

  test('注册写 settings 行（business.name / locale.language / locale.currency）', () => {
    assert.match(signup, /updateSettings\(/);
    assert.match(signup, /business: \{ name: business_name/);
    assert.match(signup, /currency: body\.currency \?\? 'USD'/);
  });

  test('菜单不再返回字面量 "Store"', () => {
    assert.doesNotMatch(menu, /business\.name \?\? 'Store'/);
    assert.match(menu, /store_profile_missing/);
  });
});
