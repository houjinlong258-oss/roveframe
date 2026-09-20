import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';

/**
 * 外卖配送的后端核心（Phase 18 / P18-4 · P18-5）。
 *
 * ## 这个文件负责三件事
 *
 * 1. **配送规则的归一化**：规则存在 `settings.delivery` 这个 jsonb 里，由老板端
 *    写入。jsonb 意味着里面可能是任何东西（缺字段、字符串当数字、超范围）。
 *    所有读取都必须经过 `normalizeDeliveryRules`，绝不直接把 jsonb 当作已校验数据。
 *
 * 2. **计价**：配送费与起送判定。**服务端算，客户端传什么都不看** ——
 *    与堂食下单同一条纪律（`src/app/api/store/orders/route.ts:145-156`）。
 *
 * 3. **状态机的原子推进**：认领与状态跃迁都是单条 `UPDATE ... WHERE`，
 *    靠返回行数判断成败。**不做"先查再改"** —— 那中间的窗口就是两个员工
 *    接到同一单的原因。仓库里 `claim_agent_task_runs` 修过一次同类竞态
 *    （scripts/migrate.sql），这里是同一个模式。
 *
 * ## 刻意不做的事
 *
 * 配送状态推进**不改 `orders.status`**。原因：本项目没有关于订单状态机取值集合的
 * 权威证据（`orders.status` 是自由 varchar，仪表盘只排除 'cancelled'）。
 * 凭空写入 'ready' / 'completed' 之类的值，会让经营报表出现无法解释的分类。
 * 因此外卖只推进自己的 `rider_status`；把两者对齐是另一个需要先定死状态集合的改动。
 */

export interface DeliveryRules {
  enabled: boolean;
  /** 起送价 */
  minOrderAmount: number;
  /** 配送费 */
  fee: number;
  /** 满此金额免配送费；null 表示不免 */
  freeDeliveryAbove: number | null;
  /** 备餐分钟数，用于计算承诺送达时间 */
  prepMinutes: number;
}

export const DEFAULT_DELIVERY_RULES: DeliveryRules = {
  // 默认**关闭**：外卖需要老板显式开启并配置配送费，默认开启会让所有商家
  // 凭空多出一个自己没定价的配送通道。
  enabled: false,
  minOrderAmount: 0,
  fee: 0,
  freeDeliveryAbove: null,
  prepMinutes: 30,
};

const MAX_MONEY = 100_000;
const MIN_PREP_MINUTES = 5;
const MAX_PREP_MINUTES = 240;

function money(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MONEY) return fallback;
  return Math.round(parsed * 100) / 100;
}

/**
 * 把 jsonb 里的任意内容收敛成受控规则。所有读取路径都必须经过这里。
 */
export function normalizeDeliveryRules(raw: unknown): DeliveryRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_DELIVERY_RULES };
  const row = raw as Record<string, unknown>;

  const prepRaw = Number(row.prepMinutes);
  const prepMinutes = Number.isFinite(prepRaw)
    ? Math.min(MAX_PREP_MINUTES, Math.max(MIN_PREP_MINUTES, Math.round(prepRaw)))
    : DEFAULT_DELIVERY_RULES.prepMinutes;

  const freeRaw = row.freeDeliveryAbove;
  const freeDeliveryAbove = freeRaw === null || freeRaw === undefined || freeRaw === ''
    ? null
    : money(freeRaw, 0) || null;

  return {
    enabled: row.enabled === true,
    minOrderAmount: money(row.minOrderAmount, 0),
    fee: money(row.fee, 0),
    freeDeliveryAbove,
    prepMinutes,
  };
}

export interface DeliveryQuote {
  /** 实际收取的配送费（已应用免配送规则） */
  fee: number;
  minOrderAmount: number;
  subtotal: number;
  /** 是否达到起送价 */
  meetsMinimum: boolean;
  /** 未达起送价时还差多少（已达则为 0） */
  shortfall: number;
  freeDeliveryApplied: boolean;
  prepMinutes: number;
}

/**
 * 计价。已经是服务端的权威计算，调用方不得在其后再叠加任何客户端金额。
 */
export function quoteDelivery(rules: DeliveryRules, subtotal: number): DeliveryQuote {
  const rounded = Math.round(subtotal * 100) / 100;
  const meetsMinimum = rounded >= rules.minOrderAmount;
  const freeDeliveryApplied = rules.freeDeliveryAbove !== null && rounded >= rules.freeDeliveryAbove;
  const fee = freeDeliveryApplied ? 0 : rules.fee;
  return {
    fee,
    minOrderAmount: rules.minOrderAmount,
    subtotal: rounded,
    meetsMinimum,
    shortfall: meetsMinimum ? 0 : Math.round((rules.minOrderAmount - rounded) * 100) / 100,
    freeDeliveryApplied,
    prepMinutes: rules.prepMinutes,
  };
}

