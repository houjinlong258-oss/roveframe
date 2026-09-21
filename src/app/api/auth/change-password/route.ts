/**
 * POST /api/auth/change-password
 *
 * Body: { current_password, new_password }
 * 返回: 200 { ok: true } / 400 参数不合法 / 401 当前密码不正确 / 429 太频繁 / 500 上游失败
 *
 * ## 这个端点在补什么
 *
 * 此前系统里**没有任何改密码的通道**：注册时设一次，之后只能由
 * `scripts/ensure-initial-user.ts` 之类的外部脚本重置（那需要库密码，不是给用户用的）。
 * 设置页因此只能展示身份、不能提供"修改密码"—— 一个点了没反应的按钮比没有更糟。
 *
 * ## 为什么必须验证当前密码
 *
 * 只凭会话就允许改密码，等于**任何一次会话劫持都能永久接管账号**：
 * 攻击者改掉密码后，真正的用户连登录都做不到，也无法自救。
 * 所以先拿旧密码向 GoTrue 换一次登录（证明操作者知道旧密码），再写新密码。
 *
 * ## 为什么目标用户取自会话而不是请求体
 *
 * 只认 `resolveRequestUser(request)` 解析出的 userId。请求体里**不接受** user_id /
 * email —— 收了这个字段，这个接口就变成"任意账号改密"的提权入口。
 *
 * ## 陷阱 8：碰 auth 会话的方法不得用共享单例
 *
 * `signInWithPassword` 会把用户 session 写进 supabase-js client 的内存态，
 * 之后该 client 的所有 REST 请求 Authorization 被用户 JWT 覆盖（role=authenticated），
 * service_role 失效、撞 RLS。因此：
 *   · 校旧密码走 `signInAndGetToken`（内部就是 `getFreshServiceClient()`，每次全新实例）；
 *   · 写新密码用 `getFreshServiceClient().auth.admin.updateUserById`（同样全新实例）。
 * **不要**把这两处换成 `getSupabaseClient()` 共享单例。
 *
 * ## 权限取自哪一条
 *
 * 走 `protectTenantMutation`（租户级身份/控制面记录，不属于某个 business），
 * 权限用 `workforce:self`：改自己的密码是"对自己账号的自助动作"，
 * 与 `/api/staff/preferences`（同样是 `workforce:self`）同一口径。
 * 三个角色都持有它（owner 由 `*` 覆盖，manager / staff 显式持有），
 * 所以员工也能改自己的密码 —— 而 `users:write` 只有 owner 有，
 * 用它会让店长和员工永远改不了密码。
 */
import { json, jsonError } from '@/lib/api-helpers';
import { signInAndGetToken } from '@/lib/auth';
import { resolveRequestUser } from '@/lib/auth-guard';
import { protectTenantMutation } from '@/lib/mutation-guard';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';
import { getFreshServiceClient } from '@/storage/database/supabase-client';

interface ChangePasswordBody {
  current_password?: unknown;
  new_password?: unknown;
}

/** 与注册、登录页 `minLength={8}` 保持一致；GoTrue 自己的下限也是 6-8 位。 */
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };

async function changePassword(request: Request): Promise<Response> {
  const resolved = await resolveRequestUser(request);
  if (!resolved.ok) {
    return jsonError(`unauthorized: ${resolved.error}`, 401);
  }
  const user = resolved.user;

  let body: ChangePasswordBody;
  try {
    body = (await request.json()) as ChangePasswordBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  if (!currentPassword) return jsonError('current_password is required', 400);
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`new_password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  // P0-1：按**用户**限流，而不是按 IP。
  // 校旧密码这一步会打到 GoTrue 的登录接口，是密码爆破面；
  // 按 IP 限流在共用出口 IP 的门店里会误伤同事，按 userId 限流才对准真正的攻击者。
  const limitKey = `auth:change-password:user:${user.userId}`;
  const limit = checkFixedWindow(limitKey, {
    limit: 5,
    windowMs: 15 * 60_000,
    backoff: PASSWORD_BACKOFF,
  });
  if (!limit.ok) return rateLimitResponse(limit);

  // 1) 验证当前密码：用会话里的 email + 提交的旧密码做一次真实登录
  const verify = await signInAndGetToken({ email: user.email, password: currentPassword });
  if (!verify.ok) {
    /**
     * 401 + 机器可读的 code：前端据此把"旧密码错"与"会话失效"分开显示。
     * 两者都是 401，只靠状态码区分不了，用户会以为自己被登出了。
     *
     * 这里刻意不把 GoTrue 的原文透出去（它包含 "Invalid login credentials" 之类
     * 与本次操作无关的措辞），也不放宽成 400 —— 凭据错误就是 401。
     */
    return json(
      { error: 'current password is incorrect', code: 'invalid_current_password' },
      401,
    );
  }

  // 2) 写新密码：admin API + service_role（全新实例，见文件头陷阱 8）
  const { error } = await getFreshServiceClient().auth.admin.updateUserById(user.userId, {
    password: newPassword,
  });
  if (error) {
    // 上游失败必须说出来：静默返回 ok 会让用户以为密码已改，
    // 下一次登录却用旧密码（或新密码根本无效）。
    return jsonError(`update password failed: ${error.message}`, 500);
  }

  // 不改会话 cookie：GoTrue 只作废 refresh token，当前 access token 仍在有效期内，
  // 用户不必"改完密码再登录一次"。其它设备各自的会话到期后自然失效。
  return json({ ok: true });
}

export const POST = protectTenantMutation(
  { permission: 'workforce:self', action: 'auth.change_password', entity: 'users' },
  changePassword,
);
