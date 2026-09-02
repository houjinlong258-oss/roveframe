/**
 * POST /api/auth/login
 *
 * Body: { email, password }
 * 返回: { access_token, user_id, tenant_id, business_id, role }
 */
import { json, jsonError } from '@/lib/api-helpers';
import { resolveUserByToken, signInAndGetToken } from '@/lib/auth';

interface LoginBody {
  email: string;
  password: string;
}

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

  const s = await signInAndGetToken({ email, password });
  if (!s.ok) {
    return jsonError(`sign in failed: ${s.error}`, 401);
  }

  const u = await resolveUserByToken(s.data.accessToken);
  if (!u.ok) {
    return jsonError(`resolve user failed: ${u.error}`, 500);
  }

  return json({
    access_token: s.data.accessToken,
    user_id: u.data.userId,
    tenant_id: u.data.tenantId,
    business_id: u.data.businessId,
    role: u.data.role,
    email: u.data.email,
    name: u.data.name,
  });
}
