import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';

export async function GET() {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return json({ sessions: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { title?: string };
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('chat_sessions')
      .insert({ title: body.title?.slice(0, 40) || 'New chat' })
      .select('id, title, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    return json({ session: data });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    const client = getSupabaseClient();
    const { error } = await client.from('chat_sessions').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
