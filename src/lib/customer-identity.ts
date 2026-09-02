import { cookies } from 'next/headers';

/**
 * Customer Identity (PWA Sprint 2 - C-PWA-2.2)
 *
 * V1 设计: 用 cookie 持 device_id(UUID v4),无账号体系。
 * - 不追踪 IP / UA 等指纹(隐私友好,符合 GDPR / CCPA)
 * - 用户清 cookie → 新 device_id → 收藏丢失(可接受,无账号)
 * - V2 加 customer 注册后,这里升级为 user_id 优先 + device_id fallback
 *
 * 调用模式:
 *   const id = getDeviceId();  // Server Component / API route
 *   const cookie = setDeviceIdCookieHeader(id);  // API 响应 Set-Cookie
 */

const COOKIE_NAME = 'roveframe_device_id';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 年

/**
 * 从 request cookie 读 device_id
 * 没有则生成新的 UUID v4 并设 cookie
 */
export async function getDeviceId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE_NAME);
  if (existing?.value) return existing.value;
  const fresh = crypto.randomUUID();
  store.set(COOKIE_NAME, fresh, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  return fresh;
}

/**
 * 从 NextRequest(API route) 读 device_id,无则 null(调用方决定是否 set)
 * 用于 /api/customer/* 路由
 */
export function getDeviceIdFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** API 响应 Set-Cookie 头(V1 没用,留接口给 V2 cookie rotate) */
export function setDeviceIdCookieHeader(deviceId: string): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `${COOKIE_NAME}=${deviceId}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax;${secure}`;
}
