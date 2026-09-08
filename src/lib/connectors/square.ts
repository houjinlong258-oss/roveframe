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



// ---------------------------------------------------------------------------
// OAuth（Connect with Square）+ 目录/客户/库存同步
// ---------------------------------------------------------------------------

const SQUARE_OAUTH_BASE = 'https://connect.squareup.com';

export const SQUARE_OAUTH_DEFAULT_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'ORDERS_READ',
  'ITEMS_READ',
  'INVENTORY_READ',
  'CUSTOMERS_READ',
  'PAYMENTS_READ',
].join(' ');

export function squareOAuthEnv(): { appId: string; appSecret: string } {
  const appId = process.env.SQUARE_APP_ID?.trim() ?? '';
  const appSecret = process.env.SQUARE_APP_SECRET?.trim() ?? '';
  return { appId, appSecret };
}

export function buildSquareOAuthUrl(opts: { appId: string; redirectUri: string; state: string; scopes?: string }): string {
  const params = new URLSearchParams({
    client_id: opts.appId,
    scope: opts.scopes ?? SQUARE_OAUTH_DEFAULT_SCOPES,
    state: opts.state,
    response_type: 'code',
    session: 'false',
  });
  return SQUARE_OAUTH_BASE + '/oauth2/authorize?' + params.toString();
}

export interface SquareTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
}

export async function exchangeSquareCode(opts: {
  appId: string; appSecret: string; code: string; redirectUri: string;
}): Promise<SquareTokenSet> {
  const resp = await fetch(SQUARE_OAUTH_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify({
      client_id: opts.appId,
      client_secret: opts.appSecret,
      code: opts.code,
      grant_type: 'authorization_code',
      redirect_uri: opts.redirectUri,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error('Square OAuth token exchange HTTP ' + resp.status);
  const data = (await resp.json()) as {
    access_token?: string; refresh_token?: string; expires_at?: string; merchant_id?: string;
  };
  if (!data.access_token) throw new Error('Square OAuth token exchange returned no access token');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    merchant_id: data.merchant_id,
  };
}

export async function refreshSquareToken(opts: {
  appId: string; appSecret: string; refreshToken: string;
}): Promise<SquareTokenSet> {
  const resp = await fetch(SQUARE_OAUTH_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify({
      client_id: opts.appId,
      client_secret: opts.appSecret,
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error('Square token refresh HTTP ' + resp.status);
  const data = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_at?: string; merchant_id?: string };
  if (!data.access_token) throw new Error('Square token refresh returned no access token');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    merchant_id: data.merchant_id,
  };
}

export interface SquareLocation { id: string; name: string }

export async function fetchSquareLocations(accessToken: string): Promise<SquareLocation[]> {
  const resp = await fetch(SQUARE_API + '/locations', {
    headers: { Authorization: 'Bearer ' + accessToken, 'Square-Version': SQUARE_VERSION },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error('Square locations HTTP ' + resp.status);
  const data = (await resp.json()) as { locations?: { id?: string; name?: string }[] };
  return (data.locations ?? [])
    .filter((loc): loc is { id: string; name: string } => Boolean(loc.id))
    .map((loc) => ({ id: String(loc.id), name: String(loc.name ?? loc.id) }));
}

export interface SquareCatalogItem {
  id: string;
  name: string;
  price: number;
}

/** 目录分页拉取（ITEMS）。cursor 由调用方持久化以续拉大目录。 */
export async function fetchSquareCatalog(accessToken: string, cursor?: string): Promise<{
  items: SquareCatalogItem[]; cursor: string | undefined;
}> {
  const url = SQUARE_API + '/catalog/list?types=ITEM' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Square-Version': SQUARE_VERSION },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error('Square catalog/list HTTP ' + resp.status);
  const data = (await resp.json()) as {
    objects?: { id?: string; type?: string; item_data?: {
      name?: string; variations?: { item_variation_data?: { price_money?: { amount?: number } } }[];
    } }[];
    cursor?: string;
  };
  const items: SquareCatalogItem[] = [];
  for (const obj of data.objects ?? []) {
    if (!obj.id || obj.type !== 'ITEM') continue;
    const firstVariation = obj.item_data?.variations?.[0];
    const price = firstVariation?.item_variation_data?.price_money?.amount;
    if (price === undefined) continue;
    items.push({ id: obj.id, name: String(obj.item_data?.name ?? obj.id), price: price / 100 });
  }
  return { items, cursor: data.cursor };
}

export interface SquareCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export async function fetchSquareCustomers(accessToken: string, cursor?: string): Promise<{
  customers: SquareCustomer[]; cursor: string | undefined;
}> {
  const url = SQUARE_API + '/customers' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Square-Version': SQUARE_VERSION },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error('Square customers HTTP ' + resp.status);
  const data = (await resp.json()) as {
    customers?: { id?: string; given_name?: string; family_name?: string; email_address?: string; phone_number?: string }[];
    cursor?: string;
  };
  const customers: SquareCustomer[] = (data.customers ?? []).map((c) => ({
    id: String(c.id ?? ''),
    name: [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || 'Guest',
    email: c.email_address ?? '',
    phone: c.phone_number ?? '',
  }));
  return { customers, cursor: data.cursor };
}

export interface SquareInventoryCount { catalog_object_id: string; quantity: number }

/** 库存批量查询：每次最多 100 个 catalog object id。 */
export async function fetchSquareInventoryCounts(
  accessToken: string,
  catalogObjectIds: string[],
): Promise<SquareInventoryCount[]> {
  const counts: SquareInventoryCount[] = [];
  for (let i = 0; i < catalogObjectIds.length; i += 100) {
    const batch = catalogObjectIds.slice(i, i + 100);
    const resp = await fetch(SQUARE_API + '/inventory/batch-retrieve-counts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ catalog_object_ids: batch }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error('Square inventory batch HTTP ' + resp.status);
    const data = (await resp.json()) as { counts?: { catalog_object_id?: string; quantity?: string }[] };
    for (const c of data.counts ?? []) {
      if (c.catalog_object_id) {
        counts.push({ catalog_object_id: c.catalog_object_id, quantity: Number(c.quantity ?? '0') || 0 });
      }
    }
  }
  return counts;
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
