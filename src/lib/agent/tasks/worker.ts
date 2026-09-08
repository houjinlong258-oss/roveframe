import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { buildBriefing } from '@/lib/channels';
import { getSettings } from '@/lib/settings';
import { detectBusinessEvents } from '@/lib/agent/events/detector';
import { enqueueNotification } from '@/lib/notifications/outbox';
import type {
  AgentTaskPriority,
  AgentTaskRunStatus,
  ClaimedTaskRun,
  TaskHandler,
  TaskHandlerContext,
} from './types';

const taskHandlers = new Map<string, TaskHandler>();
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * P0-20：全部读写以 scripts/migrate.sql 权威 schema 为准。
 * 状态词汇：任务 'active'；运行 'pending'→'running'→'completed'|'failed'。
 * 原子认领由 DB 函数 claim_agent_task_runs 完成（要求 run.status='pending'
 * 且 task.status='active'，租约 15 分钟）。
 */

export function buildScheduledRunIdempotencyKey(taskId: string, scheduledFor: string): string {
  return `scheduled:${taskId}:${scheduledFor}`;
}

export function calculateTaskRetryDelayMinutes(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1));
}

export function registerTaskHandler(taskType: string, handler: TaskHandler): void {
  taskHandlers.set(taskType, handler);
}

/**
 * 创建 Agent Task（幂等去重：agent_tasks 唯一索引 (business_id, name)）。
 * 返回已存在时不重复创建。
 */
export async function createAgentTask(opts: {
  tenantId: string;
  businessId: string;
  taskType: string;
  name: string;
  priority?: AgentTaskPriority;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  scheduledAt?: string;
  maxAttempts?: number;
  scheduleCron?: string;
}): Promise<{ ok: true; taskId: string; created: boolean } | { ok: false; error: string }> {
  const supabase = getSupabaseClient();
  const input = opts.input ?? {};
  const context = opts.context ?? {};
  const payload = { ...input, ...(context ?? {}) };
  const scheduledAt = opts.scheduledAt ?? new Date().toISOString();

  // 唯一索引 (business_id, name) 去重
  const { data: existing, error: lookupError } = await supabase
    .from('agent_tasks')
    .select('id')
    .eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId)
    .eq('name', opts.name)
    .maybeSingle();
  if (lookupError) return { ok: false, error: lookupError.message };
  if (existing) return { ok: true, taskId: existing.id, created: false };

  const { data: task, error } = await supabase
    .from('agent_tasks')
    .insert({
      tenant_id: opts.tenantId,
      business_id: opts.businessId,
      task_type: opts.taskType,
      name: opts.name,
      schedule_cron: opts.scheduleCron ?? null,
      status: 'active',
      payload,
      next_run_at: scheduledAt,
    })
    .select('id')
    .single();

  if (error || !task) {
    return { ok: false, error: error?.message ?? 'Failed to insert agent task' };
  }

  // 初始运行记录（权威词汇：pending / attempt）
  await supabase.from('agent_task_runs').insert({
    tenant_id: opts.tenantId,
    business_id: opts.businessId,
    task_id: task.id,
    attempt: 1,
    max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    status: 'pending',
    idempotency_key: `${opts.idempotencyKey ?? `task:${opts.businessId}:${opts.taskType}`}:run:1`,
    available_at: scheduledAt,
    input,
  });

  return { ok: true, taskId: task.id, created: true };
}

