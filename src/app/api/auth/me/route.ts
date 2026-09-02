/**
 * GET /api/auth/me
 *
 * Header: Authorization: Bearer <access_token>
 * 返回: { user_id, email, tenant_id, business_id, role, name }
 */
import { json, jsonError } from '@/lib/api-helpers';
import { resolveUserByToken } from '@/lib/auth';

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  if (!auth) {
    return jsonError('missing Authorization header', 401);
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonError('invalid Authorization header', 401);
  }

  const u = await resolveUserByToken(token);
  if (!u.ok) {
    return jsonError(`unauthorized: ${u.error}`, 401);
  }

  return json({
    user_id: u.data.userId,
    email: u.data.email,
    tenant_id: u.data.tenantId,
    business_id: u.data.businessId,
    role: u.data.role,
    name: u.data.name,
  });
}
