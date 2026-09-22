import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { POST as closeAccount } from '../src/app/api/customer/account/close/route';
import { changeCustomerPassword, type PasswordChangeDeps } from '../src/app/api/customer/auth/change-password/route';
import { hashPassword, type CustomerSessionContext } from '../src/lib/customer-auth';

/**
 * 顾客账号体系的行为测试（Phase 18 补齐）。
 *
 * ## 为什么这个文件必须存在
 *
 * 交接文档把 `tests/customer-account.test.ts` 列为该代理**应当产出但缺失**的文件；
 * 而 `change-password/route.ts` 的文件头（第 31 行）**点名**了这个文件：
 *
 *   > 本模块不 import 那个常量，是因为登录路由不导出它 —— 改动其中一处必须顺手
 *   > 改另一处，这条注释就是那个义务的落点（tests/customer-account.test.ts 断言的
 *   > 正是这一点）。
 *
 * 也就是说：路由作者已经为此留好了**测试缝**（`PasswordChangeDeps`），
 * 只是测试没写。缺了它，那两个"只能靠正则读源码"的约定就没有真正的守卫。
 *
 * ## 这批测试为什么是行为测试而不是源码断言
 *
 * `change-password` 把三件副作用（读凭据 / 写摘要 / 撤销会话）做成可注入参数，
 * 因此可以**真实调用处理函数**并断言它到底返回了什么、按什么顺序做了什么 ——
 * 正则读不出"这个分支返回了哪个响应体"。
 *
 * 注销路由没有接缝（它只做一次校验 + 一次库写），因此它的**鉴权前**分支
 * （未认证、非法 JSON、缺 confirm）用真实 handler 调用覆盖；
 * 需要会话的路径由 RBAC 契约与端到端脚本覆盖，缺口如实写在文件末尾。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const SESSION: CustomerSessionContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  businessId: '33333333-3333-4333-8333-333333333333',
};

/**
 * 每次调用用一个新的 accountId。
 *
 * 为什么必须这样（实测踩到）：改密码按**账号**限流
 * （`customer:change-password:account:<id>`，5 次/15 分钟），这是**正确**的设计
 * （口令爆破面必须限流）。但本文件里有多个"应返回 500/400"的用例，
 * 它们都会被计进同一个桶 —— 第 6 个用例开始全部变成 429，而被测实现
 * 其实是对的。也就是说：**测试自己制造的 429 会把真实断言掩盖掉**。
 *
 * 用独立 id 而不是放宽限流：限流是产品行为，不该为了测试被削弱；
 * 而这里要验的是"校验与失败路径"，与限流无关。
 */
let sessionCounter = 0;
function freshSession(): CustomerSessionContext {
  sessionCounter += 1;
  const n = String(sessionCounter).padStart(12, '0');
  return {
    accountId: `aaaaaaa1-1111-4111-8111-${n}`,
    tenantId: SESSION.tenantId,
    businessId: SESSION.businessId,
  };
}

/** 记录调用顺序与参数的可注入 deps。 */
function makeDeps(overrides: Partial<PasswordChangeDeps> = {}) {
  const calls: string[] = [];
  /** 桩里的"库"：键用真实列名，与 `PasswordChangeDeps` 的返回形状一致。 */
  const stored = new Map<string, { password_hash: string; password_salt: string }>();
  const deps: PasswordChangeDeps = {
    async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
      calls.push('loadCredentials');
      // 默认"库里没有这个账号"。需要别的情形由用例覆盖。
      return stored.get('row') ?? null;
    },
    async savePassword(_session, digest) {
      calls.push('savePassword');
      stored.set('saved', { password_hash: digest.hash, password_salt: digest.salt });
      return true;
    },
    async revokeOtherSessions() {
      calls.push('revokeOtherSessions');
      return 2;
    },
    ...overrides,
  };
  return { deps, calls, stored };
}

// ---------------------------------------------------------------------------
// 1) 注销账号：鉴权前的分支（真实 handler 调用）
// ---------------------------------------------------------------------------

