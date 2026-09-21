/**
 * Auth 共享 helper（P0-S2 完整版：Part B + C）
 *
 * 范围：
 *   - createAuthUserWithTenant：auth.admin.createUser + 注入 app_metadata.tenant_id
 *   - createTenantRow / createBusinessRow / createPublicUserRow：建 P0 平台表三行
 *   - signInAndGetToken：登录取 access_token
 *   - resolveUserByToken：解析 token → 关联 public.users → 返 user + tenant + role
 *
 * 所有函数返回 discriminated union { ok data } | { error string }，调用方必须先判别。
 * 不抛异常是因为 Next.js Route Handler 里把异常当 500 处理，需要精细状态码。
 */

import { getSupabaseClient, getCleanServiceClient, getFreshServiceClient } from '@/storage/database/supabase-client';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export const SESSION_COOKIE_NAME = 'rf_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type AuthenticatedUser = {
  userId: string;
  email: string;
  tenantId: string;
  businessId: string | null;
  role: 'owner' | 'manager' | 'staff';
  name: string | null;
};

function tokenFromAuthorizationHeader(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function tokenFromCookieHeader(value: string | null): string | null {
  if (!value) return null;
  const encoded = value
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** Browser cookie first, then Bearer token for API clients and server integrations. */
export function getRequestAccessToken(request: Request): string | null {
  return (
    tokenFromAuthorizationHeader(request.headers.get('authorization')) ??
    tokenFromCookieHeader(request.headers.get('cookie'))
  );
}

/** TLS 终止可能在边缘代理完成：以 x-forwarded-proto 为准，回退请求自身协议。 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) return forwarded === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function sessionCookieHeader(accessToken: string, secure: boolean): string {
  // Secure 仅在 https 请求下启用：http 页面浏览器会拒绝存储 Secure cookie，导致会话静默丢失
  const securePart = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(accessToken)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly${securePart}; SameSite=Lax`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly${securePart}; SameSite=Lax`;
}

/** 从 name 生成 url-safe slug；fallback 到时间戳 */
function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base || `tenant-${Date.now().toString(36)}`;
}

/** 创建 auth user（admin API）+ 注入 tenant claim */
export async function createAuthUserWithTenant(opts: {
  email: string;
  password: string;
  tenantId: string;
  businessId?: string | null;
  name?: string;
}): Promise<Result<{ userId: string }>> {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
    app_metadata: {
      tenant_id: opts.tenantId,
      business_id: opts.businessId ?? null,
    },
    user_metadata: {
      business_id: opts.businessId ?? null,
      name: opts.name ?? null,
    },
  });
  if (error || !data.user) {
    return { ok: false, error: error?.message ?? 'auth.admin.createUser failed' };
  }
  return { ok: true, data: { userId: data.user.id } };
}

/**
 * 创建 tenant 行（slug 自动从 name 生成）。
 *
 * ## 为什么 slug 冲突要重试（Phase 18 实测发现）
 *
 * `tenants.slug` 上有唯一索引，而 slug 是从**店名**推出来的。
 * 于是"第二家叫同样名字的店"注册会直接失败 —— 实测：
 *
 *     create tenant failed: duplicate key value violates unique constraint "tenants_slug_key"
 *
 * 这是 500，而且把数据库约束名透给了顾客。真实世界里重名完全正常
 * （"四川人家"在一个城市可以有好几家），所以这不是边界情况，是**正常输入**。
 *
 * 处理方式：冲突时给 slug 追加一个短后缀重试（有界，最多 4 次）。
 * 这是唯一合理的语义 —— 店名是商家的，平台没有理由因为它重复就拒绝注册；
 * 而**归一化后的 slug 只是内部标识**，加后缀对商家不可见也不影响任何功能。
 *
 * 为什么不先查再插：查询与插入之间有竞态窗口，两个并发注册会双双通过检查。
 * 靠唯一索引拒绝、再重试，是唯一没有竞态的做法。
 */
const SLUG_RETRY_LIMIT = 4;

export async function createTenantRow(opts: { name: string; slug?: string }): Promise<
  Result<{ tenantId: string }>
