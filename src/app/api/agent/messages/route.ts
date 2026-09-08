import { errorResponse, json, jsonError } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';

export async function GET(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('session_id');
    if (!sessionId) return jsonError('missing session_id', 400);
    const { data, error } = await scopedTable(ctx, 'chat_messages', 'id, role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return json({ messages: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
