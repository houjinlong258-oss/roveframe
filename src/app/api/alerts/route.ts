import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unread') === 'true';
    const client = getSupabaseClient();
    let query = client.from('alerts').select('*').order('created_at', { ascending: false }).limit(20);
    if (unreadOnly) query = query.eq('is_read', false);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return json({ alerts: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { all?: boolean; id?: string };
    const client = getSupabaseClient();
    if (body.all) {
      const { error } = await client.from('alerts').update({ is_read: true }).eq('is_read', false);
      if (error) throw new Error(error.message);
    } else if (body.id) {
      const { error } = await client.from('alerts').update({ is_read: true }).eq('id', body.id);
      if (error) throw new Error(error.message);
    }
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
