import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { deleteWithTenant, insertWithTenant, tenantTable } from '@/lib/tenant-db';

export async function GET(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const { data, error } = await tenantTable(ctx.tenantId, 'chat_sessions', 'id, title, created_at, updated_at')
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
    const ctx = getTenantContext(request);
    const body = (await request.json()) as { title?: string };
    const { data, error } = await insertWithTenant(ctx.tenantId, 'chat_sessions', {
      title: body.title?.slice(0, 40) || 'New chat',
    })
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
    const ctx = getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    const { error } = await deleteWithTenant(ctx.tenantId, 'chat_sessions', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
