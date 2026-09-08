/**
 * Square 业务同步编排：orders / catalog(products) / customers / inventory。
 * API 路由与调度器共用；所有写入带 tenant_id + business_id 双 scope，
 * 游标/水位持久化到 cron_state（不存在时 fail-safe 报错）。
 * RF_E2E_DEMO 沙箱路径绝不进入本模块（demo 只在 API 路由内被显式门禁）。
 */
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  fetchSquareCatalog, fetchSquareCustomers, fetchSquareInventoryCounts,
  fetchSquareOrders, mapSquareOrder, refreshSquareToken, squareOAuthEnv,
} from '@/lib/connectors/square';

export interface SquareSyncSummary {
  ok: boolean;
  orders: number;
  products: number;
  customers: number;
  inventory: number;
  errors: string[];
}

interface SquareConfig {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  merchantId?: string;
  locationId?: string;
  locationIds?: string[];
}

function parseConfig(decrypted: string): SquareConfig {
  try {
    return JSON.parse(decrypted) as SquareConfig;
  } catch {
    return {};
  }
}

function locationIdsOf(config: SquareConfig): string[] {
  const raw = Array.isArray(config.locationIds) && config.locationIds.length > 0
    ? config.locationIds
    : typeof config.locationId === 'string' && config.locationId
      ? config.locationId.split(',')
      : [];
  return [...new Set(raw.map((v) => v.trim()).filter(Boolean))].slice(0, 10);
}

async function getCronStateValue(key: string): Promise<Record<string, unknown> | null> {
  const { data } = await getSupabaseClient().from('cron_state').select('value').eq('key', key).maybeSingle();
  return (data?.value as Record<string, unknown>) ?? null;
}

async function setCronStateValue(key: string, value: Record<string, unknown>): Promise<void> {
  const client = getSupabaseClient();
  const payload = { key, value, updated_at: new Date().toISOString() };
  const { data } = await client.from('cron_state').select('key').eq('key', key).maybeSingle();
  if (data) await client.from('cron_state').update(payload).eq('key', key);
  else await client.from('cron_state').insert(payload);
}

