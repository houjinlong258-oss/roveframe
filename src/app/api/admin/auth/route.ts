import { NextResponse } from 'next/server';
import {
  loginPlatformAdmin,
  logoutPlatformAdmin,
  resolvePlatformAdmin,
  writePlatformAudit,
  PLATFORM_ADMIN_COOKIE,
} from '@/lib/platform-admin';
import {
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
} from '@/lib/rate-limit';

const ADMIN_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };

/** POST /api/admin/auth/login — 平台管理员独立登录（商户账号无效） */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 });
  }

  // P0-1：平台管理员登录限流 —— 每账号 5 次/15min + 指数退避；每 IP 10 次/15min。
  const emailKey = `admin:auth:email:${email.toLowerCase()}`;
  const ipKey = `admin:auth:ip:${getClientIp(request)}`;
  const accountLimit = checkFixedWindow(emailKey, {
    limit: 5,
    windowMs: 15 * 60_000,
    backoff: ADMIN_BACKOFF,
  });
  if (!accountLimit.ok) return rateLimitResponse(accountLimit);
  const ipLimit = checkFixedWindow(ipKey, {
    limit: 10,
    windowMs: 15 * 60_000,
    backoff: ADMIN_BACKOFF,
  });
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);

  const result = await loginPlatformAdmin(email, password);
  if (!result) {
    noteFailure(emailKey, ADMIN_BACKOFF);
    noteFailure(ipKey, ADMIN_BACKOFF);
    await writePlatformAudit({
      adminId: null,
      action: 'admin.auth.login_failed',
      summary: { emailDomain: email.split('@')[1] ?? 'unknown' },
    });
    return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
  }
  noteSuccess(emailKey);

  await writePlatformAudit({ adminId: result.admin.adminId, action: 'admin.auth.login' });
  const response = NextResponse.json({
    ok: true,
    admin: { email: result.admin.email, role: result.admin.role },
  });
  response.cookies.set(PLATFORM_ADMIN_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  return response;
}

/** GET /api/admin/auth/login — 当前会话信息（用于后台壳层判断登录态） */
export async function GET(request: Request) {
  const ctx = await resolvePlatformAdmin(request);
  if (!ctx) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, admin: { email: ctx.email, role: ctx.role } });
}

/** DELETE /api/admin/auth/login — 登出并撤销会话 */
export async function DELETE(request: Request) {
  const ctx = await resolvePlatformAdmin(request);
  if (ctx) {
    await logoutPlatformAdmin(ctx);
    await writePlatformAudit({ adminId: ctx.adminId, action: 'admin.auth.logout' });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PLATFORM_ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return response;
}
