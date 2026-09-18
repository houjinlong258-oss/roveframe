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

/**
 * `claim_agent_task_runs` RPC 的返回行。
 *
 * ⚠️ Phase 15：字段名**必须**是 `out_*`。
 *
 * 该函数此前把 OUT 参数命名为 `id` / `attempt` / `max_attempts` 等，
 * 与表列名重名，PL/pgSQL 里产生二义性，**每次调用都报 42702 而失败**：
 *
 *   column reference "attempt" is ambiguous
 *
 * 而调用方当时写的是 `if (error) return []`，把失败静默成"本轮没有任务"，
 * 于是队列从未被消费却看起来一切正常（21 行 pending 最久 11 天）。
 *
 * 现在 OUT 参数统一加 `out_` 前缀。**改这里必须同步改
 * scripts/migrate.sql 的 returns table 列表**，否则字段名对不上，
 * worker 拿到 undefined 会静默跑偏 —— 又回到同一类故障。
 */
export interface ClaimedTaskRun {
  out_id: string;
  out_tenant_id: string;
  out_business_id: string;
  out_task_id: string;
  out_task_type: string;
  out_payload: Record<string, unknown>;
  out_attempt: number;
  out_max_attempts: number;
  out_idempotency_key: string;
}
