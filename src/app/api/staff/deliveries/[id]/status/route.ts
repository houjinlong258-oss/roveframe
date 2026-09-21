import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { resolveStaffForUser } from '@/lib/workforce';
import { advanceDeliveryStatus, RIDER_STATUSES, type RiderStatus } from '@/lib/delivery';
import { requireStaffFeature } from '@/lib/staff-access';

/**
 * 骑手推进自己那一单：已取餐 / 已送达。
 *
 * ## 三种失败必须区分，因为 UI 处置完全不同
 *
 *   404 单不存在        → 刷新整个列表
 *   403 不是我的单      → 提示无权限（**不要**跳登录，会让人以为自己没登录）
 *   409 状态不允许这样跳 → 刷新这一张卡片
 *
 * 「是不是我的单」由 `advanceDeliveryStatus` 的 WHERE 条件判定
 * （`rider_staff_id = 会话解析出的 staff id`），**不看客户端传的任何身份字段**。
 * 中央守卫里的 `delivery:claim` 只回答"允许接单"，不回答"这一单归谁" ——
 * 权限矩阵与所有权是两回事，混在一起就会写出"任何员工能推进任何单"。
 *
 * ## 还有一层：商家开关（`delivery`）
 *
 * 不做外卖的店由老板关掉这个面（src/lib/staff-access.ts），推进状态一律
 * 403 + `feature_disabled`。它与 RBAC 是两条轴：RBAC 说"这个角色能不能送外卖"，
 * 开关说"这家店做不做外卖"。
 */
async function statusHandler(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const context = requireBusinessContext(await getTenantContext(request));

  const gate = await requireStaffFeature(context.tenantId, context.businessId, 'delivery');
  if (gate) return gate;

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

  const { id } = await routeContext.params;
  const deliveryId = typeof id === 'string' ? id.trim() : '';
  if (!deliveryId || deliveryId.length > 36) {
    return NextResponse.json({ error: 'invalid delivery id' }, { status: 400 });
  }

  let body: { status?: unknown };
  try {
    body = (await request.json()) as { status?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const next = typeof body.status === 'string' ? body.status.trim() : '';
  // 只接受骑手能自己推进的两个状态。`cancelled` 不在此列 —— 取消是管理动作，
  // 不能让骑手随手把单取消掉。
  if (next !== 'picked_up' && next !== 'delivered') {
    return NextResponse.json(
      { error: 'status must be picked_up or delivered', allowed: ['picked_up', 'delivered'] },
      { status: 400 },
    );
  }
  if (!RIDER_STATUSES.includes(next as RiderStatus)) {
    return NextResponse.json({ error: 'unknown status' }, { status: 400 });
  }

  try {
    const outcome = await advanceDeliveryStatus(
      context.tenantId, context.businessId, resolved.staff.staffId, deliveryId, next as RiderStatus,
    );
    if (outcome.ok) {
      return NextResponse.json({ ok: true, rider_status: outcome.riderStatus });
    }
    switch (outcome.reason) {
      case 'not_found':
        return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
      case 'not_mine':
        return NextResponse.json({ error: 'this delivery is not assigned to you' }, { status: 403 });
      case 'already_settled':
        return NextResponse.json(
          { error: 'this delivery is already finished', code: 'already_settled' },
          { status: 409 },
        );
      default:
        return NextResponse.json(
          { error: 'the delivery is not in a state that allows this change', code: 'invalid_transition' },
          { status: 409 },
        );
    }
  } catch (error) {
    console.error('[staff/deliveries/status] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'status update failed' }, { status: 500 });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'delivery:claim', action: 'delivery.status', entity: 'delivery_orders' },
  statusHandler,
);