/** 单次全量/增量同步（orders 增量水位 72h 回补；catalog/customers 游标续拉）。 */
export async function syncSquareBusiness(tenantId: string, businessId: string): Promise<SquareSyncSummary> {
  const supabase = getSupabaseClient();
  const summary: SquareSyncSummary = { ok: true, orders: 0, products: 0, customers: 0, inventory: 0, errors: [] };
  const { data: cfgRow, error: cfgError } = await supabase.from('integration_configs')
    .select('id, config_encrypted, last_sync_at')
    .eq('tenant_id', tenantId).eq('business_id', businessId)
    .eq('provider', 'square').eq('is_enabled', true).maybeSingle();
  if (cfgError) throw new Error('square config lookup failed: ' + cfgError.message);
  if (!cfgRow) return { ...summary, ok: false, errors: ['square not connected'] };
  const row = cfgRow as { id: string; config_encrypted: string | null; last_sync_at: string | null };
  if (!row.config_encrypted) return { ...summary, ok: false, errors: ['square config missing'] };

  const config = parseConfig(decrypt(row.config_encrypted));
  let accessToken = config.accessToken ?? '';
  if (!accessToken) return { ...summary, ok: false, errors: ['square access token missing'] };

  // Token 过期自动刷新（OAuth 接入的商户）。
  if (config.refreshToken && config.expiresAt) {
    const expiresAtMs = Date.parse(config.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now() + 300_000) {
      const { appId, appSecret } = squareOAuthEnv();
      if (!appId || !appSecret) {
        summary.errors.push('square token expired and SQUARE_APP_ID/SECRET not configured for refresh');
        summary.ok = false;
        return summary;
      }
      try {
        const refreshed = await refreshSquareToken({ appId, appSecret, refreshToken: config.refreshToken });
        accessToken = refreshed.access_token;
        const next: SquareConfig = {
          ...config,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? config.refreshToken,
          expiresAt: refreshed.expires_at ?? config.expiresAt,
        };
        await supabase.from('integration_configs').update({
          config_encrypted: encrypt(JSON.stringify(next)),
          updated_at: new Date().toISOString(),
        }).eq('id', row.id).eq('tenant_id', tenantId).eq('business_id', businessId);
      } catch (refreshError) {
        summary.errors.push('square token refresh failed: ' + (refreshError instanceof Error ? refreshError.message : String(refreshError)));
        summary.ok = false;
        return summary;
      }
    }
  }

  const stateKey = 'square_sync.' + tenantId + '.' + businessId;
  const state = (await getCronStateValue(stateKey)) ?? {};
  const watermark = row.last_sync_at
    ? new Date(row.last_sync_at).getTime() - 72 * 86400000
    : Date.now() - 30 * 86400000;

  // 1) Orders（时间窗水位，幂等 upsert）
  try {
    const locationIds = locationIdsOf(config);
    if (locationIds.length > 0) {
      const orders = await fetchSquareOrders(accessToken, new Date(watermark).toISOString(), locationIds);
      for (const o of orders) {
        const mapped = mapSquareOrder(o);
        const { error } = await supabase.from('orders').upsert({
          tenant_id: tenantId, business_id: businessId, ...mapped,
          channel: 'dine_in', source: 'square',
        }, { onConflict: 'tenant_id,business_id,source,external_id' });
        if (error) { summary.errors.push('order ' + o.id + ': ' + error.message); continue; }
        summary.orders += 1;
      }
    }
  } catch (ordersError) {
    summary.errors.push('orders: ' + (ordersError instanceof Error ? ordersError.message : String(ordersError)));
    summary.ok = false;
  }

  // 2) Catalog → products（游标续拉）
  try {
    let cursor = typeof state.catalog_cursor === 'string' ? state.catalog_cursor : undefined;
    const catalogIds: string[] = [];
    const nameById = new Map<string, string>();
    for (let page = 0; page < 20; page += 1) {
      const pageResult = await fetchSquareCatalog(accessToken, cursor);
      for (const item of pageResult.items) {
        catalogIds.push(item.id);
        nameById.set(item.id, item.name);
        const { error } = await supabase.from('products').upsert({
          tenant_id: tenantId, business_id: businessId,
          source: 'square', external_id: item.id,
          name: item.name, price: item.price,
          category: 'Other', status: 'active',
        }, { onConflict: 'tenant_id,business_id,source,external_id' });
        if (error) { summary.errors.push('product ' + item.id + ': ' + error.message); continue; }
        summary.products += 1;
      }
      cursor = pageResult.cursor;
      if (!cursor) break;
    }
    await setCronStateValue(stateKey, { ...state, catalog_cursor: cursor ?? '' });
    state.catalog_cursor = cursor ?? '';

    // 3) Inventory（基于本轮 catalog id 批量查数，按产品名回写库存）
    if (catalogIds.length > 0) {
      const counts = await fetchSquareInventoryCounts(accessToken, catalogIds);
      for (const count of counts) {
        const name = nameById.get(count.catalog_object_id);
        if (!name) continue;
        const { data: existing } = await supabase.from('inventory_items')
          .select('id').eq('tenant_id', tenantId).eq('business_id', businessId)
          .eq('name', name).maybeSingle();
        const payload = { current_stock: count.quantity, synced_at: new Date().toISOString() };
        const write = existing
          ? await supabase.from('inventory_items').update(payload)
            .eq('id', (existing as { id: string }).id)
            .eq('tenant_id', tenantId).eq('business_id', businessId)
          : await supabase.from('inventory_items').insert({
              tenant_id: tenantId, business_id: businessId,
              name, current_stock: count.quantity, safety_stock: 5, unit: 'unit', synced_at: new Date().toISOString(),
            });
        if (write.error) { summary.errors.push('inventory ' + name + ': ' + write.error.message); continue; }
        summary.inventory += 1;
      }
    }
  } catch (catalogError) {
    summary.errors.push('catalog/inventory: ' + (catalogError instanceof Error ? catalogError.message : String(catalogError)));
    summary.ok = false;
  }

  // 4) Customers（游标续拉，幂等 upsert）
  try {
    let cursor = typeof state.customers_cursor === 'string' ? state.customers_cursor : undefined;
    for (let page = 0; page < 20; page += 1) {
      const pageResult = await fetchSquareCustomers(accessToken, cursor);
      for (const c of pageResult.customers) {
        if (!c.email && !c.phone) continue;
        const { error } = await supabase.from('customers').upsert({
          tenant_id: tenantId, business_id: businessId,
          source: 'square', external_id: c.id,
          name: c.name || 'Guest',
          email: c.email || null, phone: c.phone || null,
        }, { onConflict: 'tenant_id,business_id,source,external_id' });
        if (error) { summary.errors.push('customer ' + c.id + ': ' + error.message); continue; }
        summary.customers += 1;
      }
      cursor = pageResult.cursor;
      if (!cursor) break;
    }
    await setCronStateValue(stateKey, { ...state, customers_cursor: cursor ?? '' });
  } catch (customersError) {
    summary.errors.push('customers: ' + (customersError instanceof Error ? customersError.message : String(customersError)));
    summary.ok = false;
  }

  // 水位推进：即使部分子资源失败也记录时间（避免永久回补同一窗口）。
  await supabase.from('integration_configs').update({
    last_sync_at: new Date().toISOString(),
    status: summary.ok ? 'connected' : 'error',
    updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('tenant_id', tenantId).eq('business_id', businessId);

  return summary;
}
