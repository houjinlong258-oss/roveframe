import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession } from '@/lib/customer-auth';

/**
 * GET /api/customer/me —— 当前顾客账号。
 *
 * 三个条件（id + tenant_id + business_id）都要带上：会话本身已经锁定了租户，
 * 但把租户条件写进查询是纵深防御 —— 会话行与账号行万一不一致（比如账号被
 * 移到别的商家），这里必须查不到，而不是把另一个商家的账号资料返回出去。
 *
 * 只返回 id/email/phone/display_name/locale/marketing_opt_in：
 * password_hash 与 password_salt **永远不出现在任何响应里**。
 */
export async function GET(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const { data, error } = await getSupabaseClient()
    .from('customer_accounts')
    .select('id, email, phone, display_name, locale, marketing_opt_in')
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();

  if (error) {
    console.error('[customer/me] account lookup failed:', error.message);
    return jsonError('account could not be loaded', 500);
  }
  // 会话有效但账号行不在/不在本租户：按未登录处理（不泄漏"这个 id 存在"）
  if (!data) return jsonError('unauthorized', 401);

  const account = data as {
    id: string;
    email: string | null;
    phone: string | null;
    display_name: string | null;
    locale: string;
    marketing_opt_in: boolean;
  };

  return json({
    account: {
      id: account.id,
      email: account.email,
      phone: account.phone,
      display_name: account.display_name,
      locale: account.locale,
      marketing_opt_in: account.marketing_opt_in,
    },
  });
}
