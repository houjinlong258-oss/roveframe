import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';
import type { RiderStatus } from '@/lib/delivery';

/**
 * 骑手位置上报与 ETA 估算（Phase 18 / P18-10）。
 *
 * ## 隐私硬规则（本模块的边界，改这里的代码之前先读完这一段）
 *
 * 位置数据是**员工位置数据**，不是商家业务数据。因此本模块只允许下面这条链路：
 *
 *   1. **只在骑手手上有他本人已认领、且仍在进行中（claimed / picked_up）的配送单时采集。**
 *      单子不存在、不是他的、或已经 delivered / cancelled，`recordDeliveryPosition`
 *      一律拒绝写入 —— 一张进行中的单之外的位置行，是我们没有任何理由持有的
 *      员工位置数据。
 *   2. **只接受骑手本人设备的一次次显式上报**（员工端在配送中主动 POST 一次，
 *      就写一行）。本模块**不做任何后台追踪**：没有定时器、没有轮询、没有
 *      "打开 App 就持续上报"。设备不来消息，这里就永远没有新行。
 *   3. **空闲即清理**：单子结束、上报停止之后，位置行由保留期任务
 *      （`purgeOldPositions`，默认 24 小时，可用
 *      `settings.delivery.positionRetentionHours` 覆盖）删除，不做长期留存。
 *
 * ## 为什么 ETA 必须自带 `isEstimate: true`
 *
 * 这个项目没有路网数据、没有实时路况、也没有地理编码。ETA 只能用
 * "球面直线距离 × 道路系数 ÷ 平均车速"推出来，其误差量级远大于分钟级。
 * 返回对象里连同 `roadFactor` / `averageSpeedKmh` 一起带上 `isEstimate: true`，
 * 是为了让 UI **无法**把它当成"实时 GPS 预测"呈现 —— 此前的原型用一个
 * 2 秒定时器让标记在图上自己走，就是这么骗过评审的：看起来像定位，其实
 * 一个真实坐标都没有。
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** 地球平均半径（IUGG 平均球半径），单位 km。 */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * 球面两点大圆距离（haversine）。纯函数，不碰数据库、不读环境。
 *
 * 用球面公式而不是平面近似：跨纬度的直线近似在城市尺度上也会偏出几百米，
 * 而这几百米正是"骑手到了没有"的判断依据。
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // min(1, ...) 挡浮点误差：对跖点附近 h 会算到 1.0000000000000002，
  // asin 收到 >1 会得到 NaN，而 NaN 会沿着整条链路传染下去。
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 坐标白名单。
 *
 * 显式挡掉 NaN / Infinity：一个静默存进库的 NaN 会让之后**每一次**距离计算
 * 都是 NaN，而 NaN 既不等于自己也不会触发任何分支 —— 症状表现为"地图上什么都
 * 没有、也没有任何报错"。宁可在入口返回 400。
 */
export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return isValidLatitude(lat) && isValidLongitude(lng);
}

/** 精度半径（米）：可选字段，给了就必须是有限的非负数。 */
export function isValidAccuracyM(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1_000_000;
}

export const DEFAULT_ROAD_FACTOR = 1.35;
export const DEFAULT_AVERAGE_SPEED_KMH = 22;

export interface EtaOptions {
  /** 道路系数：直线距离换算成道路里程的倍数。默认 1.35。 */
  roadFactor?: number;
  /** 平均车速 km/h（含取餐/等灯/找门牌的摊薄）。默认 22。 */
  averageSpeedKmh?: number;
}

/**
 * ETA 估算结果。
 *
 * `isEstimate: true` 是**字面量类型**而不是 boolean：任何构造这个对象的地方
 * 都必须显式写下它，UI 侧也能据此断言"这不是实时 GPS 预测"。
 */