export type RiderStatus = 'pending' | 'claimed' | 'picked_up' | 'delivered' | 'cancelled';

/**
 * 状态机白名单。放在代码里而不是 check 约束：演进状态机不应要求 DDL，
 * 与仓库既有做法一致（reservations.status 同样如此）。
 */
export const RIDER_STATUSES: readonly RiderStatus[] = [
  'pending', 'claimed', 'picked_up', 'delivered', 'cancelled',
];

/** 骑手可自行推进的跃迁。cancel 不在这里 —— 取消是管理动作，不是骑手动作。 */
const RIDER_TRANSITIONS: Readonly<Record<RiderStatus, readonly RiderStatus[]>> = {
  pending: [],
  claimed: ['picked_up'],
  picked_up: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function canRiderAdvance(from: RiderStatus, to: RiderStatus): boolean {
  return RIDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 外卖下单的幂等指纹。
 *
 * 与堂食的 `orderContentFingerprint`（src/app/api/store/orders/route.ts:98）同一思路：
 * 在**商品已按商品表核验之后**计算，因此是权威值。字段不同是必要的 ——
 * 外卖没有桌号，但有配送地址与配送费；地址改了就是另一单。
 */
export function deliveryContentFingerprint(input: {
  items: readonly { product_id: string; qty: number }[];
  subtotal: number;
  fee: number;
  addressLine: string;
  recipientPhone: string;
}): string {
  const items = [...input.items]
    .map((item) => `${item.product_id}x${item.qty}`)
    .sort()
    .join(',');
  return `${items}|${input.subtotal.toFixed(2)}|${input.fee.toFixed(2)}|${input.addressLine}|${input.recipientPhone}`;
}

export function promisedAtFrom(now: Date, prepMinutes: number): string {
  return new Date(now.getTime() + prepMinutes * 60_000).toISOString();
}

/** 读取该商家的配送规则（已归一化）。 */
export async function getDeliveryRules(tenantId: string, businessId: string): Promise<DeliveryRules> {
  const settings = await getSettings(tenantId, businessId);
  return normalizeDeliveryRules(settings.delivery);
}

export interface DeliveryRow {
  id: string;
  order_id: string;
  order_no: string;
  recipient_name: string;
  recipient_phone: string;
  address_line: string;
  address_note: string | null;
  fee: number;
  rider_staff_id: string | null;
  rider_status: RiderStatus;
  promised_at: string | null;
  created_at: string;
  total: number;
  items_summary: string;
}

interface RawDeliveryJoin {
  id: string;
  order_id: string;
  recipient_name: string;
  recipient_phone: string;
  address_line: string;
  address_note: string | null;
  fee: string | number;
  rider_staff_id: string | null;
  rider_status: string;
  promised_at: string | null;
  created_at: string;
  orders: {
    order_no?: string;
    total?: string | number;
    items?: { name?: string; qty?: number }[];
  } | null;
}

const DELIVERY_SELECT = 'id, order_id, recipient_name, recipient_phone, address_line, '
  + 'address_note, fee, rider_staff_id, rider_status, promised_at, created_at, '
  + 'orders(order_no, total, items)';

function itemsSummary(items: unknown): string {
  if (!Array.isArray(items)) return '';
  const parts = items
    .slice(0, 3)
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return `${String(row.name ?? '')} x${Number(row.qty ?? 0)}`;
    })
    .filter((text) => text.trim() !== 'x0');
  return items.length > 3 ? `${parts.join('、')} 等 ${items.length} 件` : parts.join('、');
}

function toDeliveryRow(raw: RawDeliveryJoin): DeliveryRow {
  const status = RIDER_STATUSES.includes(raw.rider_status as RiderStatus)
    ? (raw.rider_status as RiderStatus)
    : 'pending';
  return {
    id: raw.id,
    order_id: raw.order_id,
    order_no: String(raw.orders?.order_no ?? ''),
    recipient_name: raw.recipient_name,
    recipient_phone: raw.recipient_phone,
    address_line: raw.address_line,
    address_note: raw.address_note,
    fee: Number(raw.fee ?? 0),
    rider_staff_id: raw.rider_staff_id,
    rider_status: status,
    promised_at: raw.promised_at,
    created_at: raw.created_at,
    total: Number(raw.orders?.total ?? 0),
    items_summary: itemsSummary(raw.orders?.items),
  };
}