/** Enqueues a task run directly（权威词汇 pending/attempt）。 */
export async function enqueueTaskRun(opts: {
  tenantId: string;
  businessId: string;
  taskId: string;
  idempotencyKey?: string;
  input?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<string | null> {
  const key = opts.idempotencyKey ?? `manual:${opts.taskId}:${randomUUID()}`;
  const client = getSupabaseClient();
  const { data, error } = await client.from('agent_task_runs').upsert({
    tenant_id: opts.tenantId,
    business_id: opts.businessId,
    task_id: opts.taskId,
    status: 'pending',
    attempt: 1,
    max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    idempotency_key: key,
    available_at: new Date().toISOString(),
    input: opts.input ?? {},
  }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id').maybeSingle();

  if (error) return null;
  if (data?.id) return data.id;
  const { data: existing } = await client.from('agent_task_runs').select('id')
    .eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId)
    .eq('idempotency_key', key)
    .maybeSingle();
  return existing?.id ?? null;
}

function nextRunAt(task: { next_run_at: string | null; payload?: Record<string, unknown> | null }): string {
  const base = task.next_run_at ? new Date(task.next_run_at).getTime() : Date.now();
  const intervalMinutes = Number(task.payload?.interval_minutes ?? 1440);
  const safeInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.min(intervalMinutes, 7 * 24 * 60) : 1440;
  return new Date(base + safeInterval * 60_000).toISOString();
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function zonedLocalTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 3; i++) {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(guess);
    const value = (type: string): number => Number(formatted.find((part) => part.type === type)?.value ?? 0);
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'));
    const requested = Date.UTC(year, month - 1, day, hour, minute);
    guess = new Date(guess.getTime() + requested - represented);
  }
  return guess;
}

function nextDailyRunAt(timeZone: string, time: string): string {
  const [hourText, minuteText] = time.split(':');
  const hour = Math.max(0, Math.min(23, Number(hourText) || 8));
  const minute = Math.max(0, Math.min(59, Number(minuteText) || 0));
  const now = new Date();
  const today = localDateParts(now, timeZone);
  let candidate = zonedLocalTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    candidate = zonedLocalTimeToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, timeZone);
  }
  return candidate.toISOString();
}

async function initialRunAt(
  tenantId: string,
  businessId: string,
  taskType: string,
): Promise<string> {
  if (taskType !== 'DAILY_BRIEFING' && taskType !== 'daily_briefing') return new Date().toISOString();
  try {
    const settings = await getSettings(tenantId, businessId);
    const locale = (settings.locale ?? {}) as Record<string, unknown>;
    const preferences = (settings.ai_prefs ?? {}) as Record<string, unknown>;
    return nextDailyRunAt(
      typeof locale.timezone === 'string' ? locale.timezone : 'America/New_York',
      typeof preferences.channel_briefing_time === 'string' ? preferences.channel_briefing_time : '08:00',
    );
  } catch {
    return nextDailyRunAt('America/New_York', '08:00');
  }
}

/** Creates system default agent tasks（权威 schema 字段）。 */
export async function ensureSystemAgentTasks(): Promise<number> {
  const client = getSupabaseClient();
  const { data: businesses, error } = await client.from('businesses').select('id, tenant_id');
  if (error) throw new Error(`system task discovery failed: ${error.message}`);

  let created = 0;
  for (const business of (businesses ?? []) as { id: string; tenant_id: string }[]) {
    const definitions = [
      { task_type: 'DAILY_BRIEFING', name: 'Daily Business Briefing', schedule_cron: '0 8 * * *', interval_minutes: 1440 },
      { task_type: 'EVENT_DETECTION', name: 'Business Event Detection', schedule_cron: '*/15 * * * *', interval_minutes: 15 },
    ];
    for (const definition of definitions) {
      const { data: existing } = await client
        .from('agent_tasks').select('id').eq('tenant_id', business.tenant_id)
        .eq('business_id', business.id).eq('name', definition.name).maybeSingle();
      if (existing) continue;

      const res = await createAgentTask({
        tenantId: business.tenant_id,
        businessId: business.id,
        taskType: definition.task_type,
        name: definition.name,
        priority: 'high',
        idempotencyKey: `system:${business.id}:${definition.task_type}`,
        scheduledAt: await initialRunAt(business.tenant_id, business.id, definition.task_type),
        scheduleCron: definition.schedule_cron,
      });

      if (res.ok && res.created) created++;
    }
  }
  return created;
}

