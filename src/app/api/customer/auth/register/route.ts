import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublishedSiteBySlug } from '@/lib/public-site';
import { isSecureRequest } from '@/lib/auth';
import {
  createCustomerSession,
  customerSessionCookieHeader,
  hashPassword,
} from '@/lib/customer-auth';
import {
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
} from '@/lib/rate-limit';

/**
 * POST /api/customer/auth/register —— 顾客注册（顾客端 PWA，公开接口）。
 *
 * ## 租户只从 slug 服务端解析
 *
 * 与 `/api/site/reservations`（src/app/api/site/reservations/route.ts:68）同一条纪律：
 * 请求体里传什么 tenant_id / business_id 都不看。公开接口上"客户端指定租户"
 * 就等于可以往任意商家的账号表里塞人。
 *
 * ## 为什么不是 Supabase Auth
 *
 * 顾客不进 `users`、不进 RBAC。口令用 Node 内置 scrypt 自管
 * （src/lib/customer-auth.ts 有完整理由），因此这里没有任何 auth API 调用，
 * 也就不会污染共享 supabase 单例（AGENTS.md 陷阱 8）。
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 255;
const MAX_DISPLAY_NAME = 80;
/** 口令上限只为挡住"拿 1MB 当密码"的请求：scrypt 的成本随输入线性增长。 */
const MAX_PASSWORD_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 8;
/** 与公开预约/外卖同口径：至少 5 位数字，不强行规定国际格式。 */
const MIN_PHONE_DIGITS = 5;

/** 与 next-intl 的三语一致；不在表里的值一律 400，不静默回落成 en。 */
const SUPPORTED_LOCALES: readonly string[] = ['en', 'zh', 'es'];

const AUTH_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };

interface RegisterBody {
  slug?: unknown;
  email?: unknown;
  phone?: unknown;
  password?: unknown;
  display_name?: unknown;
  locale?: unknown;
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: Request) {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  // 限流先于一切业务：它是免费的，且能在解析 slug / 打库之前挡掉噪声。
  const ipKey = `customer:register:ip:${getClientIp(request)}`;
  const ipLimit = checkFixedWindow(ipKey, { limit: 10, windowMs: 15 * 60_000, backoff: AUTH_BACKOFF });
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);

  const slug = asTrimmedString(body.slug, 63).toLowerCase();
  if (!slug) return jsonError('slug required', 400);

  // 标识符按"未归一化"的值做键：邮箱大小写、手机号带不带分隔符都不该绕开同一条计数。
  const identifierKey = `customer:register:id:${asTrimmedString(body.email, MAX_EMAIL_LENGTH).toLowerCase()}`
    + `|${asTrimmedString(body.phone, 40)}`;
  const identifierLimit = checkFixedWindow(identifierKey, {
    limit: 5,
    windowMs: 15 * 60_000,
    backoff: AUTH_BACKOFF,
  });
  if (!identifierLimit.ok) return rateLimitResponse(identifierLimit);

  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) return jsonError('site not found', 404);

  const rawEmail = asTrimmedString(body.email, MAX_EMAIL_LENGTH);
  const email = rawEmail ? rawEmail.toLowerCase() : '';
  const phone = asTrimmedString(body.phone, 40);
  if (!email && !phone) return jsonError('email or phone required', 400);
  if (email && !EMAIL_PATTERN.test(email)) return jsonError('invalid email', 400);
  if (phone && phone.replace(/[^0-9]/g, '').length < MIN_PHONE_DIGITS) {
    return jsonError('invalid phone', 400);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  }

  const displayName = asTrimmedString(body.display_name, MAX_DISPLAY_NAME);
  const locale = body.locale === undefined ? 'en' : asTrimmedString(body.locale, 5).toLowerCase();
  if (!SUPPORTED_LOCALES.includes(locale)) {
    return jsonError(`locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`, 400);
  }

  const client = getSupabaseClient();

  // 先查再插只是为了给出干净的 409；真正的唯一性由两条部分唯一索引保证
  // （scripts/migrate-customer-accounts.sql），并发下靠下面的 23505 兜底。
  if (email) {
    const { data, error } = await client
      .from('customer_accounts')
      .select('id')
      .eq('tenant_id', site.tenant_id)
      .eq('business_id', site.business_id)
      // 注册时统一存小写，所以这里用等值匹配就能命中 lower(email) 唯一索引
      .eq('email', email)
      .maybeSingle();
    if (error) {
      console.error('[customer/register] email lookup failed:', error.message);
      return jsonError('registration could not be completed', 500);
    }
    if (data) return jsonError('an account with this email already exists', 409);
  }
  if (phone) {
    const { data, error } = await client
      .from('customer_accounts')
      .select('id')
      .eq('tenant_id', site.tenant_id)
      .eq('business_id', site.business_id)
      .eq('phone', phone)
      .maybeSingle();
    if (error) {
      console.error('[customer/register] phone lookup failed:', error.message);
      return jsonError('registration could not be completed', 500);
    }
    if (data) return jsonError('an account with this phone already exists', 409);
  }

  const digest = hashPassword(password);
  const { data: inserted, error: insertError } = await client
    .from('customer_accounts')
    .insert({
      tenant_id: site.tenant_id,
      business_id: site.business_id,
      email: email || null,
      phone: phone || null,
      password_hash: digest.hash,
      password_salt: digest.salt,
      display_name: displayName || null,
      locale,
      // 营销订阅默认关闭：注册时不主动勾选，只能由顾客自己开启（合规最小化）
      marketing_opt_in: false,
      status: 'active',
    })
    .select('id, email, display_name')
    .single();

  if (insertError || !inserted) {
    // 并发同邮箱双插：靠唯一索引冲突兜底（没有它这里就永远进不来）
    if (insertError?.code === '23505') {
      noteFailure(identifierKey, AUTH_BACKOFF);
      return jsonError('an account with this email or phone already exists', 409);
    }
    console.error('[customer/register] insert failed:', insertError?.message);
    return jsonError('registration could not be completed', 500);
  }

  const account = inserted as { id: string; email: string | null; display_name: string | null };

  const session = await createCustomerSession({
    accountId: account.id,
    userAgent: request.headers.get('user-agent'),
  });
  if (!session.ok) {
    // 账号已经建好了，只是没能发会话：这是 500，不能返回 201 让顾客以为登录成功。
    // 顾客用同一组凭据走登录即可（账号已存在 → 登录会成功）。
    console.error('[customer/register] session insert failed:', session.error);
    return jsonError('account created but sign-in failed, please log in', 500);
  }

  noteSuccess(identifierKey);
  const response = json(
    {
      ok: true,
      account: { id: account.id, email: account.email, display_name: account.display_name },
    },
    201,
  );
  response.headers.set('Set-Cookie', customerSessionCookieHeader(session.token, isSecureRequest(request)));
  return response;
}
