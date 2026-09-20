import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { resolveStaffForUser } from '@/lib/workforce';
import {
  isValidAccuracyM,
  isValidLatitude,
  isValidLongitude,
  recordDeliveryPosition,
} from '@/lib/delivery-position';

/**
 * 骑手设备上报一次位置（员工端在配送中主动调用）。
 *
 * ## 这个接口是"位置采集"的唯一入口，因此边界写在这里
 *
 * 位置是**员工位置数据**。落地与否不由客户端说了算：
 *   · 中央守卫 `delivery:claim` 只回答"允许接单"；
 *   · `resolveStaffForUser` 把会话换成**员工档案 id**（权限矩阵不回答"这一单归谁"）；
 *   · 真正决定能不能写的是 `recordDeliveryPosition` 的 WHERE 条件
 *     （`rider_staff_id = 会话解析出的 staff id` 且 `rider_status ∈ {claimed, picked_up}`）。
 *
 * 三层职责不重叠：任何一个客户端传入的身份字段都不参与判定。
 *
 * ## 为什么坐标在这里就要挡掉 NaN
 *
 * 一个静默存进库的 NaN 会让**之后每一次**距离计算都是 NaN，而 NaN 不触发任何
 * 分支、也不报错 —— 顾客端表现为"地图空白但接口 200"，无从排查。因此 lat/lng
 * 只接受 JSON number 且在范围内，其余一律 400。
 *
 * ## 失败语义
 *
 *   400 坐标非法           → 员工端应修客户端逻辑，重试没意义
 *   404 单不存在           → 刷新整个列表
 *   409 not_active         → 单子不是他的、或已经结束，**停止上报**并刷新卡片
 *
 * 409 而不是 403：员工端在"这不是你的单"与"这单已结束"两种情况下要做的事完全
 * 相同（停止上报 + 刷新），且两者都只是"此刻不该再写位置"。具体的细分原因写进
 * 服务端日志，供排查用。
 */
async function positionHandler(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
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

  const { id } = await routeContext.params;
  const deliveryId = typeof id === 'string' ? id.trim() : '';
  if (!deliveryId || deliveryId.length > 36) {
    return NextResponse.json({ error: 'invalid delivery id' }, { status: 400 });
  }

  let body: { lat?: unknown; lng?: unknown; accuracy_m?: unknown };
  try {
    body = (await request.json()) as { lat?: unknown; lng?: unknown; accuracy_m?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 只接受 JSON number。字符串数字（"12.3"）一律拒绝：一旦开始"尽力解析"，
  // 就得决定 "12abc" 怎么办，而那条路上最后总会有一个 NaN 溜进数据库。
  const lat = body.lat;
  const lng = body.lng;
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    return NextResponse.json(
      {
        error: 'lat must be a finite number within [-90,90] and lng within [-180,180]',
        code: 'invalid_coordinates',
      },
      { status: 400 },
    );
  }

  const accuracy = body.accuracy_m;
  if (!isValidAccuracyM(accuracy)) {
    return NextResponse.json(
      { error: 'accuracy_m must be a finite non-negative number of metres', code: 'invalid_accuracy_m' },
      { status: 400 },
    );
  }

  try {
    const outcome = await recordDeliveryPosition(
      context.tenantId,
      context.businessId,
      resolved.staff.staffId,
      deliveryId,
      { lat, lng, accuracyM: typeof accuracy === 'number' ? accuracy : null },
    );

    if (outcome.ok) {
      return NextResponse.json({ ok: true, recorded_at: outcome.recordedAt });
    }

    switch (outcome.reason) {
      case 'invalid_coordinates':
        // 路由已挡过一遍；走到这里说明两层校验的口径不一致，必须看得见。
        console.error('[staff/deliveries/position] lib rejected coordinates the route accepted');
        return NextResponse.json({ error: 'invalid coordinates', code: 'invalid_coordinates' }, { status: 400 });
      case 'not_found':
        return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
      default:
        console.warn(
          `[staff/deliveries/position] refused: delivery=${deliveryId} staff=${resolved.staff.staffId} reason=${outcome.reason}`,
        );
        return NextResponse.json(
          { error: 'this delivery is not active for you', code: 'not_active' },
          { status: 409 },
        );
    }
  } catch (error) {
    console.error('[staff/deliveries/position] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'position report failed' }, { status: 500 });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'delivery:claim', action: 'delivery.position', entity: 'delivery_positions' },
  positionHandler,
);
