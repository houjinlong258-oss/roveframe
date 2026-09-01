import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface AppSettings {
  id: string;
  business: Record<string, unknown>;
  locale: Record<string, unknown>;
  ai_prefs: Record<string, unknown>;
  model_assign: Record<string, string>;
}

let cache: { data: AppSettings; at: number } | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.data;
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('settings')
    .select('id, business, locale, ai_prefs, model_assign')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row: AppSettings = data ?? { id: '', business: {}, locale: {}, ai_prefs: {}, model_assign: {} };
  cache = { data: row, at: Date.now() };
  return row;
}

export function invalidateSettingsCache() {
  cache = null;
}

export async function updateSettings(patch: Partial<Omit<AppSettings, 'id'>>): Promise<void> {
  const client = getSupabaseClient();
  const current = await getSettings();
  const payload = { ...patch, updated_at: new Date().toISOString() };
  if (current.id) {
    const { error } = await client.from('settings').update(payload).eq('id', current.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await client.from('settings').insert(payload);
    if (error) throw new Error(error.message);
  }
  invalidateSettingsCache();
}