> {
  const client = getSupabaseClient();
  const baseSlug = opts.slug ?? slugFromName(opts.name);

  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt += 1) {
    // 第一次用原始 slug；之后每次追加一个短随机后缀。
    // 后缀取 4 位 base36（约 170 万种），足够避免连续重试撞同一个。
    const slug = attempt === 0
      ? baseSlug
      : `${baseSlug.slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await client
      .from('tenants')
      .insert({ name: opts.name, slug })
      .select('id')
      .single();
    if (!error && data) {
      return { ok: true, data: { tenantId: (data as { id: string }).id } };
    }
    // 23505 = unique_violation。只有它值得重试；其他错误立刻返回（fail-closed）。
    if (error?.code !== '23505') {
      return { ok: false, error: error?.message ?? 'insert tenants failed' };
    }
  }
  return {
    ok: false,
    error: `could not allocate a unique tenant slug after ${SLUG_RETRY_LIMIT} attempts`,
  };
}

/** 创建 business 行 */
export async function createBusinessRow(opts: {
  tenantId: string;
  name: string;
  industry: string;
  language?: string;
  currency?: string;
}): Promise<Result<{ businessId: string }>> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('businesses')
    .insert({
      tenant_id: opts.tenantId,
      name: opts.name,
      industry: opts.industry,
      language: opts.language ?? 'en',
      currency: opts.currency ?? 'USD',
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert businesses failed' };
  }
  return { ok: true, data: { businessId: (data as { id: string }).id } };
}

/** 创建 public.users 行（关联 auth user + tenant + business） */
export async function createPublicUserRow(opts: {
  id: string; // = auth.users.id
  tenantId: string;
  businessId?: string | null;
  email: string;
  name?: string;
  role?: 'owner' | 'manager' | 'staff';
}): Promise<Result<{ userId: string }>> {
  const client = getSupabaseClient();
  const { error } = await client.from('users').insert({
    id: opts.id,
    tenant_id: opts.tenantId,
    business_id: opts.businessId ?? null,
    email: opts.email,
    name: opts.name ?? null,
    role: opts.role ?? 'owner',
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, data: { userId: opts.id } };
}

/**
 * 为新租户建一条 trialing 订阅（Phase 16 任务 2）。
 *
 * ## 为什么必须建
 *
 * 权益门禁是 **fail-closed** 的：`tenant_subscriptions` 里没有行的租户，
 * 写操作一律被拒（`subscription_missing`）。因此"注册不建订阅"等价于
 * "新商家注册完就是只读" —— 那不是门禁，那是坏掉的产品。
 *
 * ## 为什么在注册流程里同步建、并且失败就整体失败
 *
 * 这条写入是**用户可感知状态**的一部分：它的失败必须变成注册失败，
 * 而不是"账号建好了但用不了"。因此调用点放在**建 auth 用户之前** ——
 * 失败时只留下一个没有登录凭据的 tenant+business，用户重试即可，
 * 不会出现"能登录却是只读"的黑洞账号。
 */
export async function createTrialSubscriptionRow(opts: {
  tenantId: string;
  planId: string;
  trialEndsAt: string;
}): Promise<Result<{ subscriptionId: string | null }>> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('tenant_subscriptions')
    .insert({
      tenant_id: opts.tenantId,
      plan_id: opts.planId,
      status: 'trialing',
      current_period_end: opts.trialEndsAt,
      renewal_source: 'offline',
      currency: 'USD',
      last_payment_status: 'trial',
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert tenant_subscriptions failed' };
  }
  return { ok: true, data: { subscriptionId: (data as { id: string }).id } };
}

/** 登录并取 access_token */
export async function signInAndGetToken(opts: {
  email: string;
  password: string;
}): Promise<Result<{ accessToken: string; userId: string }>> {
  const client = getFreshServiceClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: opts.email,
    password: opts.password,
  });
  if (error || !data.session || !data.user) {
    return { ok: false, error: error?.message ?? 'signInWithPassword failed' };
  }
  return {
    ok: true,
    data: { accessToken: data.session.access_token, userId: data.user.id },
  };
}

/** 用 access_token 解析当前 user + 关联 public.users */
export async function resolveUserByToken(token: string): Promise<
  Result<AuthenticatedUser>
> {
  const client = getSupabaseClient();
  const { data: userData, error: userErr } = await client.auth.getUser(token);
  if (userErr || !userData.user) {
    return { ok: false, error: userErr?.message ?? 'invalid token' };
  }
  const authUser = userData.user;
  const appMeta = (authUser.app_metadata ?? {}) as {
    tenant_id?: string;
    business_id?: string | null;
  };
  if (!appMeta.tenant_id) {
    return { ok: false, error: 'token has no tenant_id in app_metadata' };
  }
  const { data: pubUser, error: pubErr } = await getCleanServiceClient()
    .from('users')
    .select('id, tenant_id, business_id, email, name, role')
    .eq('id', authUser.id)
    .single();
  if (pubErr || !pubUser) {
    return { ok: false, error: pubErr?.message ?? 'public.users row not found' };
  }
  const row = pubUser as {
    id: string;
    tenant_id: string;
    business_id: string | null;
    email: string;
    name: string | null;
    role: string;
  };
  if (row.tenant_id !== appMeta.tenant_id) {
    return { ok: false, error: 'tenant claim does not match public.users' };
  }
  if (appMeta.business_id && row.business_id !== appMeta.business_id) {
    return { ok: false, error: 'business claim does not match public.users' };
  }
  if (row.role !== 'owner' && row.role !== 'manager' && row.role !== 'staff') {
    return { ok: false, error: 'public.users has an invalid role' };
  }
  return {
    ok: true,
    data: {
      userId: authUser.id,
      email: row.email,
      tenantId: appMeta.tenant_id,
      businessId: row.business_id,
      role: row.role,
      name: row.name,
    },
  };
}

/** Verifies a request credential with Supabase and resolves the matching tenant user. */
export async function resolveUserByRequest(request: Request): Promise<Result<AuthenticatedUser>> {
  const token = getRequestAccessToken(request);
  if (!token) return { ok: false, error: 'missing session credential' };
  return resolveUserByToken(token);
}
