import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CUSTOMER_SESSION_COOKIE_NAME,
  clearCustomerSessionHeader,
  customerSessionCookieHeader,
  hashPassword,
  verifyPassword,
} from '../src/lib/customer-auth';

/**
 * Phase 19 —— 顾客账号后端的守卫。
 *
 * ## 守的是什么
 *
 * 这一层的失败模式大多**没有症状**：
 *
 *   1. 口令摘要写错（salt 没用上、比较用 `===` 而不是 `timingSafeEqual`）：
 *      功能测试全绿，安全性为零。
 *   2. 会话 token 原样落库：直到库被读走那天才会暴露。
 *   3. 登录接口对"账号不存在"和"密码错误"给出不同响应：等于开放账号枚举，
 *      而这在正常使用中完全看不出来。
 *   4. 非本人的订单返回 403：403 确认了"这个 id 存在"，接口变成订单探针。
 *   5. 迁移文件少写 `if not exists`：第二次执行直接报错，而首次部署永远成功。
 *
 * ## 为什么是源码级断言而不是端到端
 *
 * 本仓库的测试进程没有隔离的数据库替身（零新增依赖，不引入 mock 框架），
 * 因此第 3、4、6 条守的是**实现形态**：把两处写歪，断言必须变红。
 * 每个源码级判定都配了**负向对照**（把坏写法喂给同一个判定函数，必须判为坏），
 * 否则"永远通过"的断言等于没有断言。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 判定：地址簿的三个动词（GET/POST/DELETE）各自都带 account_id + tenant_id +
 * business_id 三个过滤条件。按 handler 分块检查，而不是数全文出现次数 ——
 * 后者会因为某个动词多查一次就误报。
 */
function everyAddressVerbScoped(source: string): boolean {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const start = source.indexOf(`export async function ${method}(`);
    if (start === -1) return false;
    const next = source.indexOf('export async function ', start + 1);
    const block = source.slice(start, next === -1 ? undefined : next);
    if (!/\.eq\('account_id', session\.accountId\)/.test(block)) return false;
    if (!/\.eq\('tenant_id', session\.tenantId\)/.test(block)) return false;
    if (!/\.eq\('business_id', session\.businessId\)/.test(block)) return false;
  }
  return true;
}

const REGISTER_ROUTE = 'src/app/api/customer/auth/register/route.ts';
const LOGIN_ROUTE = 'src/app/api/customer/auth/login/route.ts';
const LOGOUT_ROUTE = 'src/app/api/customer/auth/logout/route.ts';
const ME_ROUTE = 'src/app/api/customer/me/route.ts';
const ORDERS_ROUTE = 'src/app/api/customer/orders/route.ts';
const ADDRESSES_ROUTE = 'src/app/api/customer/addresses/route.ts';
const AUTH_LIB = 'src/lib/customer-auth.ts';
const MIGRATION = 'scripts/migrate-customer-accounts.sql';

// ---------------------------------------------------------------------------
// 1) 口令摘要
// ---------------------------------------------------------------------------

