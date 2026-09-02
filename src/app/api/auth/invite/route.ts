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

interface InviteBody {
  email: string;
  role: 'manager' | 'staff';
  business_id?: string;
}

export async function POST(request: Request) {
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
  const ctx = getTenantContext(request);
  const targetBusinessId = body.business_id ?? me.data.businessId ?? null;

  // 1) Supabase 生成 invite link（admin API，需 service_role）
  const { data, error } = await client.auth.admin.inviteUserByEmail(body.email, {
    redirectTo: `${request.headers.get('origin') ?? ''}/auth/callback`,
    data: { business_id: targetBusinessId, role: body.role },
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
      // 完整版应该走 email 通道发送 invite link；此处仅返回占位
      invite_url: null,
    },
    201,
  );
}