describe('POST /api/customer/account/close —— 鉴权前分支（真实调用）', () => {
  test('无会话 ⇒ 401（不进入请求体解析）', async () => {
    const res = await closeAccount(jsonRequest('/api/customer/account/close', { confirm: true }));
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'unauthorized');
  });

  test('非法 JSON ⇒ 401 优先（鉴权失败不该被解析错误掩盖）', async () => {
    const res = await closeAccount(jsonRequest('/api/customer/account/close', '{not json'));
    assert.equal(res.status, 401);
  });

  test('负向对照：请求体里带了 confirm 也不能绕过鉴权', async () => {
    // "宽容地照样执行"是这类接口最危险的退化。确认字段是**额外的**一道门，不是替代品。
    const res = await closeAccount(jsonRequest('/api/customer/account/close', { confirm: true, account_id: SESSION.accountId }));
    assert.equal(res.status, 401, '带 confirm 与 account_id 仍然必须 401');
  });
});

// ---------------------------------------------------------------------------
// 2) 改密码：口径与顺序（可注入依赖，真实调用处理函数）
// ---------------------------------------------------------------------------

describe('changeCustomerPassword —— 失败口径', () => {
  const cases: Array<[string, unknown, number, RegExp]> = [
    ['非法 JSON', '{nope', 400, /invalid JSON/i],
    ['缺 current_password', { new_password: 'longenough123' }, 400, /current_password is required/i],
    ['新密码太短', { current_password: 'x', new_password: 'a'.repeat(7) }, 400, /at least 8/i],
    ['新密码太长', { current_password: 'x', new_password: 'a'.repeat(201) }, 400, /at most 200/i],
  ];
  for (const [label, body, status, pattern] of cases) {
    test(`${label} ⇒ ${status}`, async () => {
      const { deps } = makeDeps();
      const res = await changeCustomerPassword(
        jsonRequest('/api/customer/auth/change-password', body),
        freshSession(),
        deps,
      );
      assert.equal(res.status, status);
      const parsed = (await res.json()) as { error?: string };
      assert.match(String(parsed.error), pattern);
    });
  }

  test('参数不合法的请求**不碰**口令库（顺序：先校验、后读库）', async () => {
    const { deps, calls } = makeDeps();
    await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'x', new_password: 'short' }),
      freshSession(),
      deps,
    );
    assert.deepEqual(calls, [], '校验失败时不应读库、不应写库、不应撤销会话');
  });
});

describe('changeCustomerPassword —— "旧密码错"必须与会话无效无从区分', () => {
  test('账号行不存在 ⇒ 401 invalid credentials', async () => {
    const { deps } = makeDeps();
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'whatever', new_password: 'longenough123' }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'invalid credentials' });
  });

  test('旧密码不正确 ⇒ 401，且响应体与"账号行不存在"**逐字相同**', async () => {
    const digest = hashPassword('the-real-password');
    const { deps } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', {
        current_password: 'wrong-password',
        new_password: 'longenough123',
      }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 401);
    assert.deepEqual(
      await res.json(),
      { error: 'invalid credentials' },
      '两个失败分支的响应体必须相同 —— 否则本接口就成了"这个会话的密码是不是 X"的判定器',
    );
  });

  test('登录路由用的是同一个响应体形状（跨文件义务，路由注释点名了这条）', () => {
    // change-password 的文件头写明：它不 import 登录路由的常量（因为没导出），
    // 两处必须手工保持一致，而这个文件就是那条义务的落点。
    const login = read('src/app/api/customer/auth/login/route.ts');
    const change = read('src/app/api/customer/auth/change-password/route.ts');
    const loginShape = /error:\s*'invalid credentials'/.test(login);
    const changeShape = /error:\s*'invalid credentials'/.test(change);
    assert.ok(loginShape, "登录路由必须用 { error: 'invalid credentials' }");
    assert.ok(changeShape, '改密码路由必须用同一个形状');
    // 负向对照：换一种措辞必须被这条判定拒绝
    assert.doesNotMatch(
      "return json({ error: 'current password is incorrect' }, 401);",
      /error:\s*'invalid credentials'/,
    );
  });

  test('旧密码错时**不撤销**任何会话，也不写新口令', async () => {
    const digest = hashPassword('the-real-password');
    const { deps, calls } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        calls.push('loadCredentials');
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
    });
    await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'nope', new_password: 'longenough123' }),
      freshSession(),
      deps,
    );
    assert.deepEqual(calls, ['loadCredentials'], '旧密码错时不得产生副作用');
  });
});