/** 待接单队列（本店全部 pending）。 */
export async function listPendingDeliveries(
  tenantId: string,
  businessId: string,
  limit = 50,
): Promise<DeliveryRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('delivery_orders')
    .select(DELIVERY_SELECT)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('rider_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawDeliveryJoin[]).map(toDeliveryRow);
}

/** 我名下、尚未送达的配送单。 */
export async function listMyDeliveries(
  tenantId: string,
  businessId: string,
  staffId: string,
  limit = 50,
): Promise<DeliveryRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('delivery_orders')
    .select(DELIVERY_SELECT)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('rider_staff_id', staffId)
    .in('rider_status', ['claimed', 'picked_up'])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawDeliveryJoin[]).map(toDeliveryRow);
}

export type ClaimOutcome =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: 'not_found' | 'already_claimed' };

/**
 * 原子认领。
 *
 * 单条 `UPDATE ... WHERE rider_status = 'pending'`，靠**返回行数**判断成败。
 * 影响 0 行有两种可能：单不存在/不属于本店，或已被别人接走。再读一次区分两者 ——
 * UI 需要区分："被别人抢走"应把卡片移出列表，"单不存在"应刷新整个列表。
 */
export async function claimDeliveryOrder(
  tenantId: string,
  businessId: string,
  staffId: string,
  deliveryId: string,
): Promise<ClaimOutcome> {
  const client = getSupabaseClient();
  const now = new Date().toISOString();

  const { data, error } = await client
    .from('delivery_orders')
    .update({
      rider_staff_id: staffId,
      rider_status: 'claimed',
      claimed_at: now,
      updated_at: now,
    })
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('rider_status', 'pending')
    .select('id');

  if (error) throw new Error(error.message);
  if ((data ?? []).length === 1) return { ok: true, deliveryId };

  const { data: existing } = await client
    .from('delivery_orders')
    .select('id')
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  return { ok: false, reason: existing ? 'already_claimed' : 'not_found' };
}

export type AdvanceOutcome =
  | { ok: true; riderStatus: RiderStatus }
  | { ok: false; reason: 'not_found' | 'not_mine' | 'invalid_transition' | 'already_settled' };

/**
 * 骑手推进自己那一单（已取餐 / 已送达）。
 *
 * 过滤条件里带 `rider_staff_id = staffId`：**这是越权的第二道锁**，
 * 权限矩阵给的是 `delivery:claim`（"允许接单"），而"能推进哪些单"由这里决定。
 * 客户端传什么 id 都不看。
 */
export async function advanceDeliveryStatus(
  tenantId: string,
  businessId: string,
  staffId: string,
  deliveryId: string,
  next: RiderStatus,
): Promise<AdvanceOutcome> {
  const client = getSupabaseClient();

  const { data: current, error: readError } = await client
    .from('delivery_orders')
    .select('id, rider_staff_id, rider_status')
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!current) return { ok: false, reason: 'not_found' };

  const row = current as { rider_staff_id: string | null; rider_status: string };
  if (row.rider_staff_id !== staffId) return { ok: false, reason: 'not_mine' };

  const from = row.rider_status as RiderStatus;
  if (from === 'delivered' || from === 'cancelled') return { ok: false, reason: 'already_settled' };
  if (!canRiderAdvance(from, next)) return { ok: false, reason: 'invalid_transition' };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { rider_status: next, updated_at: now };
  if (next === 'picked_up') patch.picked_up_at = now;
  if (next === 'delivered') patch.delivered_at = now;

  // WHERE 里保留 from：读与写之间可能有人推进过，条件不满足就不写。
  const { data, error } = await client
    .from('delivery_orders')
    .update(patch)
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('rider_staff_id', staffId)
    .eq('rider_status', from)
    .select('id');
  if (error) throw new Error(error.message);
  if ((data ?? []).length !== 1) return { ok: false, reason: 'invalid_transition' };

  return { ok: true, riderStatus: next };
}

/** 店长指派（或改派）。同样是单条原子 UPDATE。 */
export async function assignDelivery(
  tenantId: string,
  businessId: string,
  riderStaffId: string,
  deliveryId: string,
): Promise<{ ok: boolean; reason?: 'not_found' | 'already_settled' }> {
  const client = getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('delivery_orders')
    .update({
      rider_staff_id: riderStaffId,
      rider_status: 'claimed',
      claimed_at: now,
      updated_at: now,
    })
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .in('rider_status', ['pending', 'claimed'])
    .select('id');
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 1) return { ok: true };

  const { data: existing } = await client
    .from('delivery_orders')
    .select('id')
    .eq('id', deliveryId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  return { ok: false, reason: existing ? 'already_settled' : 'not_found' };
}
