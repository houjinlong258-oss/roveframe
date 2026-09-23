import { insertWithScope } from '@/lib/tenant-db';
import type { AgentAuditEvent, AgentToolContext } from '@/lib/agent/types';

// ---------------------------------------------------------------------------
// 测试缝：设置后 writeAgentAction 走注入的 sink（不连库）。
// 仅供 tests/ 使用，生产代码不应调用。与 src/lib/audit.ts 的
// `_setAuditSinkForTest` 同一约定。
//
// 为什么需要它：`executeEnterpriseTool` 的失败语义（审计写不进去时该不该
// 报成功）必须能被**确定性地**测到。没有这个缝，测试只能靠"制造一次真实的
// 数据库写入失败"——那要么依赖库的当前状态，要么往生产库里塞坏数据。
// ---------------------------------------------------------------------------
export type AgentAuditSink = (context: AgentToolContext, event: AgentAuditEvent) => Promise<void>;
let _testSink: AgentAuditSink | null = null;

export function _setAgentAuditSinkForTest(sink: AgentAuditSink | null): void {
  _testSink = sink;
}

/**
 * Persist one Agent lifecycle event. The caller must supply a business-scoped
 * context; the database row is always tenant/business-injected by insertWithScope.
 *
 * 失败语义：**抛错**。调用方必须决定"记录不下来时该报什么"，
 * 不允许静默当成写成功（见 `executeEnterpriseTool` 的 fail-closed 处理）。
 */
export async function writeAgentAction(
  context: AgentToolContext,
  event: AgentAuditEvent,
): Promise<void> {
  if (_testSink) return _testSink(context, event);
  const result = await insertWithScope(context, 'agent_actions', {
    user_id: context.userId,
    session_id: context.sessionId,
    turn_id: context.turnId,
    tool_call_id: context.toolCallId ?? null,
    agent: 'business-agent',
    tool: event.tool,
    action: event.action,
    input: event.input ?? null,
    result_summary: event.resultSummary ?? null,
    status: event.status,
    error_code: event.errorCode ?? null,
    started_at: event.startedAt,
    completed_at: event.completedAt ?? null,
  });
  if (result.error) throw new Error(`failed to persist agent action: ${result.error.message}`);
}

export function withAgentAudit(context: Omit<AgentToolContext, 'audit'>): AgentToolContext {
  return {
    ...context,
    audit: (event) => writeAgentAction({ ...context, audit: async () => undefined }, event),
  };
}

// ---------------------------------------------------------------------------
// Production Audit Store（audit_events 表）
// 审批生命周期与真实工具执行的统一审计入口。
// ---------------------------------------------------------------------------
import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface AuditEventInput {
  tenantId: string;
  businessId: string;
  userId?: string | null;
  agentId?: string | null;
  toolName?: string | null;
  action: string;
  argumentsHash?: string | null;
  approvalId?: string | null;
  executionId?: string | null;
  result?: unknown;
  actorRole?: string | null;
  status?: string;
}

/** 写入一条审计事件（幂等：同一 execution + action 只写一条）。 */
export async function writeAuditEvent(input: AuditEventInput): Promise<void> {
  const supabase = getSupabaseClient();
  if (input.executionId) {
    const { data: existing } = await supabase.from('audit_events')
      .select('id')
      .eq('tenant_id', input.tenantId)
      .eq('business_id', input.businessId)
      .eq('execution_id', input.executionId)
      .eq('action', input.action)
      .maybeSingle();
    if (existing) return;
  }
  const { error } = await supabase.from('audit_events').insert({
    tenant_id: input.tenantId,
    business_id: input.businessId,
    user_id: input.userId ?? null,
    agent_id: input.agentId ?? null,
    tool_name: input.toolName ?? null,
    action: input.action,
    arguments_hash: input.argumentsHash ?? null,
    approval_id: input.approvalId ?? null,
    execution_id: input.executionId ?? null,
    result: input.result ?? null,
    actor_role: input.actorRole ?? null,
    status: input.status ?? 'ok',
  });
  if (error) {
    // 审计写入失败不阻断业务主流程，但必须留痕。
    console.error('[audit] audit_events write failed:', error.message);
  }
}
