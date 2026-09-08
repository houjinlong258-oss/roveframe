/**
 * GET /api/auth/me
 *
 * Header: Authorization: Bearer <access_token>
 * 返回: { user_id, email, tenant_id, business_id, role, name }
 */
import { errorResponse, json } from '@/lib/api-helpers';
import { resolveUserByRequest } from '@/lib/auth';

export async function GET(request: Request) {
  const u = await resolveUserByRequest(request);
  if (!u.ok) return errorResponse(new Error(`unauthorized: ${u.error}`), 401);

  return json({
    user_id: u.data.userId,
    email: u.data.email,
    tenant_id: u.data.tenantId,
    business_id: u.data.businessId,
    role: u.data.role,
    name: u.data.name,
  });
}
