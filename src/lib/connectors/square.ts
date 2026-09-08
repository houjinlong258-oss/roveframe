/**
 * Square POS 客户端封装（缺口 A1：订单同步真实链路）。
 *
 * - syncSquareOrders：Orders API 按时间窗拉取 → 标准化为 orders 表行（source='square'，
 *   order_no=SQ-<外部ID> 幂等去重）
 * - verifySquareSignature：Webhook 签名校验（HMAC-SHA256(notificationUrl + rawBody)，base64）
 * - 演示模式（RF_E2E_DEMO=1 非生产）无凭据时使用沙箱样本，保证最小闭环可验收
 */

import crypto from 'node:crypto';

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = process.env.SQUARE_API_VERSION?.trim() || '2026-08-19';
const MAX_SEARCH_PAGES = 100;

export interface SquareOrder {
  id: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  location_id?: string;
  total_money?: { amount?: number; currency?: string };
  line_items?: { name?: string; quantity?: string; total_money?: { amount?: number } }[];
}

export interface NormalizedOrderItem { name: string; qty: number; price: number }

export function mapSquareOrder(o: SquareOrder): {
  external_id: string; order_no: string; total: number; items: NormalizedOrderItem[];
  status: string; created_at: string;
} {
  const items: NormalizedOrderItem[] = (o.line_items ?? []).map((li) => ({
    name: li.name ?? 'Unknown item',
    qty: Math.max(1, parseInt(li.quantity ?? '1', 10) || 1),
    price: Math.round(((li.total_money?.amount ?? 0) / 100) * 100) / 100,
  }));
  return {
    external_id: o.id,
    order_no: `SQ-${o.id}`,
    total: Math.round(((o.total_money?.amount ?? 0) / 100) * 100) / 100,
    items,
    status: (o.state ?? 'COMPLETED').toLowerCase() === 'canceled' ? 'cancelled' : 'completed',
    created_at: o.created_at ?? new Date().toISOString(),
  };
}

export async function fetchSquareOrders(
  accessToken: string,
  sinceISO: string,
  locationIds: string[],
): Promise<SquareOrder[]> {
  const locations = [...new Set(locationIds.map((value) => value.trim()).filter(Boolean))];
  if (locations.length === 0 || locations.length > 10) {
    throw new Error('Square sync requires between 1 and 10 location IDs');
  }

  const orders: SquareOrder[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      location_ids: locations,
      query: {
        filter: { date_time_filter: { updated_at: { start_at: sinceISO } } },
        sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' },
      },
      limit: 1000,
    };
    if (cursor) body.cursor = cursor;
    const resp = await fetch(`${SQUARE_API}/orders/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`Square orders/search HTTP ${resp.status}`);
    const data = (await resp.json()) as { orders?: SquareOrder[]; cursor?: string };
    orders.push(...(data.orders ?? []));
    cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : undefined;
    if (!cursor) return orders;
  }
  throw new Error(`Square orders/search exceeded ${MAX_SEARCH_PAGES} pages`);
}

/** Square Webhook 验签：base64(HMAC_SHA256(signatureKey, notificationUrl + rawBody)) */
export function verifySquareSignature(rawBody: string, signatureHeader: string,
                                      signatureKey: string, notificationUrl: string): boolean {
  const expected = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody, 'utf8')
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 演示沙箱样本（仅 RF_E2E_DEMO=1 且非生产） */
export function sandboxSquareOrders(): SquareOrder[] {
  const now = Date.now();
  return [
    {
      id: `sandbox-${Math.floor(now / 60000)}-1`,
      state: 'COMPLETED',
      created_at: new Date(now - 45 * 60000).toISOString(),
      total_money: { amount: 4260, currency: 'USD' },
      line_items: [
        { name: 'Mapo Tofu 麻婆豆腐', quantity: '2', total_money: { amount: 2560 } },
        { name: 'Dan Dan Noodles 担担面', quantity: '1', total_money: { amount: 1020 } },
      ],
    },
    {
      id: `sandbox-${Math.floor(now / 60000)}-2`,
      state: 'COMPLETED',
      created_at: new Date(now - 20 * 60000).toISOString(),
      total_money: { amount: 6890, currency: 'USD' },
      line_items: [
        { name: 'Hot Pot Combo 火锅双人餐', quantity: '1', total_money: { amount: 4800 } },
        { name: 'Kung Pao Chicken 宫保鸡丁', quantity: '1', total_money: { amount: 1450 } },
      ],
    },
  ];
}
