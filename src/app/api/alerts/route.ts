import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { tenantTable, updateWithTenant } from '@/lib/tenant-db';

// 告警列表 / 标记已读
// （P0-S2 完整版：tenant 过滤 + tenant_id 注入）
export async function GET(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unread') === 'true';

    const q = tenantTable(ctx.tenantId, 'alerts')
      .order('created_at', { ascending: false })
      .limit(20);
    const chained = unreadOnly
      ? (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq('is_read', false)
      : q;
    const { data, error } = await chained;
    if (error) throw new Error(error.message);
    return json({ alerts: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const body = (await request.json()) as { all?: boolean; id?: string };
    if (body.all) {
      // 全部已读：按 tenant + is_read=false 过滤后批量更新
      const q = tenantTable(ctx.tenantId, 'alerts', 'id');
      const { data: rows, error: fetchErr } = await (q as unknown as {
        eq: (c: string, v: unknown) => { then: (fn: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) => Promise<unknown> };
      }).eq('is_read', false);
      if (fetchErr) throw new Error(fetchErr?.message ?? 'fetch unread alerts failed');
      const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
      for (const id of ids) {
        const { error } = await updateWithTenant(ctx.tenantId, 'alerts', id, { is_read: true });
        if (error) throw new Error(error.message);
      }
    } else if (body.id) {
      const { error } = await updateWithTenant(ctx.tenantId, 'alerts', body.id, { is_read: true });
      if (error) throw new Error(error.message);
    }
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