describe('changeCustomerPassword —— 成功路径与顺序', () => {
  test('旧密码正确 ⇒ 先撤销其它会话、再写新口令，返回撤销数量', async () => {
    const digest = hashPassword('the-real-password');
    const { deps, calls, stored } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        calls.push('loadCredentials');
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', {
        current_password: 'the-real-password',
        new_password: 'a-brand-new-one-9',
      }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; revoked_sessions?: number };
    assert.equal(body.ok, true);
    assert.equal(body.revoked_sessions, 2);
    // 顺序是本接口的重点（文件头写了理由）：撤销失败时口令不能已经被改掉
    assert.deepEqual(calls, ['loadCredentials', 'revokeOtherSessions', 'savePassword']);
    assert.ok(stored.get('saved'), '必须真的写了新摘要');
  });

  test('新口令用新 salt（沿用旧 salt 会让"没换过密码"从库里看得出来）', async () => {
    const old = hashPassword('the-real-password');
    const { deps, stored } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        return { password_hash: old.hash, password_salt: old.salt };
      },
    });
    await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'the-real-password', new_password: 'another-one-123' }),
      freshSession(),
      deps,
    );
    const saved = stored.get('saved');
    assert.ok(saved);
    assert.notEqual(saved.password_salt, old.salt, 'salt 必须换新');
  });

  test('撤销会话失败 ⇒ 500，且**不写**新口令（顺序保证的可恢复性）', async () => {
    const digest = hashPassword('the-real-password');
    const { deps, calls } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        calls.push('loadCredentials');
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
      async revokeOtherSessions() {
        calls.push('revokeOtherSessions');
        throw new Error('revocation unavailable');
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'the-real-password', new_password: 'a-brand-new-one-9' }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 500);
    assert.deepEqual(calls, ['loadCredentials', 'revokeOtherSessions'], '撤销失败后绝不能继续写口令');
  });

  test('读库失败 ⇒ 500（不伪装成"账号不存在"的 401）', async () => {
    const { deps } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        throw new Error('db down');
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'x', new_password: 'longenough123' }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 500, '"不知道"与"没有"必须是不同的响应');
  });

  test('写库 0 行 ⇒ 500（0 行 update 在 supabase-js 里 error 为 null，不检查就会假装成功）', async () => {
    const digest = hashPassword('the-real-password');
    const { deps } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
      async savePassword() {
        return false;
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'the-real-password', new_password: 'a-brand-new-one-9' }),
      freshSession(),
      deps,
    );
    assert.equal(res.status, 500);
  });

  test('成功响应不回显任何口令字段', async () => {
    const digest = hashPassword('the-real-password');
    const { deps } = makeDeps({
      async loadCredentials(): Promise<{ password_hash: string; password_salt: string } | null> {
        return { password_hash: digest.hash, password_salt: digest.salt };
      },
    });
    const res = await changeCustomerPassword(
      jsonRequest('/api/customer/auth/change-password', { current_password: 'the-real-password', new_password: 'a-brand-new-one-9' }),
      freshSession(),
      deps,
    );
    const text = JSON.stringify(await res.json());
    assert.doesNotMatch(text, /password|salt|hash/i, `响应体不得含口令相关字段：${text}`);
  });
});

// ---------------------------------------------------------------------------
// 3) 缺口（如实记录，不用"有测试文件了"冒充覆盖）
// ---------------------------------------------------------------------------

describe('已知缺口（记录下来，不假装覆盖）', () => {
  test('注销的成功路径与顾客导出接口没有本文件级别的行为测试', () => {
    // 注销的成功路径需要真实会话（会打库）；导出接口同理。
    // 它们由 RBAC 契约（api-rbac-contract 的顾客端白名单）与端到端脚本覆盖到
    // "鉴权与路由存在"这一层，但**成功路径的副作用**没有本文件这样的直接断言。
    const rbac = read('tests/api-rbac-contract.test.ts');
    assert.match(rbac, /customer\/account\/close\/route\.ts/);
    assert.match(rbac, /customer\/auth\/change-password\/route\.ts/);
    // 负向对照：不存在的路径不该被这条判定认为已覆盖
    assert.doesNotMatch(rbac, /customer\/nonexistent-route\.ts/);
  });
});