describe('customer auth: password hashing', () => {
  test('scrypt 摘要可以往返验证，错误口令不通过', () => {
    const digest = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', digest.salt, digest.hash), true);
    assert.equal(verifyPassword('correct horse battery stapl', digest.salt, digest.hash), false);
    assert.equal(verifyPassword('', digest.salt, digest.hash), false);
    assert.equal(verifyPassword('CORRECT HORSE BATTERY STAPLE', digest.salt, digest.hash), false);
  });

  test('同一口令两次摘要不同 —— 证明 salt 真的参与了', () => {
    const first = hashPassword('same-password-123');
    const second = hashPassword('same-password-123');
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    // 两者都能验证通过：不同的 salt 各自自洽
    assert.equal(verifyPassword('same-password-123', first.salt, first.hash), true);
    assert.equal(verifyPassword('same-password-123', second.salt, second.hash), true);
    // 交叉组合必须失败：否则说明 salt 根本没进 KDF
    assert.equal(verifyPassword('same-password-123', first.salt, second.hash), false);
  });

  test('摘要与 salt 是 hex 且落在库列宽内', () => {
    const digest = hashPassword('length-check');
    assert.match(digest.salt, /^[0-9a-f]{32}$/);   // 16 字节
    assert.match(digest.hash, /^[0-9a-f]{128}$/);  // 64 字节
    assert.ok(digest.salt.length <= 64, 'password_salt 是 varchar(64)');
    // 负向对照：不是明文
    assert.notEqual(digest.hash, 'length-check');
    assert.doesNotMatch(digest.hash, /length/);
  });

  test('畸形/截断的存储值返回 false，而不是抛异常', () => {
    const digest = hashPassword('malformed-input');
    assert.equal(verifyPassword('malformed-input', digest.salt, 'not-hex'), false);
    assert.equal(verifyPassword('malformed-input', 'not-hex', digest.hash), false);
    assert.equal(verifyPassword('malformed-input', digest.salt, ''), false);
    assert.equal(verifyPassword('malformed-input', '', digest.hash), false);
    // 被截断到下限以下的摘要必须被拒绝。
    // 注意 scrypt 输出是前缀流：截到 >= 32 字节仍会校验通过（前缀相等），
    // 因此真正挡住"降级摘要"的是这条长度下限，而不是 timingSafeEqual。
    assert.equal(verifyPassword('malformed-input', digest.salt, digest.hash.slice(0, 32)), false);
    assert.equal(
      verifyPassword('malformed-input', digest.salt, digest.hash.slice(0, 64)),
      true,
      'scrypt 截断到 32 字节仍是同一条前缀 —— 这说明下限检查是必需的',
    );
  });

  test('源码级：比较用 timingSafeEqual，不使用 === 比摘要', () => {
    const lib = stripComments(read(AUTH_LIB));
    assert.match(lib, /crypto\.timingSafeEqual\(derived, expected\)/);
    assert.match(lib, /crypto\.scryptSync\(/);
    // 负向对照：把比较换成字符串相等，下面这条正则必须命中
    const broken = 'return derived === expected;';
    assert.match(broken, /(derived|hash)\s*===\s*(expected|hash)/);
    assert.doesNotMatch(
      lib,
      /(derived|hash)\s*===\s*(expected|hash)/,
      '口令摘要不得用 === 比较（存在时序侧信道）',
    );
  });
});

// ---------------------------------------------------------------------------
// 2) 会话 cookie
// ---------------------------------------------------------------------------

describe('customer auth: session cookie', () => {
  test('cookie 名精确等于 roveframe_customer_session', () => {
    assert.equal(CUSTOMER_SESSION_COOKIE_NAME, 'roveframe_customer_session');
  });

  test('Set-Cookie 带 HttpOnly / SameSite=Lax / Path=/ / 30 天', () => {
    const header = customerSessionCookieHeader('tok-abc', false);
    assert.ok(header.startsWith('roveframe_customer_session=tok-abc;'));
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=2592000/); // 30 天
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    // http 请求下不得带 Secure（浏览器会静默拒收 cookie，见 AGENTS.md 陷阱 10）
    assert.doesNotMatch(header, /Secure/);
    assert.match(customerSessionCookieHeader('tok-abc', true), /; Secure/);
  });

  test('清 cookie 用 Max-Age=0，且 Secure 同样跟随请求协议', () => {
    const cleared = clearCustomerSessionHeader(false);
    assert.match(cleared, /^roveframe_customer_session=;/);
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /HttpOnly/);
    assert.doesNotMatch(cleared, /Secure/);
    assert.match(clearCustomerSessionHeader(true), /; Secure/);
  });

  test('cookie 形态只有一处实现：路由里不得手写这个 cookie 名', () => {
    for (const rel of [REGISTER_ROUTE, LOGIN_ROUTE, LOGOUT_ROUTE]) {
      const route = stripComments(read(rel));
      assert.doesNotMatch(
        route,
        /roveframe_customer_session=/,
        `${rel} 手写了 cookie 串 —— 名字/属性会出现第二份真相`,
      );
      assert.match(route, /isSecureRequest\(request\)/, `${rel} 必须用商家侧同一个 isSecureRequest 判定协议`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3) 登录失败与账号不存在不可区分
// ---------------------------------------------------------------------------

/**
 * 取出源码里所有 `..., 401)` 形态的响应体表达式。
 * 覆盖 `json(X, 401)` / `jsonError('...', 401)` 两种写法。
 */
function unauthorizedBodies(source: string): string[] {
  return [...source.matchAll(/json(?:Error)?\(\s*([^,()]+?)\s*,\s*401\s*\)/g)].map((m) => m[1].trim());
}

/** 判定：所有 401 共用同一个具名常量，且该常量就是 'invalid credentials'。 */
function allUnauthorizedShareOneBody(source: string): boolean {
  const bodies = unauthorizedBodies(source);
  if (bodies.length < 2) return false; // 只有一条失败路径 ⇒ 断言没有意义
  if (new Set(bodies).size !== 1) return false;
  return bodies[0] === 'INVALID_CREDENTIALS';
}

describe('customer auth: login does not reveal account existence', () => {
  test('账号不存在与密码错误走同一个 401 响应体', () => {
    const route = stripComments(read(LOGIN_ROUTE));
    assert.match(route, /const INVALID_CREDENTIALS = \{ error: 'invalid credentials' \} as const;/);
    assert.ok(
      allUnauthorizedShareOneBody(route),
      `登录路由的 401 响应体不唯一：${JSON.stringify(unauthorizedBodies(route))} —— `
      + '不同响应体等于把接口变成账号存在性探针',
    );
    // 至少三条路径：账号不存在 / 账号被停用 / 口令错误
    assert.ok(unauthorizedBodies(route).length >= 3, '失败路径数量异常，判定函数可能已失效');
    assert.equal(route.includes("'invalid credentials'"), true);
  });

  test('负向对照：响应体不一致的写法必须被判为坏', () => {
    const broken = `
      const INVALID_CREDENTIALS = { error: 'invalid credentials' } as const;
      if (!account) return jsonError('account not found', 401);
      if (!verifyPassword(password, account.password_salt, account.password_hash)) {
        return json(INVALID_CREDENTIALS, 401);
      }`;
    assert.equal(allUnauthorizedShareOneBody(broken), false, '这条断言永远通过就等于没有断言');
    // 只有一条失败路径时也不该放行（否则"两条路径都一样"根本无从谈起）
    assert.equal(allUnauthorizedShareOneBody("return json(INVALID_CREDENTIALS, 401);"), false);
  });

  test('失败路径必须同时记 IP 与标识符两条退避线', () => {
    const route = stripComments(read(LOGIN_ROUTE));
    assert.match(route, /checkFixedWindow\(identifierKey, IDENTIFIER_WINDOW\)/);
    assert.match(route, /checkFixedWindow\(ipKey, IP_WINDOW\)/);
    assert.match(route, /const IDENTIFIER_WINDOW = \{[^}]*backoff: AUTH_BACKOFF/);
    assert.match(route, /const IP_WINDOW = \{[^}]*backoff: AUTH_BACKOFF/);
    // 失败要两条都记、成功要两条都清，否则换一条线就能绕开
    assert.equal([...route.matchAll(/noteFailure\(identifierKey, AUTH_BACKOFF\)/g)].length >= 3, true);
    assert.equal([...route.matchAll(/noteFailure\(ipKey, AUTH_BACKOFF\)/g)].length >= 3, true);
    assert.match(route, /noteSuccess\(identifierKey\)/);
    assert.match(route, /noteSuccess\(ipKey\)/);
  });
});

// ---------------------------------------------------------------------------
// 4) 订单归属：404 而不是 403
// ---------------------------------------------------------------------------

describe('customer orders: ownership boundary', () => {
  test('非本人的订单返回 404，且这个文件里没有 403', () => {
    const route = stripComments(read(ORDERS_ROUTE));
    assert.match(route, /'order not found', 404/);
    assert.doesNotMatch(
      route,
      /\b403\b/,
      '403 等于确认"这个订单 id 存在，只是不属于你" —— 接口会变成订单存在性探针',
    );
  });

  test('负向对照：把 404 换成 403，上面的断言必须变红', () => {
    const broken = "return jsonError('order not found', 403);";
    assert.equal(/'order not found', 404/.test(broken), false);
    assert.equal(/\b403\b/.test(broken), true);
  });

  test('归属由会话的手机号决定，且查询带租户与商家条件', () => {
    const route = stripComments(read(ORDERS_ROUTE));
    assert.match(route, /resolveCustomerSession\(request\)/);
    assert.match(route, /\.eq\('recipient_phone', phone\)/);
    assert.match(route, /\.eq\('tenant_id', session\.tenantId\)/);
    assert.match(route, /\.eq\('business_id', session\.businessId\)/);
    // 负向对照：请求体里不接受任何"我是谁"的字段
    assert.doesNotMatch(route, /await request\.json\(\)/);
    assert.doesNotMatch(route, /searchParams\.get\('phone'\)/);
  });

  test('返回字段含 rider_status，且金额被转成数字', () => {
    const route = stripComments(read(ORDERS_ROUTE));
    assert.match(route, /rider_status: riderStatus/);
    assert.match(route, /total: Number\(row\.total\)/);
  });
});

// ---------------------------------------------------------------------------
// 5) 迁移文件幂等
// ---------------------------------------------------------------------------

describe('customer accounts: migration idempotency', () => {
  const sql = read(MIGRATION);

  test('迁移文件存在，且三张表都建了', () => {
    assert.ok(existsSync(join(ROOT, MIGRATION)));
    for (const table of ['customer_accounts', 'customer_sessions', 'customer_addresses']) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`));
    }
  });

  test('只有 if not exists 形态：没有裸 create table / create index', () => {
    const bareTable = /create\s+table\s+(?!if\s+not\s+exists)/i;
    const bareIndex = /create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/i;
    assert.equal(bareTable.test(sql), false, '存在裸 create table —— 第二次执行会报错');
    assert.equal(bareIndex.test(sql), false, '存在裸 create index —— 第二次执行会报错');
    // 负向对照：这两种写法必须能被同一个正则抓住
    assert.equal(bareTable.test('create table public.x (id int);'), true);
    assert.equal(bareIndex.test('create unique index x_key on public.x (id);'), true);
  });

  test('唯一索引口径：(tenant_id, business_id, lower(email)) 与 phone 均为部分索引', () => {
    assert.match(
      sql,
      /create unique index if not exists customer_accounts_email_key\s+on public\.customer_accounts \(tenant_id, business_id, lower\(email\)\)\s+where email is not null;/,
    );
    assert.match(
      sql,
      /create unique index if not exists customer_accounts_phone_key\s+on public\.customer_accounts \(tenant_id, business_id, phone\)\s+where phone is not null;/,
    );
    // 负向对照：漏掉 where 就不是部分索引，只有手机号的账号会被 email 唯一性挡住
    assert.equal(
      /customer_accounts_email_key[\s\S]{0,200}where email is not null/.test(
        'create unique index customer_accounts_email_key on public.customer_accounts (tenant_id, business_id, lower(email));',
      ),
      false,
    );
  });

  test('会话表索引：token_hash 唯一、账号+过期时间有索引', () => {
    assert.match(
      sql,
      /create unique index if not exists customer_sessions_token_hash_key\s+on public\.customer_sessions \(token_hash\);/,
    );
    assert.match(
      sql,
      /create index if not exists customer_sessions_account_expiry_idx\s+on public\.customer_sessions \(account_id, expires_at\);/,
    );
    assert.match(
      sql,
      /create index if not exists customer_addresses_account_idx\s+on public\.customer_addresses \(account_id\);/,
    );
  });

  test('列与默认值与契约一致', () => {
    assert.match(sql, /password_hash text not null/);
    assert.match(sql, /password_salt varchar\(64\) not null/);
    assert.match(sql, /locale varchar\(5\) not null default 'en'/);
    assert.match(sql, /marketing_opt_in boolean not null default false/);
    assert.match(sql, /status varchar\(20\) not null default 'active'/);
    assert.match(sql, /token_hash varchar\(64\) not null/);
    assert.match(sql, /revoked_at timestamptz/);
    assert.match(sql, /is_default boolean not null default false/);
  });
});

// ---------------------------------------------------------------------------
// 6) 会话 token 绝不原样落库
// ---------------------------------------------------------------------------

/** 取出 `createCustomerSession` 里那条 insert 的字段块。 */
function sessionInsertBlock(lib: string): string {
  const start = lib.indexOf("from('customer_sessions')");
  assert.notEqual(start, -1, '未找到 customer_sessions 的写入点 —— 代码结构已变，请更新本测试');
  const insertStart = lib.indexOf('.insert(', start);
  const insertEnd = lib.indexOf('});', insertStart);
  assert.notEqual(insertEnd, -1, '未能界定 insert 字段块');
  return lib.slice(insertStart, insertEnd);
}

/** 判定：写的是摘要列，而不是把 token 本身当字段写入。 */
function insertsRawToken(block: string): boolean {
  return /(^|[\s{,])token\s*:/.test(block);
}

describe('customer sessions: raw token never persisted', () => {
  test('insert 写的是 token_hash，且摘要来自 sha256', () => {
    const lib = stripComments(read(AUTH_LIB));
    const block = sessionInsertBlock(lib);
    assert.match(block, /token_hash:\s*hashSessionToken\(token\)/);
    assert.match(lib, /crypto\.createHash\('sha256'\)/);
    assert.equal(insertsRawToken(block), false, 'insert 里出现了裸 token 字段');
    // 负向对照：把裸 token 写进去，判定必须命中
    assert.equal(insertsRawToken("insert({ account_id: id, token: token })"), true);
    assert.equal(insertsRawToken("insert({ account_id: id, token_hash: hashSessionToken(token) })"), false);
  });

  test('token 由 32 字节随机数生成，且是可放进 cookie 的 base64url', () => {
    const lib = stripComments(read(AUTH_LIB));
    assert.match(lib, /crypto\.randomBytes\(SESSION_TOKEN_BYTES\)\.toString\('base64url'\)/);
    assert.match(lib, /const SESSION_TOKEN_BYTES = 32;/);
    // 负向对照：不得用可预测来源
    assert.doesNotMatch(lib, /Math\.random\(\)/);
    assert.doesNotMatch(lib, /randomUUID\(\)[\s\S]{0,80}session/i);
  });

  test('会话解析同时检查撤销、过期与账号状态', () => {
    const lib = stripComments(read(AUTH_LIB));
    assert.match(lib, /if \(session\.revoked_at\) return null;/);
    assert.match(lib, /new Date\(session\.expires_at\)\.getTime\(\) <= Date\.now\(\)/);
    assert.match(lib, /if \(account\.status !== 'active'\) return null;/);
    assert.match(lib, /\.eq\('token_hash', hashSessionToken\(token\)\)/);
  });
});

// ---------------------------------------------------------------------------
// 7) 路由边界
// ---------------------------------------------------------------------------

describe('customer routes: boundaries', () => {
  test('注册：至少一个联系方式、口令下限 8、重复 409、租户来自 slug', () => {
    const route = stripComments(read(REGISTER_ROUTE));
    assert.match(route, /resolvePublishedSiteBySlug\(slug\)/);
    assert.match(route, /if \(!email && !phone\) return jsonError\('email or phone required', 400\)/);
    assert.match(route, /const MIN_PASSWORD_LENGTH = 8;/);
    assert.match(route, /password must be at least \$\{MIN_PASSWORD_LENGTH\} characters/);
    assert.match(route, /already exists', 409\)/);
    // 租户/商家只能来自服务端解析的站点
    assert.match(route, /tenant_id: site\.tenant_id/);
    assert.match(route, /business_id: site\.business_id/);
    assert.doesNotMatch(route, /body\.tenant_id|body\.business_id/);
    assert.match(route, /hashPassword\(password\)/);
    assert.match(route, /customerSessionCookieHeader\(session\.token, isSecureRequest\(request\)\)/);
  });

  test('注册：摘要只写不读，响应不回显凭据列', () => {
    const route = stripComments(read(REGISTER_ROUTE));
    assert.match(route, /password_hash: digest\.hash/);
    assert.match(route, /password_salt: digest\.salt/);
    // 注册路径不需要把摘要读回来：select 里出现它说明有人在读凭据
    assert.doesNotMatch(route, /select\([^)]*password_hash/);
    assert.doesNotMatch(route, /console\.(log|error)\([^)]*password/);
  });

  test('登录：读取凭据是必要的，但不得进日志或响应体', () => {
    const route = stripComments(read(LOGIN_ROUTE));
    assert.match(route, /password_hash, password_salt/, '登录必须能读到摘要与 salt');
    assert.doesNotMatch(route, /console\.(log|error)\([^)]*password/);
    assert.doesNotMatch(route, /json\(\{[^}]*password_hash/);
    assert.doesNotMatch(route, /password_hash: account\.password_hash/);
  });

  test('me / addresses 一律先解析会话，且查询自带租户与商家条件', () => {
    // me 读的是账号表本身，主键就是 accountId；地址表才是 account_id 列
    const meRoute = stripComments(read(ME_ROUTE));
    assert.match(meRoute, /const session = await resolveCustomerSession\(request\);/);
    assert.match(meRoute, /if \(!session\) return jsonError\('unauthorized', 401\);/);
    assert.match(meRoute, /\.eq\('id', session\.accountId\)/);
    assert.match(meRoute, /\.eq\('tenant_id', session\.tenantId\)/);
    assert.match(meRoute, /\.eq\('business_id', session\.businessId\)/);

    const addressesRoute = stripComments(read(ADDRESSES_ROUTE));
    assert.match(addressesRoute, /const session = await resolveCustomerSession\(request\);/);
    assert.match(addressesRoute, /if \(!session\) return jsonError\('unauthorized', 401\);/);
    // 逐个动词检查：只按 account_id 定位会在账号 id 跨租户复用时读到/删掉别的商家的地址
    assert.equal(
      everyAddressVerbScoped(addressesRoute),
      true,
      'GET/POST/DELETE 三个动词必须各自带 account_id + tenant_id + business_id 过滤',
    );
    // 负向对照：删掉 tenant_id 条件后，同一个判定必须变红
    assert.equal(
      everyAddressVerbScoped(addressesRoute.replace(/\.eq\('tenant_id', session\.tenantId\)/g, '')),
      false,
    );

    for (const [rel, route] of [[ME_ROUTE, meRoute], [ADDRESSES_ROUTE, addressesRoute]] as const) {
      assert.doesNotMatch(route, /body\.account_id/, `${rel} 从请求体取身份`);
    }
  });

  test('me 不回传口令列', () => {
    const route = stripComments(read(ME_ROUTE));
    assert.match(route, /select\('id, email, phone, display_name, locale, marketing_opt_in'\)/);
    assert.doesNotMatch(route, /password_hash|password_salt/);
  });

  test('地址簿上限 10 条，超限 409；删除不是 403', () => {
    const route = stripComments(read(ADDRESSES_ROUTE));
    assert.match(route, /const MAX_ADDRESSES = 10;/);
    assert.match(route, /length >= MAX_ADDRESSES\) \{\s*return jsonError\(`address limit reached \(max \$\{MAX_ADDRESSES\}\)`, 409\)/);
    assert.match(route, /'address not found', 404/);
    assert.doesNotMatch(route, /\b403\b/);
    // 删除必须能区分"删掉了 0 行"，否则 404 分支永远不可达
    assert.match(route, /\.select\('id'\);\s*\n\s*if \(error\)/);
    assert.match(route, /if \(!data \|\| data\.length === 0\) return jsonError\('address not found', 404\)/);
  });

  test('登出撤销会话行，并且写库失败时返回 500（不伪装成功）', () => {
    const route = stripComments(read(LOGOUT_ROUTE));
    assert.match(route, /const revoked = await revokeCustomerSession\(request\);/);
    assert.match(route, /if \(!revoked\.ok\)[\s\S]{0,200}jsonError\('logout could not be completed', 500\)/);
    assert.match(route, /clearCustomerSessionHeader\(isSecureRequest\(request\)\)/);
    const lib = stripComments(read(AUTH_LIB));
    assert.match(lib, /\.update\(\{ revoked_at: new Date\(\)\.toISOString\(\) \}\)/);
    // 幂等：没有 cookie 时直接 ok，不去查库也不报错
    assert.match(lib, /if \(!token\) return \{ ok: true, revoked: false \};/);
    assert.match(lib, /const token = tokenFromCookieHeader\(request\.headers\.get\('cookie'\)\);/);
  });

  test('六个文件都存在（缺一个就是 404 而不是"未实现"）', () => {
    for (const rel of [
      REGISTER_ROUTE, LOGIN_ROUTE, LOGOUT_ROUTE, ME_ROUTE, ORDERS_ROUTE, ADDRESSES_ROUTE,
      AUTH_LIB, MIGRATION,
    ]) {
      assert.ok(existsSync(join(ROOT, rel)), `${rel} 不存在`);
    }
  });
});
