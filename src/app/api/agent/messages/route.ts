import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('session_id');
    if (!sessionId) return jsonError('missing session_id', 400);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return json({ messages: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
