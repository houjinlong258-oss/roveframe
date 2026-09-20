import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { resolveStaffForUser } from '@/lib/workforce';
import { claimDeliveryOrder } from '@/lib/delivery';

/**
 * 认领一张外卖单。**这一个接口是全案最容易写错的地方。**
 *
 * ## 为什么必须是单条原子 UPDATE
 *
 * 两个员工同时点"接单"，正确的结局是恰好一个成功。实现方式是：
 *
 *     UPDATE delivery_orders SET rider_staff_id = 我, rider_status = 'claimed'
 *      WHERE id = ? AND tenant_id = ? AND business_id = ?
 *        AND rider_status = 'pending'
 *      RETURNING id
 *
 * 靠**返回行数**判断成败。写成"先 SELECT 看是不是 pending，再 UPDATE"，
 * 中间那段时间就是两个人接到同一单的原因 —— 而且是偶发的，
 * 测试环境几乎复现不出来。仓库里 `claim_agent_task_runs` 修过一次同类竞态
 * （scripts/migrate.sql），这里是同一个模式。
 *
 * ## 三层边界，各管一件事
 *
 *   1. `protectBusinessMutation`（中央守卫）：会话 + 租户作用域 + `delivery:claim`
 *      权限 + 审计（"谁在什么时候接了哪一单"本来就应该可查）
 *   2. `resolveStaffForUser`：会话 → **员工档案 id**。查不到即 409，
 *      不是 200 + 空对象 —— "账号有效但没有员工档案"必须有可执行的提示
 *   3. `claimDeliveryOrder` 的 WHERE 条件：这一单此刻是否还能被接
 *
 * 三者的职责不重叠：权限矩阵回答"是否允许接单"，但它**不**回答"这一单归谁"。
 */
async function claimHandler(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  const resolved = await resolveStaffForUser(context.tenantId, context.businessId, context.userId);
  if (!resolved.ok) {
    if (resolved.reason === 'error') {
      return NextResponse.json({ error: 'staff lookup failed' }, { status: 500 });
    }
    return NextResponse.json(
      {
        error: resolved.reason === 'inactive'
          ? 'your staff profile is no longer active'
          : 'your account is not linked to a staff profile',
        code: resolved.reason === 'inactive' ? 'staff_inactive' : 'staff_not_linked',
      },
      { status: 409 },
    );
  }

  let body: { delivery_id?: unknown };
  try {
    body = (await request.json()) as { delivery_id?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const deliveryId = typeof body.delivery_id === 'string' ? body.delivery_id.trim() : '';
  if (!deliveryId || deliveryId.length > 36) {
    return NextResponse.json({ error: 'delivery_id is required' }, { status: 400 });
  }

  try {
    const outcome = await claimDeliveryOrder(
      context.tenantId, context.businessId, resolved.staff.staffId, deliveryId,
    );
    if (outcome.ok) {
      return NextResponse.json({ ok: true, delivery_id: deliveryId, rider_status: 'claimed' });
    }
    if (outcome.reason === 'not_found') {
      return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
    }
    // 409 而不是 500：这不是故障，是正常的竞争结果。
    // 员工端应把这张卡片移出"待接单"并提示"已被同事接走"。
    return NextResponse.json(
      { error: 'already claimed by someone else', code: 'already_claimed' },
      { status: 409 },
    );
  } catch (error) {
    console.error('[staff/deliveries/claim] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'claim failed' }, { status: 500 });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'delivery:claim', action: 'delivery.claim', entity: 'delivery_orders' },
  claimHandler,
);
