import crypto from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 顾客账号（顾客端 PWA）的会话与口令原语。
 *
 * ## 为什么不复用 `src/lib/auth.ts`
 *
 * 那一套是**商家**会话：Supabase Auth 签发的 JWT + public.users 的 role，
 * 整个 RBAC（src/lib/rbac.ts）与 `/api/**` 边界（src/lib/auth-guard.ts）都建立在它之上。
 * 顾客既没有 role 也不该出现在员工列表里；把顾客塞进 `users` 就等于给每个顾客
 * 开一个后台账号。所以这里是一套**独立**的会话：口令自管（scrypt）、
 * 会话自管（`customer_sessions` 表 + HttpOnly cookie），与商家会话零交叉。
 *
 * ## 唯一沿用商家侧的东西：`isSecureRequest`
 *
 * cookie 的 `Secure` 属性按**请求协议**判定，不能看 NODE_ENV（AGENTS.md 陷阱 10：
 * 生产模式固定加 Secure，用 http 访问部署站时浏览器静默拒收 cookie →
 * 登录 200 但会话丢失）。这个判定只允许有一个实现，因此本模块**不自己判断协议**：
 * `customerSessionCookieHeader(token, secure)` 的 `secure` 由调用方传入，
 * 调用方一律用 `isSecureRequest(request)`（从 `@/lib/auth` import，不是复制一份）。
 * 这与商家侧 `sessionCookieHeader(accessToken, secure)` 的形态完全一致。
 *
 * ## 为什么 scryptSync 是同步的
 *
 * 注册/登录是低频路径，一次 scrypt 约几十毫秒，可接受；换成异步版本要引入
 * promisify 包装且不改变结论。本仓库约束"零新增依赖"，Node 内置 scrypt 是
 * 唯一既安全又无需装包的选择（AES-256-GCM 的 `@/lib/crypto` 是**可逆**加密，
 * 用于存凭据，不能用来存口令）。
 */

/** cookie 名一个字都不能改：前端与测试都按它读写。 */
export const CUSTOMER_SESSION_COOKIE_NAME = 'roveframe_customer_session';

/** 30 天。运行时长为常量，避免各处硬编码不一致。 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** scrypt 摘要长度（字节）。存储为 hex，因此 password_hash 是 128 个字符。 */
const SCRYPT_KEYLEN = 64;
/** salt 16 字节 = 32 个 hex 字符，落在 varchar(64) 内。 */
const SALT_BYTES = 16;
/**
 * N/r/p 显式写出来而不是吃默认值：默认值会随 Node 版本变，
 * 而 `password_hash` 一旦落库就必须能被**任意版本**的同一个函数验证。
 * 参数变化时应当增加新列/新前缀，而不是悄悄改这里。
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * 可接受的最小摘要长度（字节）。
 *
 * 为什么需要这条下限：scrypt 的输出是**前缀流** —— 用 keylen=32 派生出的摘要
 * 恰好等于用 keylen=64 派生结果的前 32 字节。因此"摘要被截断成 16 字节"
 * 这种降级（无论来自脏数据还是人为篡改）必须被明确拒绝，而不是当成一个
 * 更弱但可用的口令通过校验。
 */
const MIN_DIGEST_BYTES = 32;

/** 会话 token：32 字节随机数的 base64url（43 个字符，不含需要转义的字符）。 */
const SESSION_TOKEN_BYTES = 32;

export interface PasswordDigest {
  /** hex 编码的 salt */
  salt: string;
  /** hex 编码的 scrypt 摘要 */
  hash: string;
}

export interface CustomerSessionContext {
  accountId: string;
  tenantId: string;
  businessId: string;
}

export type CreateCustomerSessionResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; error: string };

export type RevokeCustomerSessionResult =
  | { ok: true; revoked: boolean }
  | { ok: false; error: string };

