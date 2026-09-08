import { z } from 'zod';
import { errorResponse, json } from '@/lib/api-helpers';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['acknowledged', 'resolved']),
});

/** Owner/manager notification center backed by durable Agent events. */
export async function GET(request: Request) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'notifications:read');
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });
    if (!parsed.success) return json({ error: 'invalid notification query', details: parsed.error.flatten() }, 400);

    let query = scopedTable(context, 'agent_events', 'id, event_type, severity, title, content, status, metadata, detected_at, created_at');
    if (parsed.data.status) query = query.eq('status', parsed.data.status);
    const { data, error } = await query.order('detected_at', { ascending: false }).limit(parsed.data.limit);
    if (error) throw new Error(error.message);
    return json({ notifications: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Acknowledge or resolve an event without allowing tenant/business escape. */
async function updateNotification(request: Request) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'notifications:write');
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'invalid notification update', details: parsed.error.flatten() }, 400);

    const { data, error } = await updateWithScope(context, 'agent_events', parsed.data.id, { status: parsed.data.status })
      .eq('id', parsed.data.id)
      .select('id, status')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return json({ error: 'notification not found' }, 404);
    return json({ notification: data });
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = protectBusinessMutation(
  { permission: 'notifications:write', action: 'notifications.update', entity: 'notifications' },
  updateNotification,
);