export interface EtaEstimate {
  etaMinutes: number;
  distanceKm: number;
  roadFactor: number;
  averageSpeedKmh: number;
  isEstimate: true;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 由距离估算送达时间。**这是估算，不是预测**（返回值里带 `isEstimate: true`）。
 *
 * 距离为 NaN / 负数时**抛错**，不返回一个看起来正常的分钟数：那种"数字对不上
 * 却一路绿"的结果，比一个明确的异常难查得多（no silent fallbacks）。
 */
export function estimateEtaMinutes(distanceKm: number, opts: EtaOptions = {}): EtaEstimate {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new Error(
      `estimateEtaMinutes: distanceKm must be a finite non-negative number, got ${String(distanceKm)}`,
    );
  }
  const roadFactor = positiveOr(opts.roadFactor, DEFAULT_ROAD_FACTOR);
  const averageSpeedKmh = positiveOr(opts.averageSpeedKmh, DEFAULT_AVERAGE_SPEED_KMH);

  const rawMinutes = ((distanceKm * roadFactor) / averageSpeedKmh) * 60;
  // 非零距离至少给 1 分钟：四舍五入到 0 会让顾客看到"0 分钟送达"，
  // 那是一个不可能兑现、也无法解释的承诺。距离恰好为 0 时 0 分钟是如实的。
  const etaMinutes = distanceKm === 0 ? 0 : Math.max(1, Math.round(rawMinutes));

  return { etaMinutes, distanceKm, roadFactor, averageSpeedKmh, isEstimate: true };
}

/**
 * 由"骑手当前位置 + 本单目的地坐标"得到 ETA；任一端缺失就返回 null。
 *
 * 返回 null 是**正确答案**，不是"降级"：没有目的地坐标时算出来的距离是
 * "到某个点"的距离，不是"到这位顾客"的距离，把它当成 ETA 展示就是在编。
 * 此时顾客端只显示 promised_at。
 */
export function estimateForDelivery(
  position: GeoPoint | null,
  destination: GeoPoint | null,
): EtaEstimate | null {
  if (!position || !destination) return null;
  if (!isValidLatLng(position.lat, position.lng)) return null;
  if (!isValidLatLng(destination.lat, destination.lng)) return null;
  return estimateEtaMinutes(haversineKm(position, destination));
}

/** 骑手可以继续上报位置的状态。除此之外（pending / delivered / cancelled）一律拒绝。 */
const ACTIVE_RIDER_STATUSES: readonly RiderStatus[] = ['claimed', 'picked_up'];

