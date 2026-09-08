export type AgentTaskPriority = 'high' | 'medium' | 'low';

export type AgentTaskStatusState =
  | 'CREATED'
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'FAILED_FINAL';

export interface AgentTask {
  id: string;
  tenant_id: string;
  business_id: string;
  agent_type: string;
  task_type: string;
  priority: AgentTaskPriority;
  status: AgentTaskStatusState;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  idempotency_key?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTaskRun {
  id: string;
  tenant_id: string;
  business_id: string;
  task_id: string;
  attempt_number: number;
  max_attempts: number;
  status: AgentTaskStatusState;
  worker_id?: string | null;
  idempotency_key: string;
  started_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
  result?: Record<string, unknown> | null;
  token_usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  created_at: string;
}

export interface TaskHandlerContext {
  tenantId: string;
  businessId: string;
  taskId: string;
  runId: string;
  input: Record<string, unknown>;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
}

export type TaskHandlerResult =
  | Record<string, unknown>
  | {
      result?: Record<string, unknown>;
      tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      waitingApproval?: boolean;
      approvalId?: string;
    };

export type TaskHandler = (ctx: TaskHandlerContext) => Promise<TaskHandlerResult>;

export interface ClaimedTaskRun {
  id: string;
  tenant_id: string;
  business_id: string;
  task_id: string;
  agent_type: string;
  task_type: string;
  input: Record<string, unknown>;
  payload?: Record<string, unknown>;
  context: Record<string, unknown>;
  attempt_number: number;
  attempt?: number;
  max_attempts: number;
  idempotency_key: string;
}
