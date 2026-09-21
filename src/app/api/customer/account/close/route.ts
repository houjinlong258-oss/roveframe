import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  clearCustomerSessionHeader,
  resolveCustomerSession,
  revokeCustomerSessions,
} from '@/lib/customer-auth';
import { isSecureRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/customer/account/close —— 顾客注销自己的账号。
 *
 * ===========================================================================
 * 这里**不做**硬删除，而且这是有意的
 * ===========================================================================
 *
 * `customer_accounts` 的行被别的记录引用着：`customer_sessions.account_id`、
 * `customer_addresses.account_id`，以及——更重要的——**订单**。顾客与订单之间
 * 目前是按收货手机号匹配的（src/app/api/customer/orders 的文件头写了为什么），
 * 一旦删掉账号行，那些订单并不会跟着消失，但它们与这个人的关联就断了；
 * 而真要按外键级联清库，就是把订单历史一起毁掉 —— 那是财务与对账记录，
 * 不是顾客的个人数据。
 *
 * 所以本接口只做**状态迁移**：`status = 'pending_deletion'` + 撤销全部会话。
 * 之后：
 *   · 顾客登不进来（`resolveCustomerSession` 只认 `status = 'active'`，
 *     见 src/lib/customer-auth.ts:210；登录路由也有同一道判定）；
 *   · 所有设备立即掉线（撤销的是会话行，不只是清 cookie）。
 *
 * **真正的删除需要一个保留窗口 + 运营动作**（核对未结订单、开票与法定留存期，
 * 再由后台任务或人工真正删行）。本接口不假装"删除已完成"：它返回
 * `status: 'pending_deletion'` 并明确说明数据保留，而不是回一句 `deleted: true`。
 * 说"已删除"而库里还留着，是这类接口最不该有的谎言。
 *
 * ## 顺序：先撤销会话，再改状态
 *
 * 与改密码同一条理由（见 auth/change-password 的文件头）：两个方向里只有一个
 * 是可恢复的。
 *   · 撤销成功、状态写失败 → 用户被登出，账号仍是 active，重新登录再试即可；
 *   · 状态写成功、撤销失败 → "已注销"的账号在别人设备上还能用 30 天。
 * 后者正是这次操作要防的状态，因此不选它。
 *
 * ## 为什么要求请求体显式带 `{ confirm: true }`
 *
 * 注销是不可逆的状态迁移。要求一个显式的确认字段，让"单次误点"在**接口层**
 * 就被挡住（前端的两步确认只是 UI 约定，脚本/误发的请求不该能一次命中）。
 * 缺这个字段返回 400，而不是"宽容地照样执行"。
 *
 * ## 审计是 best-effort，会话行与状态列才是证据
 *
 * 这条操作的可查证性由库自身承担：`status` 列变了、`customer_sessions.revoked_at`
 * 有一批同秒的时间戳。审计写失败只留日志，不让一次已经完成的注销在响应上变成 500
 * （那会诱使用户反复点击，而每一次都只是重复迁移同一个状态）。
 */

/** 与商家侧同一套审计动作命名习惯：`<实体>.<动作>`。 */
const CLOSE_ACTION = 'customer.account.close';

export async function POST(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { confirm?: unknown };
  try {
    body = (await request.json()) as { confirm?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (body.confirm !== true) {
    // 只认显式布尔 true：'true' / 1 一律拒绝（宽松解析会让一次误点变成注销）
    return NextResponse.json(
      { error: 'confirm must be true to close the account', code: 'confirmation_required' },
      { status: 400 },
    );
  }

  // 1) 撤销**全部**会话（包括调用方自己）：keepCurrent=false
  const revoked = await revokeCustomerSessions(request, session.accountId, { keepCurrent: false });
  if (!revoked.ok) {
    console.error('[customer/account/close] session revocation failed:', revoked.error);
    return NextResponse.json({ error: 'account could not be closed' }, { status: 500 });
  }

  // 2) 状态迁移（不删行，见文件头）
  const { data, error } = await getSupabaseClient()
    .from('customer_accounts')
    .update({ status: 'pending_deletion' })
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    // select('id')：0 行的 update 在 supabase-js 里同样是 error=null，
    // 没有它就分不清"迁移了 1 行"与"什么都没改"。
    .select('id');

  if (error) {
    console.error('[customer/account/close] status update failed:', error.message);
    return NextResponse.json({ error: 'account could not be closed' }, { status: 500 });
  }
  if (!data || data.length === 0) {
    console.error('[customer/account/close] status update matched 0 rows');
    return NextResponse.json({ error: 'account could not be closed' }, { status: 500 });
  }

  // 3) 审计：best-effort（理由见文件头）。actorId 是顾客账号 id ——
  //    顾客不进 users 表，这里记的就是他能被追溯到的那一个标识。
  //    必须 await：Next.js 路由里 fire-and-forget 的 Promise 会被丢弃（AGENTS.md 陷阱 13）。
  await writeAudit({
    tenantId: session.tenantId,
    actorId: session.accountId,
    action: CLOSE_ACTION,
    entity: 'customer_accounts',
    entityId: session.accountId,
    after: { business_id: session.businessId, status: 'pending_deletion', revoked_sessions: revoked.revoked },
  });

  const response = NextResponse.json({
    ok: true,
    status: 'pending_deletion',
    revoked_sessions: revoked.revoked,
    // 明确说清楚"接下来会发生什么"，而不是回一句 deleted: true（见文件头）。
    deletion: {
      completed: false,
      note: 'orders and records that reference this account are retained; final deletion runs after the retention window',
    },
  });
  // 会话已经被撤销，cookie 留着只会让浏览器继续相信自己处于登录态。
  response.headers.set('Set-Cookie', clearCustomerSessionHeader(isSecureRequest(request)));
  return response;
}
