/**
 * P0-20：任务引擎类型与 scripts/migrate.sql 权威 schema 对齐。
 *
 * 权威词汇（以 claim_agent_task_runs 语义为准）：
 *   agent_tasks.status: 'active'（调度中）｜'paused'（暂停）
 *   agent_task_runs.status: 'pending'｜'running'｜'completed'｜'failed'
 *   agent_task_runs.attempt（非 attempt_number）
 * 任务持久字段：task_type/name/schedule_cron/payload/next_run_at/last_run_at。
 */
export type AgentTaskPriority = 'high' | 'medium' | 'low';

export type AgentTaskStatus = 'active' | 'paused';

export type AgentTaskRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentTask {
  id: string;
  tenant_id: string;
  business_id: string;
  task_type: string;
  name: string;
  schedule_cron?: string | null;
  status: AgentTaskStatus;
  payload: Record<string, unknown>;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTaskRun {
  id: string;
  tenant_id: string;
  business_id: string;
  task_id: string;
  attempt: number;
  max_attempts: number;
  status: AgentTaskRunStatus;
  claimed_by?: string | null;
  claimed_at?: string | null;
  idempotency_key: string;
  available_at?: string | null;
  input?: Record<string, unknown> | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
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

/** claim_agent_task_runs RPC 返回行（与迁移 SQL 完全一致）。 */
export interface ClaimedTaskRun {
  id: string;
  tenant_id: string;
  business_id: string;
  task_id: string;
  task_type: string;
  payload: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  idempotency_key: string;
}