/** 生成口令摘要。每次调用都新取随机 salt —— 同一个口令两次注册必须得到不同的 hash。 */
export function hashPassword(password: string): PasswordDigest {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/**
 * 校验口令。
 *
 * 摘要长度由**库里存的那一份**决定（而不是恒等于 SCRYPT_KEYLEN）：
 * 这样日后调整参数/长度时，老账号仍能登录。但长度必须 >= MIN_DIGEST_BYTES，
 * 否则一个被截断的短摘要会被当成"更弱但有效"的凭据接受。
 *
 * `timingSafeEqual` 要求两侧等长，否则抛异常；长度本身不是秘密，
 * 因此先比长度是安全的，且避免把"异常"当成"密码错误"混在一起。
 */
export function verifyPassword(password: string, saltHex: string, hashHex: string): boolean {
  if (!password || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length < MIN_DIGEST_BYTES) return false;
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length === 0) return false;
  const derived = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/** 会话 token 的摘要。库列 token_hash 是 varchar(64)，sha256 hex 正好 64。 */
function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 从 Cookie 头取会话 token（形态与 src/lib/auth.ts 的 tokenFromCookieHeader 一致）。 */
function tokenFromCookieHeader(value: string | null): string | null {
  if (!value) return null;
  const encoded = value
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CUSTOMER_SESSION_COOKIE_NAME}=`))
    ?.slice(CUSTOMER_SESSION_COOKIE_NAME.length + 1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    // 百分号编码坏掉的 cookie 视为没有 cookie（调用方一律按"未登录"处理）
    return null;
  }
}

/**
 * 建会话：**只把 sha256(token) 落库**，原 token 作为返回值交给调用方写进 cookie。
 *
 * 库被读走时，攻击者拿到的是摘要，无法直接当会话使用；摘要也不可逆推 token
 * （32 字节随机数，无字典可猜）。
 */
export async function createCustomerSession(input: {
  accountId: string;
  userAgent?: string | null;
}): Promise<CreateCustomerSessionResult> {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  const { error } = await getSupabaseClient()
    .from('customer_sessions')
    .insert({
      account_id: input.accountId,
      token_hash: hashSessionToken(token),
      expires_at: expiresAt.toISOString(),
      user_agent: input.userAgent ? input.userAgent.slice(0, 240) : null,
    });
  if (error) return { ok: false, error: error.message };
  return { ok: true, token, expiresAt: expiresAt.toISOString() };
}

/**
 * 解出当前请求的顾客会话；任何一处不满足都返回 null（fail-closed）：
 *   1. 没有 cookie，或库里的会话行不存在；
 *   2. 已撤销（revoked_at 非空）；
 *   3. 已过期（expires_at <= now）；
 *   4. 账号不存在或 status != 'active'（停用即刻失效，不必等 30 天）。
 *
 * 查询出错同样返回 null（对调用方就是 401）——这是 fail-closed 的选择，
 * 但**必须留日志**：否则库不可用会表现成"所有人突然都登录失效"，无迹可查。
 */
export async function resolveCustomerSession(
  request: Request,
): Promise<CustomerSessionContext | null> {
  const token = tokenFromCookieHeader(request.headers.get('cookie'));
  if (!token) return null;

  const client = getSupabaseClient();
  const { data: sessionRow, error: sessionError } = await client
    .from('customer_sessions')
    .select('account_id, expires_at, revoked_at')
    .eq('token_hash', hashSessionToken(token))
    .maybeSingle();
  if (sessionError) {
    console.error('[customer-auth] session lookup failed:', sessionError.message);
    return null;
  }
  if (!sessionRow) return null;

  const session = sessionRow as {
    account_id: string;
    expires_at: string;
    revoked_at: string | null;
  };
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const { data: accountRow, error: accountError } = await client
    .from('customer_accounts')
    .select('id, tenant_id, business_id, status')
    .eq('id', session.account_id)
    .maybeSingle();
  if (accountError) {
    console.error('[customer-auth] account lookup failed:', accountError.message);
    return null;
  }
  if (!accountRow) return null;

  const account = accountRow as {
    id: string;
    tenant_id: string;
    business_id: string;
    status: string;
  };
  if (account.status !== 'active') return null;

  return {
    accountId: account.id,
    tenantId: account.tenant_id,
    businessId: account.business_id,
  };
}

/**
 * 撤销当前请求的会话（登出）。
 *
 * 幂等：没有 cookie、或该 token 根本没有对应行，都返回 ok —— 登出的语义是
 * "这个浏览器不再是登录态"，重复调用不应报错。
 * 只有**写库失败**才返回 ok:false，让路由显式返回 500：那种情况下会话仍然有效，
 * 返回 200 就是在撒谎（用户以为已登出，实际 cookie 还能用）。
 */
export async function revokeCustomerSession(
  request: Request,
): Promise<RevokeCustomerSessionResult> {
  const token = tokenFromCookieHeader(request.headers.get('cookie'));
  if (!token) return { ok: true, revoked: false };

  const { error } = await getSupabaseClient()
    .from('customer_sessions')
    .update({ revoked_at: new Date().toISOString() })
    // 已撤销的行不再改写：保留第一次登出的时间戳，便于审计
    .is('revoked_at', null)
    .eq('token_hash', hashSessionToken(token));
  if (error) return { ok: false, error: error.message };
  return { ok: true, revoked: true };
}

export type RevokeCustomerSessionsResult =
  | { ok: true; revoked: number }
  | { ok: false; error: string };

/**
 * 批量撤销某个账号的会话（改密码 / 注销账号用）。
 *
 * ## 为什么放在本模块而不是各个路由里
 *
 * "当前请求的 token → sha256(token)" 这一步只有本模块能做（`hashSessionToken` 与
 * cookie 解析都是私有的）。改密码路由要"撤销除自己以外的全部会话"，就必须拿到
 * 自己那一行的 token_hash —— 在路由里再写一遍 sha256 + cookie 解析，等于把
 * 会话凭据的推导实现复制成两份，文件头警告过的漂移面（协议判定只允许有一个实现）
 * 会原样长回来。因此这里给出唯一实现，路由只表达意图（`keepCurrent`）。
 *
 * ## keepCurrent 的语义与 fail-closed
 *
 * `keepCurrent: true`（改密码）撤销**除调用方本会话以外**的全部未撤销会话：
 *   · 不带这个例外，改密码就等于把自己也踢下线 —— 用户改完密码还要重新登录，
 *     而真正要拦的"别人那台设备"和"我自己这台"在同一次操作里无法区分；
 *   · 拿不到自己的 token 时**不猜**：返回 ok:false（调用方 500）。
 *     静默撤销全部 = 把用户登出，静默撤销 0 条 = 密码改了但谁也没被踢掉 ——
 *     两种"猜"都违背这次操作的目的。
 *
 * `keepCurrent: false`（注销账号）撤销该账号全部未撤销会话。
 *
 * 已撤销的行不重写（`.is('revoked_at', null)`）：保留第一次登出的时间戳，
 * 与 `revokeCustomerSession` 同一口径。
 */
export async function revokeCustomerSessions(
  request: Request,
  accountId: string,
  options: { keepCurrent: boolean },
): Promise<RevokeCustomerSessionsResult> {
  let keepTokenHash: string | null = null;
  if (options.keepCurrent) {
    const token = tokenFromCookieHeader(request.headers.get('cookie'));
    if (!token) return { ok: false, error: 'no session token to keep' };
    keepTokenHash = hashSessionToken(token);
  }

  const scoped = getSupabaseClient()
    .from('customer_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .is('revoked_at', null);
  // 只有 keepCurrent 才加 token 例外；注销账号必须是"全部"
  const target = keepTokenHash === null ? scoped : scoped.neq('token_hash', keepTokenHash);

  // select('id') 让"撤销了 0 条"与"撤销了 N 条"可区分 ——
  // 没有它，supabase-js 对 0 行的 update 同样返回 error=null，
  // 调用方无法在审计/响应里说清楚到底影响了几条会话。
  const { data, error } = await target.select('id');
  if (error) return { ok: false, error: error.message };
  return { ok: true, revoked: (data ?? []).length };
}

/**
 * 登录成功后的 Set-Cookie。
 * `secure` 必须来自 `isSecureRequest(request)`（@/lib/auth），本模块不自行判定协议。
 */
export function customerSessionCookieHeader(token: string, secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  return `${CUSTOMER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; `
    + `Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly${securePart}; SameSite=Lax`;
}

/** 登出后的 Set-Cookie（Max-Age=0 立即失效）。 */
export function clearCustomerSessionHeader(secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  return `${CUSTOMER_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly${securePart}; SameSite=Lax`;
}
