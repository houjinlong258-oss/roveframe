import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { getBusinessContext } from '@/lib/business-context';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePersonaKey } from '@/lib/agent/personas';
import { deriveMissions, type MissionActiveTask } from '@/lib/agent/missions';
import { errorResponse } from '@/lib/api-helpers';

/**
 * Agent Mission Panel：`GET /api/agent/missions?persona=coo`
 *
 * 每一条任务都由真实经营数据推导（营收 vs 7 日均值、低库存、流失风险、
 * 待审批动作、未读系统告警），不是写死的文案。
 */
export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const persona = resolvePersonaKey(request.nextUrl.searchParams.get('persona'));
    const client = getSupabaseClient();

    const [businessContext, approvals, alerts, tasks] = await Promise.all([
      getBusinessContext(context.tenantId, context.businessId),
      client
        .from('agent_approvals')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .eq('status', 'pending'),
      client
        .from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .eq('level', 'error')
        .eq('is_read', false),
      client
        .from('agent_tasks')
        .select('id, name, status, next_run_at')
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .in('status', ['active', 'running', 'paused'])
        .order('next_run_at', { ascending: true })
        .limit(5),
    ]);

    const activeTasks: MissionActiveTask[] = ((tasks.data ?? []) as Array<{
      id: string;
      name: string;
      status: string;
      next_run_at: string | null;
    }>).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      nextRunAt: task.next_run_at,
    }));

    return NextResponse.json(
      deriveMissions({
        persona,
        context: businessContext,
        pendingApprovals: approvals.count ?? 0,
        unreadErrorAlerts: alerts.count ?? 0,
        activeTasks,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
