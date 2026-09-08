/**
 * POST /api/auth/login
 *
 * Body: { email, password }
 * 返回: { access_token, user_id, tenant_id, business_id, role }
 */
import { json, jsonError } from '@/lib/api-helpers';
import { resolveUserByToken, sessionCookieHeader, signInAndGetToken } from '@/lib/auth';
import {
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
} from '@/lib/rate-limit';

interface LoginBody {
  email: string;
  password: string;
}

const AUTH_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };
const ACCOUNT_WINDOW = { limit: 5, windowMs: 15 * 60_000, backoff: AUTH_BACKOFF };
const IP_WINDOW = { limit: 20, windowMs: 15 * 60_000, backoff: AUTH_BACKOFF };

export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const { email, password } = body;
  if (!email || !password) {
    return jsonError('email / password required', 400);
  }

  // P0-1：登录限流 —— 每账号 5 次/15min + 指数退避；每 IP 20 次/15min。
  const emailKey = `auth:login:email:${email.trim().toLowerCase()}`;
  const ipKey = `auth:login:ip:${getClientIp(request)}`;
  const accountLimit = checkFixedWindow(emailKey, ACCOUNT_WINDOW);
  if (!accountLimit.ok) return rateLimitResponse(accountLimit);
  const ipLimit = checkFixedWindow(ipKey, IP_WINDOW);
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);

  const s = await signInAndGetToken({ email, password });
  if (!s.ok) {
    noteFailure(emailKey, AUTH_BACKOFF);
    noteFailure(ipKey, AUTH_BACKOFF);
    return jsonError(`sign in failed: ${s.error}`, 401);
  }
  noteSuccess(emailKey);

  const u = await resolveUserByToken(s.data.accessToken);
  if (!u.ok) {
    return jsonError(`resolve user failed: ${u.error}`, 500);
  }

  const response = json({
    user_id: u.data.userId,
    tenant_id: u.data.tenantId,
    business_id: u.data.businessId,
    role: u.data.role,
    email: u.data.email,
    name: u.data.name,
  });
  response.headers.set('Set-Cookie', sessionCookieHeader(s.data.accessToken));
  return response;
}
