/**
 * POST /api/auth/invite
 *
 * Header: Authorization: Bearer <access_token>（调用方必须是 owner/manager）
 * Body: { email, role: 'manager' | 'staff', business_id? }
 *
 * 行为：
 *   1) 从 token 解析当前用户 + 租户
 *   2) auth.admin.inviteUserByEmail 发邀请（Supabase 自动生成 invite link）
 *   3) 返回 { invite_url, email, role }，调用方用现有邮件通道发送 invite_url
 *
 * 注：本端点只生成 invite_url，实际发送邮件留待 email 系统接入。
 *    公开路由不需要 tenant 过滤（这是平台表操作）。
 */
import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveUserByToken } from '@/lib/auth';
import { getTenantContext } from '@/lib/tenant';
import { protectTenantMutation } from '@/lib/mutation-guard';
import { resolveAppOrigin } from '@/lib/app-origin';

interface InviteBody {
  email: string;
  role: 'manager' | 'staff';
  business_id?: string;
  /** 邀请链接落地页的语言（localePrefix: 'always'，缺省 en） */
  locale?: string;
}

async function inviteUser(request: Request) {
  const auth = request.headers.get('authorization');
  if (!auth) {
    return jsonError('missing Authorization header', 401);
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  const me = await resolveUserByToken(token);
  if (!me.ok) {
    return jsonError(`unauthorized: ${me.error}`, 401);
  }
  if (me.data.role !== 'owner' && me.data.role !== 'manager') {
    return jsonError('forbidden: only owner/manager can invite', 403);
  }

  let body: InviteBody;
  try {
    body = (await request.json()) as InviteBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }
  if (!body.email || !body.role) {
    return jsonError('email / role required', 400);
  }
  if (body.role !== 'manager' && body.role !== 'staff') {
    return jsonError('role must be manager or staff', 400);
  }

  const client = getSupabaseClient();
  const ctx = await getTenantContext(request);
  const targetBusinessId = body.business_id ?? me.data.businessId ?? null;
  if (!targetBusinessId) {
    return jsonError('business_id required for an invitation', 400);
  }
  // Never trust a client-supplied business_id. It must belong to this tenant;
  // managers are additionally confined to their own business.
  const { data: business, error: businessError } = await client
    .from('businesses')
    .select('id, tenant_id')
    .eq('id', targetBusinessId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (businessError) return jsonError(`business lookup failed: ${businessError.message}`, 500);
  if (!business) return jsonError('business does not belong to your tenant', 403);
  if (me.data.role === 'manager' && me.data.businessId !== targetBusinessId) {
    return jsonError('managers may only invite users to their own business', 403);
  }

  // 1) Supabase 生成 invite link（admin API，需 service_role）
  //
  // Phase 16 任务 6 修掉三个缺陷：
  //   a) **没有写 app_metadata.tenant_id** —— 而被邀请人能不能通过鉴权，
  //      取决于 `verifyJwtLocally` / `auth-guard` 读 `app_metadata.tenant_id`
  //      （`auth.ts:219`、`auth-guard.ts:164`）。缺了它，被邀请人**永远无法认证**：
  //      邮件能收到、点开能设密码，然后每次请求 401。这是本功能一直不可用的根因。
  //   b) `redirectTo` 指向 `<origin>/auth/callback`，而该路由**不存在**；
  //      且站点是 `localePrefix: 'always'`，不带 locale 的地址还要多一次 307。
  //   c) 返回 `invite_url: null`，调用方拿不到链接 —— 而注释写着"调用方用现有邮件通道
  //      发送 invite_url"。返回 null 等于让调用方无法完成这件事。
  const origin = resolveAppOrigin(request);
  const locale = ['en', 'zh', 'es'].includes(body.locale ?? '') ? body.locale! : 'en';
  const { data, error } = await client.auth.admin.inviteUserByEmail(body.email, {
    redirectTo: `${origin}/${locale}/auth/login`,
    data: {
      tenant_id: ctx.tenantId,
      business_id: targetBusinessId,
      role: body.role,
    },
  });
  if (error || !data.user) {
    return jsonError(`invite failed: ${error?.message ?? 'unknown'}`, 500);
  }

  // 2) 立即在 public.users 占位（user 接受邀请后再补全）
  const { error: placeholderErr } = await client.from('users').insert({
    id: data.user.id,
    tenant_id: ctx.tenantId,
    business_id: targetBusinessId,
    email: body.email,
    role: body.role,
  });
  if (placeholderErr) {
    // 占位失败不致命——auth 邀请已发出，等用户接受后 me 端点会自动关联
  }

  return json(
    {
      invited_user_id: data.user.id,
      email: body.email,
      role: body.role,
      business_id: targetBusinessId,
      tenant_id: ctx.tenantId,
      // Supabase 生成的邀请链接：调用方可以直接发给被邀请人，
      // 也可以用现有邮件通道（/api/emails/send）发出。
      // SDK 的类型声明里 User 没有 invite_link（它随版本变化），运行时存在；
      // 因此显式断言而不是改类型定义。
      invite_url: (data.user as unknown as { invite_link?: string | null }).invite_link ?? null,
      // 说明链接的有效性依赖平台侧的邮件模板配置，避免调用方以为一定能拿到
      invite_url_source: 'supabase_admin_invite',
    },
    201,
  );
}

export const POST = protectTenantMutation(
  { permission: 'users:write', action: 'users.invite', entity: 'users' },
  inviteUser,
);
