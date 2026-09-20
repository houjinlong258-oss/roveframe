import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublishedSiteBySlug } from '@/lib/public-site';
import { isSecureRequest } from '@/lib/auth';
import {
  createCustomerSession,
  customerSessionCookieHeader,
  verifyPassword,
} from '@/lib/customer-auth';
import {
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
} from '@/lib/rate-limit';

/**
 * POST /api/customer/auth/login —— 顾客登录（顾客端 PWA，公开接口）。
 *
 * ## 未知账号与密码错误必须**无法区分**
 *
 * 两者都返回 401 + `{ error: 'invalid credentials' }`（同一个对象字面量，
 * 见 `INVALID_CREDENTIALS`）：只要两种情况的响应体有任何一个字段不同，
 * 这个接口就变成了"某邮箱/手机号是否在本店注册过"的查询工具。
 * 因此这里也不回显 identifier，不回显是邮箱命中还是手机号命中。
 *
 * ## identifier 先邮箱后手机，命中即止
 *
 * 同一个字符串可能既是 A 账号的邮箱又是 B 账号的手机号。这种情况下"用哪个账号"
 * 没有正确答案，因此固定顺序（先邮箱）并且在邮箱命中后**不再回落到手机号**：
 * 回落意味着一次请求要试两个账号的口令，等于把爆破面翻倍，
 * 而且用户看到的行为会随另一个账号的存在而改变。
 *
 * ## 限流两条线 + 指数退避（与 /api/auth/signup 同一形态）
 *
 * 每条线都带 backoff：连续失败会让封锁时长翻倍（15min → 30min → … 封顶 1h）。
 * 失败时**两条线都记**，成功时两条线都清 —— 否则换 IP 或换标识符就能绕开。
 *
 * ## 已知的残余信道（有意保留）
 *
 * 账号不存在时不会跑 scrypt，因此响应时间比"账号存在但密码错"短几十毫秒，
 * 理论上可被计时区分。修它需要给不存在的情况跑一次等价的假 scrypt。
 * 本接口的响应体已经不可区分，且这条信道需要主动测量才能利用，
 * 因此这里先显式记录，不引入额外的假计算分支。
 */

const MAX_PASSWORD_LENGTH = 200;
const AUTH_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };
/** 每标识符 5 次/15min；每 IP 20 次/15min（与商家登录同口径）。 */
const IDENTIFIER_WINDOW = { limit: 5, windowMs: 15 * 60_000, backoff: AUTH_BACKOFF };
const IP_WINDOW = { limit: 20, windowMs: 15 * 60_000, backoff: AUTH_BACKOFF };

/** 单一事实来源：两种失败原因共用同一个对象，避免日后改一处漏一处。 */
const INVALID_CREDENTIALS = { error: 'invalid credentials' } as const;

interface LoginBody {
  slug?: unknown;
  identifier?: unknown;
  password?: unknown;
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

interface AccountRow {
  id: string;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  status: string;
}

export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const slug = asTrimmedString(body.slug, 63).toLowerCase();
  const identifier = asTrimmedString(body.identifier, 255);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!slug) return jsonError('slug required', 400);
  if (!identifier || !password) return jsonError('identifier / password required', 400);

  // 只对**形态合法**的输入计数：空 identifier 已经 400，不该消耗真实账号的配额。
  const ipKey = `customer:login:ip:${getClientIp(request)}`;
  const identifierKey = `customer:login:id:${slug}:${identifier.toLowerCase()}`;
  const identifierLimit = checkFixedWindow(identifierKey, IDENTIFIER_WINDOW);
  if (!identifierLimit.ok) return rateLimitResponse(identifierLimit);
  const ipLimit = checkFixedWindow(ipKey, IP_WINDOW);
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);

  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) return jsonError('site not found', 404);

  const client = getSupabaseClient();
  const lowerIdentifier = identifier.toLowerCase();

  // 邮箱：注册时统一存小写，因此等值匹配即可命中 lower(email) 唯一索引
  const { data: byEmail, error: emailError } = await client
    .from('customer_accounts')
    .select('id, email, phone, display_name, password_hash, password_salt, status')
    .eq('tenant_id', site.tenant_id)
    .eq('business_id', site.business_id)
    .eq('email', lowerIdentifier)
    .maybeSingle();
  if (emailError) {
    // 查询失败既不是"账号不存在"也不是"密码错误"，必须是 500 ——
    // 否则一次数据库抖动会被当成"你的密码不对"，用户会去改密码。
    console.error('[customer/login] email lookup failed:', emailError.message);
    return jsonError('login could not be completed', 500);
  }

  let account = byEmail as AccountRow | null;
  if (!account) {
    const { data: byPhone, error: phoneError } = await client
      .from('customer_accounts')
      .select('id, email, phone, display_name, password_hash, password_salt, status')
      .eq('tenant_id', site.tenant_id)
      .eq('business_id', site.business_id)
      .eq('phone', identifier)
      .maybeSingle();
    if (phoneError) {
      console.error('[customer/login] phone lookup failed:', phoneError.message);
      return jsonError('login could not be completed', 500);
    }
    account = byPhone as AccountRow | null;
  }

  if (!account) {
    noteFailure(identifierKey, AUTH_BACKOFF);
    noteFailure(ipKey, AUTH_BACKOFF);
    return json(INVALID_CREDENTIALS, 401);
  }
  if (account.status !== 'active') {
    // 停用账号同样走"凭据无效"：否则响应差异会告诉对方"这个账号存在，只是被停用了"
    noteFailure(identifierKey, AUTH_BACKOFF);
    noteFailure(ipKey, AUTH_BACKOFF);
    return json(INVALID_CREDENTIALS, 401);
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    noteFailure(identifierKey, AUTH_BACKOFF);
    noteFailure(ipKey, AUTH_BACKOFF);
    return json(INVALID_CREDENTIALS, 401);
  }

  if (!verifyPassword(password, account.password_salt, account.password_hash)) {
    noteFailure(identifierKey, AUTH_BACKOFF);
    noteFailure(ipKey, AUTH_BACKOFF);
    return json(INVALID_CREDENTIALS, 401);
  }

  const session = await createCustomerSession({
    accountId: account.id,
    userAgent: request.headers.get('user-agent'),
  });
  if (!session.ok) {
    console.error('[customer/login] session insert failed:', session.error);
    return jsonError('login could not be completed', 500);
  }

  // 必须 await：Next.js 路由里 fire-and-forget 的 Promise 会被丢弃（AGENTS.md 陷阱 13）。
  // 这一列只用于"最近一次登录时间"的展示，写失败不足以让一次成功的登录失败，
  // 但**必须留日志**，否则该列在某段时间悄悄为空将无从解释。
  const { error: touchError } = await client
    .from('customer_accounts')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', account.id)
    .eq('tenant_id', site.tenant_id)
    .eq('business_id', site.business_id);
  if (touchError) {
    console.error('[customer/login] last_login_at update failed:', touchError.message);
  }

  noteSuccess(identifierKey);
  noteSuccess(ipKey);

  const response = json({
    ok: true,
    account: { id: account.id, email: account.email, display_name: account.display_name },
  });
  response.headers.set('Set-Cookie', customerSessionCookieHeader(session.token, isSecureRequest(request)));
  return response;
}
