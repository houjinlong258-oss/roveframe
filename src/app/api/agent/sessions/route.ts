import { errorResponse, json, jsonError } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { deleteWithScope, insertWithScope, scopedTable } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

export async function GET(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const { data, error } = await scopedTable(ctx, 'chat_sessions', 'id, title, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return json({ sessions: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

async function createSession(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const body = (await request.json()) as { title?: string };
    const { data, error } = await insertWithScope(ctx, 'chat_sessions', {
      title: body.title?.slice(0, 40) || 'New chat',
    })
      .select('id, title, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    return json({ session: data });
  } catch (error) {
    return errorResponse(error);
  }
}

async function deleteSession(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    const { error } = await deleteWithScope(ctx, 'chat_sessions', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'agent:use', action: 'agent_sessions.create', entity: 'chat_sessions' },
  createSession,
);
export const DELETE = protectBusinessMutation(
  { permission: 'agent:use', action: 'agent_sessions.delete', entity: 'chat_sessions' },
  deleteSession,
);
