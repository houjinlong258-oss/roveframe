import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { createPendingApproval, type ActionType } from '@/lib/agent/approvals';
import { verifyRoveAgentPayload } from '@/lib/roveagent/signature';

/**
 * RoveAgent → RoveFrame 审批事件接收端（server-to-server）。
 *
 * Python 侧 EnterpriseToolGate 判定 requires_approval（或目标引擎产出
 * 待审步骤）时，经 approval_bridge 推送到本端点，落成 agent_approvals
 * 记录，出现在审批 UI；批准后经 processApproval 回调 Python
 * /api/agent/execute（任务步骤）或 /api/agent/tool/resolve（工具调用）。
 *
 * 认证：X-RoveAgent-Key 共享密钥（与 ROVEAGENT_API_KEY 一致），
 * 不走用户会话 —— 调用方是内网 RoveAgent 服务。
 */

type EventKind = 'tool_call' | 'task_step';

interface ApprovalEvent {
  kind?: unknown;
  tenant_id?: unknown;
  business_id?: unknown;
  title?: unknown;
  description?: unknown;
  payload?: unknown;
}

const ACTION_TYPE_BY_KIND: Record<EventKind, ActionType> = {
  tool_call: 'roveagent.tool_call',
  task_step: 'roveagent.task_step',
};

function validServiceKey(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

export async function POST(request: NextRequest) {
  const expectedKey = process.env.ROVEAGENT_API_KEY ?? '';
  const providedKey = request.headers.get('x-roveagent-key') ?? '';
  if (!validServiceKey(providedKey, expectedKey)) {
    return NextResponse.json({ error: 'invalid X-RoveAgent-Key' }, { status: 401 });
  }

  const rawBody = await request.text();
  if (!verifyRoveAgentPayload(
    rawBody,
    request.headers.get('x-roveagent-timestamp') ?? '',
    request.headers.get('x-roveagent-signature') ?? '',
  )) {
    return NextResponse.json({ error: 'invalid or expired RoveAgent signature' }, { status: 401 });
  }

  let body: ApprovalEvent;
  try {
    body = JSON.parse(rawBody) as ApprovalEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const kind = body.kind === 'tool_call' || body.kind === 'task_step' ? body.kind : null;
  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : '';
  const businessId = typeof body.business_id === 'string' ? body.business_id : '';
  const title = typeof body.title === 'string' && body.title ? body.title : 'RoveAgent approval request';
  const description = typeof body.description === 'string' ? body.description : undefined;
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};

  if (!kind || !tenantId || !businessId) {
    return NextResponse.json({ error: 'kind, tenant_id, and business_id are required' }, { status: 400 });
  }

  const invocationId = typeof payload.invocation_id === 'string' ? payload.invocation_id : '';
  const toolName = typeof payload.tool === 'string' ? payload.tool : '';
  const argumentsValue = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
    ? payload.args as Record<string, unknown>
    : {};
  if (kind === 'tool_call' && (!invocationId || !toolName)) {
    return NextResponse.json({ error: 'tool_call requires payload.invocation_id and payload.tool' }, { status: 400 });
  }

  // 服务身份只证明调用方；事件携带的 tenant/business 配对仍必须查库验证。
  const supabase = getSupabaseClient();
  const { data: biz, error: bizErr } = await supabase
    .from('businesses')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('id', businessId)
    .maybeSingle();

  if (bizErr || !biz) {
    return NextResponse.json({ error: `No business found for tenant ${tenantId}` }, { status: 404 });
  }

  const res = await createPendingApproval({
    tenantId,
    businessId: biz.id,
    actionType: ACTION_TYPE_BY_KIND[kind],
    userId: typeof payload.user_id === 'string' ? payload.user_id : undefined,
    requester: typeof payload.user_id === 'string' ? payload.user_id : undefined,
    agent: typeof payload.agent_id === 'string' ? payload.agent_id : 'roveagent',
    toolName: kind === 'tool_call' ? toolName : 'roveagent.task_step',
    arguments: kind === 'tool_call' ? argumentsValue : payload,
    riskLevel: payload.risk === 'critical' || payload.risk === 'high'
      || payload.risk === 'medium' || payload.risk === 'low'
      ? payload.risk
      : 'high',
    requiredRole: payload.approval_policy === 'owner' || payload.approval_policy === 'admin'
      ? payload.approval_policy
      : 'manager',
    invocationId: invocationId || `task:${String(payload.task_id ?? '')}`,
    title,
    description,
    payload,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, approval_id: res.approvalId });
}