/** Enqueues runs for due ACTIVE tasks（next_run_at 推进，任务保持 active）。 */
async function enqueueDueTaskRuns(): Promise<number> {
  const client = getSupabaseClient();
  const now = new Date().toISOString();
  const { data: dueTasks, error } = await client.from('agent_tasks')
    .select('id, tenant_id, business_id, task_type, payload, next_run_at')
    .eq('status', 'active')
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now)
    .order('next_run_at')
    .limit(100);

  if (error || !dueTasks) return 0;

  let enqueued = 0;
  for (const task of dueTasks as { id: string; tenant_id: string; business_id: string; task_type: string; payload: Record<string, unknown> | null; next_run_at: string }[]) {
    const idempotencyKey = buildScheduledRunIdempotencyKey(task.id, task.next_run_at);

    const { error: insertError } = await client.from('agent_task_runs').upsert({
      tenant_id: task.tenant_id,
      business_id: task.business_id,
      task_id: task.id,
      attempt: 1,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      status: 'pending',
      idempotency_key: idempotencyKey,
      available_at: now,
      input: task.payload ?? {},
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true });

    if (!insertError) {
      await client.from('agent_tasks').update({
        next_run_at: nextRunAt({ next_run_at: task.next_run_at, payload: task.payload }),
        updated_at: now,
      }).eq('id', task.id)
        .eq('tenant_id', task.tenant_id)
        .eq('business_id', task.business_id);
      enqueued++;
    }
  }
  return enqueued;
}

/** Claims pending task runs atomically via the DB lease function. */
async function claimTaskRuns(workerId: string, limit: number): Promise<ClaimedTaskRun[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_agent_task_runs', {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(limit, 100)),
  });

  if (error) return [];
  return (data ?? []) as ClaimedTaskRun[];
}

/** Transitions the run to completed（任务保持 active，回写 last_run_at）。 */
async function completeTaskRun(
  run: ClaimedTaskRun,
  resultData: { result?: Record<string, unknown>; waitingApproval?: boolean },
): Promise<void> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const finalStatus: AgentTaskRunStatus = 'completed';

  await supabase.from('agent_task_runs').update({
    status: finalStatus,
    result: { ...(resultData.result ?? {}), waitingApproval: resultData.waitingApproval ?? false },
    completed_at: now,
    claimed_by: null,
    claimed_at: null,
    locked_by: null,
    locked_at: null,
  }).eq('id', run.id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);

  await supabase.from('agent_tasks').update({
    last_run_at: now,
    updated_at: now,
  }).eq('id', run.task_id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);
}

/** Fail and retry / final fail transition（权威词汇 pending/failed，attempt 计数）。 */
async function failTaskRun(workerId: string, run: ClaimedTaskRun, error: unknown): Promise<void> {
  const supabase = getSupabaseClient();
  const message = error instanceof Error ? error.message : 'Task execution failed';
  const currentAttempt = run.attempt || 1;
  const maxAttempts = run.max_attempts || DEFAULT_MAX_ATTEMPTS;
  const retryable = currentAttempt < maxAttempts;
  const nextAttempt = currentAttempt + 1;
  const backoffMinutes = calculateTaskRetryDelayMinutes(currentAttempt);
  const now = new Date();
  const nextAvailableAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();

  await supabase.from('agent_task_runs').update({
    status: retryable ? 'pending' : 'failed',
    error: message.slice(0, 4000),
    available_at: retryable ? nextAvailableAt : null,
    completed_at: retryable ? null : now.toISOString(),
    claimed_by: null,
    claimed_at: null,
    locked_by: null,
    locked_at: null,
  }).eq('id', run.id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);

  if (retryable) {
    // 重试插新运行行（attempt+1）；claim RPC 的租约回收也会把本行重新置 pending，
    // 但显式插入保证退避语义确定。
    await supabase.from('agent_task_runs').insert({
      tenant_id: run.tenant_id,
      business_id: run.business_id,
      task_id: run.task_id,
      attempt: nextAttempt,
      max_attempts: maxAttempts,
      status: 'pending',
      idempotency_key: `${run.idempotency_key}:retry:${nextAttempt}`,
      available_at: nextAvailableAt,
      input: {},
    });
  }
}

