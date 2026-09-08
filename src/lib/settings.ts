import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface AppSettings {
  id: string;
  business: Record<string, unknown>;
  locale: Record<string, unknown>;
  ai_prefs: Record<string, unknown>;
  model_assign: Record<string, string>;
}

const cache = new Map<string, { data: AppSettings; at: number }>();

function scopeKey(tenantId: string, businessId: string): string {
  return `${tenantId}\u0000${businessId}`;
}

export async function getSettings(tenantId: string, businessId: string): Promise<AppSettings> {
  const key = scopeKey(tenantId, businessId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.data;
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('settings')
    .select('id, business, locale, ai_prefs, model_assign')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row: AppSettings = data ?? { id: '', business: {}, locale: {}, ai_prefs: {}, model_assign: {} };
  cache.set(key, { data: row, at: Date.now() });
  return row;
}

export function invalidateSettingsCache(tenantId?: string, businessId?: string) {
  if (tenantId && businessId) {
    cache.delete(scopeKey(tenantId, businessId));
    return;
  }
  if (tenantId) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${tenantId}\u0000`)) cache.delete(key);
    }
    return;
  }
  cache.clear();
}

export async function updateSettings(
  tenantId: string,
  businessId: string,
  patch: Partial<Omit<AppSettings, 'id'>>,
): Promise<void> {
  const client = getSupabaseClient();
  const current = await getSettings(tenantId, businessId);
  const payload = { ...patch, updated_at: new Date().toISOString() };
  if (current.id) {
    const { error } = await client
      .from('settings')
      .update(payload)
      .eq('id', current.id)
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await client.from('settings').insert({
      ...payload,
      tenant_id: tenantId,
      business_id: businessId,
    });
    if (error) throw new Error(error.message);
  }
  invalidateSettingsCache(tenantId, businessId);
}
