/**
 * POST /api/auth/signup
 *
 * Body: { email, password, business_name, industry, language?, currency? }
 * 流程: auth.admin.createUser → 建 tenant → 建 business → 建 public.users → 返 access_token
 */
import { json, jsonError } from '@/lib/api-helpers';
import {
  createAuthUserWithTenant,
  createBusinessRow,
  createPublicUserRow,
  createTenantRow,
  signInAndGetToken,
} from '@/lib/auth';

interface SignupBody {
  email: string;
  password: string;
  business_name: string;
  industry: string;
  language?: string;
  currency?: string;
  name?: string;
}

export async function POST(request: Request) {
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const { email, password, business_name, industry } = body;
  if (!email || !password || !business_name || !industry) {
    return jsonError('email / password / business_name / industry required', 400);
  }
  if (password.length < 8) {
    return jsonError('password must be at least 8 characters', 400);
  }

  // 1) 建 tenant
  const t = await createTenantRow({ name: business_name });
  if (!t.ok) {
    return jsonError(`create tenant failed: ${t.error}`, 500);
  }

  // 2) 建 business
  const b = await createBusinessRow({
    tenantId: t.data.tenantId,
    name: business_name,
    industry,
    language: body.language,
    currency: body.currency,
  });
  if (!b.ok) {
    return jsonError(`create business failed: ${b.error}`, 500);
  }

  // 3) 建 auth user + 注入 tenant claim
  const a = await createAuthUserWithTenant({
    email,
    password,
    tenantId: t.data.tenantId,
    businessId: b.data.businessId,
    name: body.name,
  });
  if (!a.ok) {
    return jsonError(`create auth user failed: ${a.error}`, 500);
  }

  // 4) 建 public.users 关联行
  const u = await createPublicUserRow({
    id: a.data.userId,
    tenantId: t.data.tenantId,
    businessId: b.data.businessId,
    email,
    name: body.name,
    role: 'owner',
  });
  if (!u.ok) {
    return jsonError(`create public.users failed: ${u.error}`, 500);
  }

  // 5) 登录取 access_token
  const s = await signInAndGetToken({ email, password });
  if (!s.ok) {
    return jsonError(`sign in failed: ${s.error}`, 500);
  }

  return json(
    {
      access_token: s.data.accessToken,
      user_id: s.data.userId,
      tenant_id: t.data.tenantId,
      business_id: b.data.businessId,
      role: 'owner',
    },
    201,
  );
}