function registerDefaultTaskHandlers(): void {
  if (taskHandlers.has('DAILY_BRIEFING') || taskHandlers.has('daily_briefing')) return;

  const dailyBriefingHandler: TaskHandler = async (ctx) => {
    const locale = typeof ctx.input.locale === 'string' ? ctx.input.locale : 'en';
    const message = await buildBriefing(ctx.tenantId, ctx.businessId, locale);
    const dateKey = new Date().toISOString().slice(0, 10);
    // 主通道 Email + 增强通道 Web Push 双投递（幂等键区分通道）。
    const emailNotification = await enqueueNotification({
      tenantId: ctx.tenantId,
      businessId: ctx.businessId,
      channel: 'email',
      notificationType: 'DAILY_BRIEFING',
      title: 'Daily Business Briefing',
      content: message,
      priority: 'normal',
      idempotencyKey: `daily-briefing:${ctx.businessId}:${dateKey}:email`,
    });
    const pushNotification = await enqueueNotification({
      tenantId: ctx.tenantId,
      businessId: ctx.businessId,
      channel: 'web_push',
      notificationType: 'DAILY_BRIEFING',
      title: 'Daily Business Briefing',
      content: message,
      priority: 'normal',
      idempotencyKey: `daily-briefing:${ctx.businessId}:${dateKey}:push`,
    });
    return {
      result: {
        email: { notificationId: emailNotification.id, queued: emailNotification.created },
        webPush: { notificationId: pushNotification.id, queued: pushNotification.created },
      },
      tokenUsage: { prompt_tokens: 150, completion_tokens: 250, total_tokens: 400 },
    };
  };

  registerTaskHandler('DAILY_BRIEFING', dailyBriefingHandler);
  registerTaskHandler('daily_briefing', dailyBriefingHandler);

  const eventDetectionHandler: TaskHandler = async (ctx) => {
    const events = await detectBusinessEvents(ctx.tenantId, ctx.businessId);
    return {
      result: { detectedEventsCount: events.length },
      tokenUsage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
    };
  };

  registerTaskHandler('EVENT_DETECTION', eventDetectionHandler);
  registerTaskHandler('event_detection', eventDetectionHandler);
}

/** Main task worker loop（与 claim 语义对齐：pending → running → completed/failed）。 */
export async function pollAndExecuteTasks(workerId = `worker-${randomUUID().slice(0, 8)}`, limit = 10): Promise<number> {
  registerDefaultTaskHandlers();
  await ensureSystemAgentTasks();
  await enqueueDueTaskRuns();

  const runs = await claimTaskRuns(workerId, limit);
  let executedCount = 0;

  for (const run of runs) {
    const handler = taskHandlers.get(run.task_type);
    if (!handler) {
      await failTaskRun(workerId, run, new Error(`No handler registered for task type: ${run.task_type}`));
      continue;
    }

    // claim RPC 不返回 input：按运行行回读（tenant/business 双 scope，失败回落任务 payload）。
    let input: Record<string, unknown> = run.payload ?? {};
    const { data: runRow, error: runRowError } = await getSupabaseClient()
      .from('agent_task_runs')
      .select('input')
      .eq('id', run.id)
      .eq('tenant_id', run.tenant_id)
      .eq('business_id', run.business_id)
      .maybeSingle();
    if (!runRowError && runRow) {
      input = (runRow as { input?: Record<string, unknown> | null }).input ?? run.payload ?? {};
    }

    const context: TaskHandlerContext = {
      tenantId: run.tenant_id,
      businessId: run.business_id,
      taskId: run.task_id,
      runId: run.id,
      input,
      payload: run.payload ?? {},
      context: run.payload ?? {},
    };

    try {
      const handlerResult = await handler(context);
      await completeTaskRun(run, handlerResult as { result?: Record<string, unknown>; waitingApproval?: boolean });
      executedCount++;
    } catch (error) {
      await failTaskRun(workerId, run, error);
    }
  }

  return executedCount;
}