export interface DeliveryPositionInput {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export interface DeliveryPositionRow {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  recorded_at: string;
}

export type RecordPositionOutcome =
  | { ok: true; recordedAt: string }
  | { ok: false; reason: 'invalid_coordinates' | 'not_found' | 'not_mine' | 'not_active' };

/**
 * 落一行骑手位置。
 *
 * ## 为什么必须**先**验所有权与活跃状态，再插入
 *
 * 位置行脱离"进行中的配送单"之后，就只剩下一个含义：**这名员工此刻在哪**。
 * 我们没有收集它的任何理由，而且一旦落库，它就和其他业务数据一样长期留存、
 * 出现在备份里。因此判断在写入**之前**做：单子不是他的、或已经结束，
 * 直接返回失败，一行都不写。
 *
 * ## 为什么不用"先查再写"就担心竞态
 *
 * 这里与认单（`claimDeliveryOrder`）不同：认单的竞态会让两个员工接到同一单，
 * 是有害的；而这里最坏情况是"单子在读与写之间刚好被送达"，于是多出一行
 * 属于已结束单的位置 —— 它会被保留期任务删掉，且不含任何越权信息。
 * 相比之下，把位置写到**别人的单**上才是真问题，而那由
 * `rider_staff_id = staffId` 这个过滤条件挡住：客户端传什么 id 都不看。
 */
export async function recordDeliveryPosition(
  tenantId: string,
  businessId: string,
  staffId: string,
  deliveryId: string,
  input: DeliveryPositionInput,
): Promise<RecordPositionOutcome> {
  if (!isValidLatLng(input.lat, input.lng)) return { ok: false, reason: 'invalid_coordinates' };

  const client = getSupabaseClient();

  const { data: owned, error: readError } = await client
    .from('delivery_orders')
    .select('id')
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('rider_staff_id', staffId)
    .in('rider_status', [...ACTIVE_RIDER_STATUSES])
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  if (!owned) {
    // 查不到要区分原因：员工端据此决定"刷新列表"还是"提示这不是你的单"。
    const { data: existing, error: existingError } = await client
      .from('delivery_orders')
      .select('id, rider_staff_id')
      .eq('id', deliveryId)
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (!existing) return { ok: false, reason: 'not_found' };
    const row = existing as { rider_staff_id: string | null };
    return { ok: false, reason: row.rider_staff_id === staffId ? 'not_active' : 'not_mine' };
  }

  // 时间由服务端定，不取客户端时钟：客户端时间可以任意伪造，
  // 而 recorded_at 既是保留期的依据，也是"这条位置有多旧"的唯一证据。
  const now = new Date().toISOString();
  const { error: insertError } = await client
    .from('delivery_positions')
    .insert({
      tenant_id: tenantId,
      business_id: businessId,
      delivery_id: deliveryId,
      staff_id: staffId,
      lat: input.lat,
      lng: input.lng,
      accuracy_m: input.accuracyM ?? null,
      recorded_at: now,
    });
  if (insertError) throw new Error(insertError.message);

  return { ok: true, recordedAt: now };
}

/**
 * 某单的最新一条位置。没有就是 null —— 不回落成"上次已知位置"，
 * 更不回落成店铺坐标：那两件事都会让顾客看到一个**并不存在**的骑手位置。
 */
export async function latestPositionForDelivery(
  deliveryId: string,
  tenantId: string,
): Promise<DeliveryPositionRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('delivery_positions')
    .select('lat, lng, accuracy_m, recorded_at')
    .eq('delivery_id', deliveryId)
    .eq('tenant_id', tenantId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as {
    lat: string | number;
    lng: string | number;
    accuracy_m: string | number | null;
    recorded_at: string;
  };
  return {
    // numeric 列经 PostgREST 回来是字符串，必须显式转 —— 直接参与算术会得到
    // 字符串拼接（"12.9" * 2 之类），而那是静默的错误结果。
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracy_m: row.accuracy_m === null ? null : Number(row.accuracy_m),
    recorded_at: row.recorded_at,
  };
}

/** 默认保留 24 小时。位置是员工位置数据，不是经营档案。 */
export const DEFAULT_POSITION_RETENTION_HOURS = 24;
const MIN_RETENTION_HOURS = 1;
const MAX_RETENTION_HOURS = 24 * 30;

/**
 * 把 `settings.delivery.positionRetentionHours` 这种 jsonb 值收敛成合法小时数。
 * 与 `normalizeDeliveryRules` 同一纪律：jsonb 里可能是任何东西，绝不直接当数字用。
 */
export function normalizeRetentionHours(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POSITION_RETENTION_HOURS;
  return Math.min(MAX_RETENTION_HOURS, Math.max(MIN_RETENTION_HOURS, parsed));
}

/**
 * 删除超过保留期的位置行，返回删除条数。
 *
 * 保留期取 `settings.delivery.positionRetentionHours`，缺省 24 小时；显式传参时
 * 以传参为准（测试与手工清理用）。刻意做成**单条 DELETE**：调度器每个 tick 都会
 * 调用它，任何"先查 id 再逐条删"的写法都会把一次清理变成 N 次往返。
 */
export async function purgeOldPositions(
  tenantId: string,
  businessId: string,
  retentionHours?: number,
): Promise<number> {
  let hours: number;
  if (retentionHours === undefined) {
    const settings = await getSettings(tenantId, businessId);
    const delivery = (settings.delivery ?? {}) as Record<string, unknown>;
    hours = normalizeRetentionHours(delivery.positionRetentionHours);
  } else {
    hours = normalizeRetentionHours(retentionHours);
  }

  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await getSupabaseClient()
    .from('delivery_positions')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .lt('recorded_at', cutoff)
    .select('id');
  if (error) throw new Error(error.message);

  return (data ?? []).length;
}
