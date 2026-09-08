import { insertWithScope } from '@/lib/tenant-db';
import type { AgentAuditEvent, AgentToolContext } from '@/lib/agent/types';

/**
 * Persist one Agent lifecycle event. The caller must supply a business-scoped
 * context; the database row is always tenant/business-injected by insertWithScope.
 */
export async function writeAgentAction(
  context: AgentToolContext,
  event: AgentAuditEvent,
): Promise<void> {
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
