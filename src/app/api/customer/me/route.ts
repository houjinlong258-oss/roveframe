import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession } from '@/lib/customer-auth';

/**
 * GET /api/customer/me —— 当前顾客账号。
 *
 * 三个条件（id + tenant_id + business_id）都要带上：会话本身已经锁定了租户，
 * 但把租户条件写进查询是纵深防御 —— 会话行与账号行万一不一致（比如账号被
 * 移到别的商家），这里必须查不到，而不是把另一个商家的账号资料返回出去。
 *
 * 只返回 id/email/phone/display_name/locale/marketing_opt_in：
 * password_hash 与 password_salt **永远不出现在任何响应里**。
 */
export async function GET(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const { data, error } = await getSupabaseClient()
    .from('customer_accounts')
    .select('id, email, phone, display_name, locale, marketing_opt_in')
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();

  if (error) {
    console.error('[customer/me] account lookup failed:', error.message);
    return jsonError('account could not be loaded', 500);
  }
  // 会话有效但账号行不在/不在本租户：按未登录处理（不泄漏"这个 id 存在"）
  if (!data) return jsonError('unauthorized', 401);

  const account = data as {
    id: string;
    email: string | null;
    phone: string | null;
    display_name: string | null;
    locale: string;
    marketing_opt_in: boolean;
  };

  return json({
    account: {
      id: account.id,
      email: account.email,
      phone: account.phone,
      display_name: account.display_name,
      locale: account.locale,
      marketing_opt_in: account.marketing_opt_in,
    },
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/customer/me —— 顾客编辑自己的资料
// ---------------------------------------------------------------------------

/**
 * ## 身份只来自会话，请求体里**没有**账号 id
 *
 * 本路由不接受 `account_id`（请求体、查询串都不接受），更新语句的三个条件
 * （id + tenant_id + business_id）全部取自 `resolveCustomerSession`。
 * 只要存在一个能被客户端指定的账号标识，这个接口就变成"改任意顾客资料"的入口，
 * 而权限矩阵**表达不了**"你只能改你自己的那一行"（那是行级所有权，不是角色属性）。
 * tests/customer-account.test.ts 对此有源码级断言 + 合成反例。
 *
 * ## PATCH 语义：字段没出现就是不改
 *
 * 用 `in` 判断字段是否出现，而不是"取不到就当空"。后者会让一次只想改语言的请求
 * 顺手把手机号清空 —— 而手机号是订单归属的匹配键（src/app/api/customer/orders），
 * 静默清空的表现是"我的历史订单突然全没了"。
 *
 * ## 为什么"清空手机号"需要一个额外的前置读
 *
 * 账号至少要有一个登录标识（注册路由的文件头写明了：邮箱与手机号至少一个存在）。
 * 如果账号只有手机号，而顾客把它清空，这个账号就**再也登不进来**了 ——
 * 顾客侧没有找回通道，客服也无法替他登录。因此这里读一次当前行：
 * 只用来判断"清空之后还剩不剩下一个标识"，其余校验都不依赖它。
 *
 * ## 手机号撞车是 409，不是 500
 *
 * `customer_accounts_phone_key`（scripts/migrate-customer-accounts.sql:55）是
 * (tenant_id, business_id, phone) 的部分唯一索引。撞索引时 PostgREST 回 23505 ——
 * 那是"这个号已经被占用"这条明确的产品结论，必须原样告诉顾客（他自己能换一个号），
 * 而不是变成"服务器错误"。
 */

const MAX_DISPLAY_NAME = 80;
/** 与注册路由同口径：手机号列是 varchar(40)。 */
const MAX_PHONE = 40;
/** 与注册 / 公开预约 / 外卖同口径：至少 5 位数字，不强行规定国际格式。 */
const MIN_PHONE_DIGITS = 5;
/** 与 next-intl 的三语一致；不在表里的值一律 400，不静默回落成 en（注册路由同口径）。 */
const SUPPORTED_LOCALES: readonly string[] = ['en', 'zh', 'es'];

interface MePatchBody {
  display_name?: unknown;
  phone?: unknown;
  locale?: unknown;
  marketing_opt_in?: unknown;
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function PATCH(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  let body: MePatchBody;
  try {
    body = (await request.json()) as MePatchBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const patch: Record<string, unknown> = {};

  if ('display_name' in body) {
    const displayName = asTrimmedString(body.display_name, MAX_DISPLAY_NAME);
    // 空串 = 清空昵称（列可空）。不清成 null 的话，界面上会出现一个空白名字的账号。
    patch.display_name = displayName || null;
  }

  if ('phone' in body) {
    const phone = asTrimmedString(body.phone, MAX_PHONE);
    if (phone && phone.replace(/[^0-9]/g, '').length < MIN_PHONE_DIGITS) {
      return jsonError('valid phone required', 400);
    }
    patch.phone = phone || null;
  }

  if ('locale' in body) {
    const locale = asTrimmedString(body.locale, 5).toLowerCase();
    if (!SUPPORTED_LOCALES.includes(locale)) {
      return jsonError(`locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`, 400);
    }
    patch.locale = locale;
  }

  if ('marketing_opt_in' in body) {
    // 只认布尔值：'true' / 1 一律拒绝。宽松解析会让"关"变成"开"，
    // 而这是**同意**记录 —— 把没同意过的人记成已同意是合规事故，不是体验问题。
    if (typeof body.marketing_opt_in !== 'boolean') {
      return jsonError('marketing_opt_in must be a boolean', 400);
    }
    patch.marketing_opt_in = body.marketing_opt_in;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError('no updatable fields provided', 400);
  }

  const client = getSupabaseClient();

  // 前置读只服务一件事：清空手机号之后账号还剩不剩一个登录标识（见文件头）。
  const { data: currentRaw, error: currentError } = await client
    .from('customer_accounts')
    .select('email, phone')
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();
  if (currentError) {
    console.error('[customer/me] current account read failed:', currentError.message);
    return jsonError('account could not be updated', 500);
  }
  // 会话有效但账号行不在（被删/被挪走）：按未登录处理，不泄漏"这个 id 存在过"
  if (!currentRaw) return jsonError('unauthorized', 401);

  const current = currentRaw as { email: string | null; phone: string | null };
  const nextPhone = 'phone' in patch ? (patch.phone as string | null) : current.phone;
  if (!nextPhone && !current.email) {
    return jsonError('an account needs an email or a phone to sign in', 409);
  }

  const { data, error } = await client
    .from('customer_accounts')
    .update(patch)
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    // 列清单与本文件 GET 的 select 逐字相同：两处不一致会让"改完资料后界面上的
    // 语言/订阅开关显示成旧值"，而那种漂移既不报错也不影响 HTTP 状态码。
    .select('id, email, phone, display_name, locale, marketing_opt_in')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return jsonError('this phone number is already used by another account', 409);
    }
    console.error('[customer/me] account update failed:', error.message);
    return jsonError('account could not be updated', 500);
  }
  if (!data) return jsonError('unauthorized', 401);

  const account = data as {
    id: string;
    email: string | null;
    phone: string | null;
    display_name: string | null;
    locale: string;
    marketing_opt_in: boolean;
  };

  return json({
    ok: true,
    account: {
      id: account.id,
      email: account.email,
      phone: account.phone,
      display_name: account.display_name,
      locale: account.locale,
      marketing_opt_in: account.marketing_opt_in,
    },
  });
}
