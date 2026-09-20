import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublicStore } from '@/lib/storefront';
import { RIDER_STATUSES, type RiderStatus } from '@/lib/delivery';
import {
  estimateForDelivery,
  isValidLatitude,
  isValidLongitude,
  latestPositionForDelivery,
  type GeoPoint,
} from '@/lib/delivery-position';

/**
 * 顾客端"骑手在哪 / 大约什么时候到"（公开，凭不透明桌码 token）。
 *
 * ## 边界与 /api/store/menu 完全一致
 *
 * 顾客没有会话，身份由 `?token=` 证明（`resolvePublicStore` 在服务端把 token 换成
 * 租户 + 门店，客户端传来的任何租户/门店字段都不看）。因此本路由必须在网络边界上
 * 就是公开的（`PUBLIC_API_PREFIXES` 里的 `/api/store/deliveries`）。
 *
 * ## 取不到就是 404，**永远不 403**
 *
 * 403 等于回答"这张单存在，只是不归你" —— 任何一个拿着有效 token 的人都能靠
 * 状态码的差异把别人的订单 id 枚举出来。归属判断因此写进 WHERE 条件里
 * （`tenant_id` + `business_id` 都来自 token），查不到一律 404。
 *
 * ## 刻意不返回骑手姓名与电话
 *
 * 顾客需要的是"人在哪"，不是这名员工的身份。位置本身已经是员工位置数据，
 * 再附上姓名/电话就等于把"某个人"和"他的行踪"绑在一起送到顾客手机上并留在
 * 那里 —— 那超出了完成这次配送所必需的信息。响应里只有坐标与时间戳。
 *
 * ## 没有位置就没有位置
 *
 * 骑手还没上报时 `rider: null`；没有目的地坐标时 `estimate: null`（顾客端只显示
 * `promised_at`）。**不回落成店铺坐标、不回落成"上次已知位置"、不编一个距离** ——
 * 此前的原型正是一个 2 秒定时器让标记自己走，看起来像追踪，其实一个真实坐标都没有。
 */

/** 把 jsonb/数值列里可能出现的任意值收敛成合法坐标；不合法就返回 null（并留日志）。 */
function destinationPoint(destLat: unknown, destLng: unknown): GeoPoint | null {
  if (destLat === null || destLat === undefined || destLng === null || destLng === undefined) return null;
  const lat = Number(destLat);
  const lng = Number(destLng);
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    // 有值但不合法，属于脏数据；返回 null 的同时必须留下证据，不能静默吞掉。
    console.warn('[store/deliveries/track] destination coordinates present but invalid; estimate omitted');
    return null;
  }
  return { lat, lng };
}

export async function GET(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const store = await resolvePublicStore(request.nextUrl.searchParams.get('token'));
  if (!store) return NextResponse.json({ error: 'Invalid or inactive store link' }, { status: 404 });

  const { id } = await routeContext.params;
  const deliveryId = typeof id === 'string' ? id.trim() : '';
  // id 形态不对也走 404：400 与 404 的区别本身就能被用来探测 id 形态。
  if (!deliveryId || deliveryId.length > 36) {
    return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('delivery_orders')
    .select('id, rider_status, promised_at, address_line, dest_lat, dest_lng')
    .eq('id', deliveryId)
    .eq('tenant_id', store.tenantId)
    .eq('business_id', store.businessId)
    .maybeSingle();

  if (error) {
    // 公开接口不回显数据库错误：那是内部结构。但必须留服务端日志（no silent fallback）。
    console.error('[store/deliveries/track] delivery lookup failed:', error.message);
    return NextResponse.json({ error: 'tracking is unavailable' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
  }

  const row = data as {
    rider_status: string;
    promised_at: string | null;
    address_line: string;
    dest_lat: string | number | null;
    dest_lng: string | number | null;
  };

  // 状态同样过一遍白名单：库里可能是历史脏值，而这是要展示给顾客的字段。
  const riderStatus: RiderStatus = RIDER_STATUSES.includes(row.rider_status as RiderStatus)
    ? (row.rider_status as RiderStatus)
    : 'pending';
  if (riderStatus !== row.rider_status) {
    console.warn(`[store/deliveries/track] unknown rider_status "${row.rider_status}" for ${deliveryId}; reported as pending`);
  }

  const position = await latestPositionForDelivery(deliveryId, store.tenantId);
  const destination = destinationPoint(row.dest_lat, row.dest_lng);
  const estimate = estimateForDelivery(
    position ? { lat: position.lat, lng: position.lng } : null,
    destination,
  );

  return NextResponse.json({
    rider_status: riderStatus,
    promised_at: row.promised_at,
    destination: { address_line: row.address_line },
    rider: position
      ? {
        lat: position.lat,
        lng: position.lng,
        recorded_at: position.recorded_at,
      }
      : null,
    // estimate 里带 isEstimate: true 与两个系数：UI 必须能看出这是估算值，
    // 而不是实时 GPS 预测。
    estimate,
  });
}
