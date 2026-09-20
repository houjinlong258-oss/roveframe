import { json, jsonError } from '@/lib/api-helpers';
import { isSecureRequest } from '@/lib/auth';
import { clearCustomerSessionHeader, revokeCustomerSession } from '@/lib/customer-auth';

/**
 * POST /api/customer/auth/logout —— 顾客登出。
 *
 * ## 与商家登出的区别
 *
 * `/api/auth/logout`（src/app/api/auth/logout/route.ts）只清 cookie：那边真正的
 * 凭据是 Supabase JWT，服务端没有可撤销的行。顾客会话是**库里的行**，
 * 因此这里必须把 `revoked_at` 写上 —— 只清 cookie 的话，被复制走的 token
 * 在 30 天内仍然有效。
 *
 * ## 幂等
 *
 * 没有 cookie、token 对不上任何行、重复调用：一律 200。登出的语义是
 * "这个浏览器不再是登录态"，它已经是了。
 *
 * ## 写库失败为什么返回 500 而不是"照样清 cookie"
 *
 * 写失败时会话**仍然有效**。此时清 cookie 只会让顾客以为已登出，
 * 而 token 还能用（共享电脑上这是真实风险），并且客户端失去了重试的机会。
 * 因此失败即 500，cookie 保持原样，让调用方重试。
 */
export async function POST(request: Request) {
  const revoked = await revokeCustomerSession(request);
  if (!revoked.ok) {
    console.error('[customer/logout] revoke failed:', revoked.error);
    return jsonError('logout could not be completed', 500);
  }

  const response = json({ ok: true });
  response.headers.set('Set-Cookie', clearCustomerSessionHeader(isSecureRequest(request)));
  return response;
}
