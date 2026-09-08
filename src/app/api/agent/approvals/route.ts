import { NextRequest, NextResponse } from 'next/server';
import { processApproval } from '@/lib/agent/approvals';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { errorResponse } from '@/lib/api-helpers';

/** List approval items for the current business (full lifecycle fields). */
export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    // P0-4：审批载荷（payload/arguments 含退款金额与工具参数）仅 owner/manager 可读。
    requirePermission(context, 'approvals:read');

    const supabase = getSupabaseClient();
    const { data: approvals, error } = await supabase
      .from('agent_approvals')
      .select('*')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ approvals });
  } catch (authError) {
    return errorResponse(authError);
  }
}

type ProcessApprovalBody = {
  approval_id?: unknown;
  action?: unknown;
};

/** Approve or reject an Agent-generated pending action. */
async function decideApproval(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: ProcessApprovalBody;
  try {
    body = (await request.json()) as ProcessApprovalBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const approvalId = typeof body.approval_id === 'string' ? body.approval_id : null;
  const action = body.action === 'approve' || body.action === 'reject' ? body.action : null;

  if (!approvalId || !action) {
    return NextResponse.json({ error: 'approval_id and valid action (approve | reject) are required' }, { status: 400 });
  }

  const res = await processApproval({
    approvalId,
    tenantId: context.tenantId,
    businessId: context.businessId,
    action,
    userId: context.userId,
    role: context.role,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }

  return NextResponse.json(res);
}

export const POST = protectBusinessMutation(
  { permission: 'approvals:decide', action: 'agent_approvals.decide', entity: 'agent_approvals' },
  decideApproval,
);
