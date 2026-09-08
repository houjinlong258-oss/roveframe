import type { RoleKey } from '@/lib/rbac';

export type AgentToolRisk = 'read' | 'write' | 'external_side_effect' | 'destructive';
export type AgentApprovalPolicy = 'none' | 'manager' | 'owner' | 'admin';

export type AgentActionStatus = 'started' | 'succeeded' | 'failed' | 'blocked' | 'timed_out';

export type AgentAuditEvent = {
  tool: string;
  action: string;
  status: AgentActionStatus;
  input?: Record<string, unknown>;
  resultSummary?: string;
  errorCode?: string;
  startedAt: string;
  completedAt?: string;
};

/** Server-created execution scope. Model arguments must never supply these fields. */
export type AgentToolContext = {
  tenantId: string;
  businessId: string;
  userId: string;
  role: RoleKey;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  locale: string;
  timeZone: string;
  audit: (event: AgentAuditEvent) => Promise<void>;
};

export type AgentToolSuccess<TData = unknown> = {
  ok: true;
  data: TData;
};

export type AgentToolFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type AgentToolResult<TData = unknown> = AgentToolSuccess<TData> | AgentToolFailure;

export type AgentToolDefinition<TInput = unknown, TData = unknown> = {
  name: string;
  description: string;
  action: string;
  risk: AgentToolRisk;
  requiredPermission: string;
  requiredPermissions?: readonly string[];
  approvalPolicy?: AgentApprovalPolicy;
  auditCategory?: string;
  timeoutMs: number;
  /** Provider-neutral JSON Schema exposed to LLM-native tool calling. */
  modelInputSchema?: Record<string, unknown>;
  inputSchema: {
    safeParse: (input: unknown) =>
      | { success: true; data: TInput }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  };
  execute: (input: TInput, context: AgentToolContext) => Promise<AgentToolResult<TData>>;
};
