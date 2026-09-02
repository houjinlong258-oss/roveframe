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

import { getSupabaseClient } from '@/storage/database/supabase-client';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

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

/** 创建 tenant 行（slug 自动从 name 生成） */
export async function createTenantRow(opts: { name: string; slug?: string }): Promise<
  Result<{ tenantId: string }>
> {
  const client = getSupabaseClient();
  const slug = opts.slug ?? slugFromName(opts.name);
  const { data, error } = await client
    .from('tenants')
    .insert({ name: opts.name, slug })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert tenants failed' };
  }
  return { ok: true, data: { tenantId: (data as { id: string }).id } };
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

/** 登录并取 access_token */
export async function signInAndGetToken(opts: {
  email: string;
  password: string;
}): Promise<Result<{ accessToken: string; userId: string }>> {
  const client = getSupabaseClient();
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
  Result<{
    userId: string;
    email: string;
    tenantId: string;
    businessId: string | null;
    role: string;
    name: string | null;
  }>
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
  const { data: pubUser, error: pubErr } = await client
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
