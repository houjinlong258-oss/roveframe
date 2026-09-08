import { z } from 'zod';
import { errorResponse, json } from '@/lib/api-helpers';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tool: z.string().trim().min(1).max(128).optional(),
  status: z.enum(['started', 'succeeded', 'failed', 'blocked', 'timed_out']).optional(),
});

/** Owner-only audit feed for Agent tool activity in the current business. */
export async function GET(request: Request) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent_actions:read');
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      tool: url.searchParams.get('tool') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });
    if (!parsed.success) {
      return json({ error: 'invalid audit query', details: parsed.error.flatten() }, 400);
    }

    let query = scopedTable(
      context,
      'agent_actions',
      'id, user_id, session_id, turn_id, tool_call_id, agent, tool, action, input, result_summary, status, error_code, started_at, completed_at, created_at',
    );
    if (parsed.data.tool) query = query.eq('tool', parsed.data.tool);
    if (parsed.data.status) query = query.eq('status', parsed.data.status);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(parsed.data.limit);
    if (error) throw new Error(error.message);
    return json({ actions: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
