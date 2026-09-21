import { NextRequest, NextResponse } from 'next/server';
import { staffRequestContext } from '@/lib/workforce';
import { listMyDeliveries, listPendingDeliveries } from '@/lib/delivery';
import { requireStaffFeature } from '@/lib/staff-access';

/**
 * 员工端派单列表：待接单 + 我配送中的。
 *
 * 一次返回两个分组而不是两个接口：员工端首屏要同时显示两者，
 * 分两次请求会出现"待接单已更新、我的一单还是旧的"这种不一致画面。
 *
 * 待接单是**本店全部 pending**（谁都能接），我的是**rider_staff_id = 我**。
 * 两者都由服务端按会话过滤，不接受任何客户端筛选参数。
 *
 * ## 商家开关（第三个轴，与 RBAC 无关）
 *
 * 不做外卖的店由老板在 `/api/team/staff-access` 关掉 `delivery`。那时本接口
 * 返回 **403 + code: 'feature_disabled'**，而**不是** `{ pending: [], mine: [] }`：
 * 空列表会让员工以为"今天没有单"，一直守着；明确的状态码才能让界面上说
 * "这家店没有开启外卖派单"。判定在 RBAC（workforce:self）之后 ——
 * 先回答"你能不能看"，再回答"这家店开不开"。
 */
export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, staffId } = resolved.ctx;

  const gate = await requireStaffFeature(tenantId, businessId, 'delivery');
  if (gate) return gate;

  try {
    const [pending, mine] = await Promise.all([
      listPendingDeliveries(tenantId, businessId),
      listMyDeliveries(tenantId, businessId, staffId),
    ]);
    return NextResponse.json({ pending, mine });
  } catch (error) {
    console.error('[staff/deliveries] list failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'could not load deliveries' }, { status: 500 });
  }
}
