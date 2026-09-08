import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { buildBriefing } from '@/lib/channels';
import { getSettings } from '@/lib/settings';
import { detectBusinessEvents } from '@/lib/agent/events/detector';
import { enqueueNotification } from '@/lib/notifications/outbox';
import type { AgentTaskPriority, AgentTaskStatusState, ClaimedTaskRun, TaskHandler, TaskHandlerContext } from './types';

const taskHandlers = new Map<string, TaskHandler>();
const DEFAULT_MAX_ATTEMPTS = 3;

export function buildScheduledRunIdempotencyKey(taskId: string, scheduledFor: string): string {
  return `scheduled:${taskId}:${scheduledFor}`;
}

export function calculateTaskRetryDelayMinutes(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1));
}

export function registerTaskHandler(taskType: string, handler: TaskHandler): void {
  taskHandlers.set(taskType, handler);
}

/** Helper to create an Agent Task with idempotency deduplication. */
export async function createAgentTask(opts: {
  tenantId: string;
  businessId: string;
  agentType?: string;
  taskType: string;
  name: string;
  priority?: AgentTaskPriority;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  scheduledAt?: string;
  maxAttempts?: number;
}): Promise<{ ok: true; taskId: string; created: boolean } | { ok: false; error: string }> {
  const supabase = getSupabaseClient();
  const agentType = opts.agentType ?? 'coo-agent';
  const priority = opts.priority ?? 'medium';
  const input = opts.input ?? {};
  const context = opts.context ?? {};
  const idempotencyKey = opts.idempotencyKey ?? `task:${opts.businessId}:${opts.taskType}:${randomUUID()}`;
  const scheduledAt = opts.scheduledAt ?? new Date().toISOString();

  // Check deduplication via idempotencyKey
  if (opts.idempotencyKey) {
    const { data: existing } = await supabase
      .from('agent_tasks')
      .select('id, status')
      .eq('tenant_id', opts.tenantId)
      .eq('business_id', opts.businessId)
      .eq('idempotency_key', opts.idempotencyKey)
      .maybeSingle();

    if (existing) {
      return { ok: true, taskId: existing.id, created: false };
    }
  }

  // Create Task in QUEUED status
  const { data: task, error } = await supabase
    .from('agent_tasks')
    .insert({
      tenant_id: opts.tenantId,
      business_id: opts.businessId,
      agent_type: agentType,
      task_type: opts.taskType,
      name: opts.name,
      priority,
      status: 'QUEUED',
      input,
      context,
      idempotency_key: idempotencyKey,
      scheduled_at: scheduledAt,
    })
    .select('id')
    .single();

  if (error || !task) {
    return { ok: false, error: error?.message ?? 'Failed to insert agent task' };
  }

  // Create initial Run entry
  await supabase.from('agent_task_runs').insert({
    tenant_id: opts.tenantId,
    business_id: opts.businessId,
    task_id: task.id,
    attempt_number: 1,
    max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    status: 'QUEUED',
    idempotency_key: `${idempotencyKey}:run:1`,
    available_at: scheduledAt,
    input,
  });

  return { ok: true, taskId: task.id, created: true };
}

/** Enqueues a task run directly. */
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
    status: 'QUEUED',
    attempt_number: 1,
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

function nextRunAt(task: { next_run_at: string; payload?: Record<string, unknown> | null }): string {
  const intervalMinutes = Number(task.payload?.interval_minutes ?? 1440);
  const safeInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.min(intervalMinutes, 7 * 24 * 60) : 1440;
  return new Date(new Date(task.next_run_at).getTime() + safeInterval * 60_000).toISOString();
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

/** Creates system default agent tasks. */
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
        agentType: 'coo-agent',
        taskType: definition.task_type,
        name: definition.name,
        priority: 'high',
        idempotencyKey: `system:${business.id}:${definition.task_type}`,
        scheduledAt: await initialRunAt(business.tenant_id, business.id, definition.task_type),
      });

      if (res.ok && res.created) created++;
    }
  }
  return created;
}

/** Enqueues task runs for due tasks. */
async function enqueueDueTaskRuns(): Promise<number> {
  const client = getSupabaseClient();
  const now = new Date().toISOString();
  const { data: dueTasks, error } = await client.from('agent_tasks')
    .select('id, tenant_id, business_id, agent_type, task_type, input, context, next_run_at')
    .in('status', ['active', 'QUEUED', 'COMPLETED'])
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now)
    .order('next_run_at')
    .limit(100);

  if (error || !dueTasks) return 0;

  let enqueued = 0;
  for (const task of dueTasks as { id: string; tenant_id: string; business_id: string; agent_type: string; task_type: string; input: Record<string, unknown> | null; context: Record<string, unknown> | null; next_run_at: string }[]) {
    const idempotencyKey = buildScheduledRunIdempotencyKey(task.id, task.next_run_at);

    const { error: insertError } = await client.from('agent_task_runs').upsert({
      tenant_id: task.tenant_id,
      business_id: task.business_id,
      task_id: task.id,
      attempt_number: 1,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      status: 'QUEUED',
      idempotency_key: idempotencyKey,
      available_at: now,
      input: task.input ?? {},
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true });

    if (!insertError) {
      await client.from('agent_tasks').update({
        status: 'QUEUED',
        next_run_at: nextRunAt({ next_run_at: task.next_run_at }),
        updated_at: now,
      }).eq('id', task.id)
        .eq('tenant_id', task.tenant_id)
        .eq('business_id', task.business_id);
      enqueued++;
    }
  }
  return enqueued;
}

/** Claims queued task runs atomically using database locking. */
async function claimTaskRuns(workerId: string, limit: number): Promise<ClaimedTaskRun[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_agent_task_runs', {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(limit, 100)),
  });

  if (error) return [];
  return (data ?? []) as ClaimedTaskRun[];
}

/** Transitions task and task run to COMPLETED or WAITING_APPROVAL status. */
async function completeTaskRun(
  run: ClaimedTaskRun,
  resultData: { result?: Record<string, unknown>; tokenUsage?: Record<string, number>; waitingApproval?: boolean },
): Promise<void> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const finalStatus: AgentTaskStatusState = resultData.waitingApproval ? 'WAITING_APPROVAL' : 'COMPLETED';

  await supabase.from('agent_task_runs').update({
    status: finalStatus,
    result: resultData.result ?? {},
    token_usage: resultData.tokenUsage ?? null,
    finished_at: now,
    completed_at: now,
    claimed_by: null,
    claimed_at: null,
    locked_by: null,
    locked_at: null,
  }).eq('id', run.id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);

  await supabase.from('agent_tasks').update({
    status: finalStatus,
    completed_at: now,
    updated_at: now,
  }).eq('id', run.task_id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);
}

/** Fail and retry / final fail transition according to attempt count. */
async function failTaskRun(workerId: string, run: ClaimedTaskRun, error: unknown): Promise<void> {
  const supabase = getSupabaseClient();
  const message = error instanceof Error ? error.message : 'Task execution failed';
  const currentAttempt = run.attempt_number || 1;
  const maxAttempts = run.max_attempts || DEFAULT_MAX_ATTEMPTS;
  const retryable = currentAttempt < maxAttempts;
  const nextAttempt = currentAttempt + 1;

  const nextStatus: AgentTaskStatusState = retryable ? 'RETRYING' : 'FAILED_FINAL';
  const taskStatus: AgentTaskStatusState = retryable ? 'QUEUED' : 'FAILED_FINAL';
  const backoffMinutes = calculateTaskRetryDelayMinutes(currentAttempt);
  const now = new Date();
  const nextAvailableAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();

  await supabase.from('agent_task_runs').update({
    status: nextStatus,
    error_message: message.slice(0, 4000),
    error: message.slice(0, 4000),
    finished_at: retryable ? null : now.toISOString(),
    completed_at: retryable ? null : now.toISOString(),
    claimed_by: null,
    claimed_at: null,
    locked_by: null,
    locked_at: null,
  }).eq('id', run.id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);

  await supabase.from('agent_tasks').update({
    status: taskStatus,
    updated_at: now.toISOString(),
  }).eq('id', run.task_id)
    .eq('tenant_id', run.tenant_id)
    .eq('business_id', run.business_id);

  if (retryable) {
    // Insert new task run for the next retry attempt
    await supabase.from('agent_task_runs').insert({
      tenant_id: run.tenant_id,
      business_id: run.business_id,
      task_id: run.task_id,
      attempt_number: nextAttempt,
      max_attempts: maxAttempts,
      status: 'QUEUED',
      idempotency_key: `${run.idempotency_key}:retry:${nextAttempt}`,
      available_at: nextAvailableAt,
      input: run.input ?? {},
    });
  }
}

function registerDefaultTaskHandlers(): void {
  if (taskHandlers.has('DAILY_BRIEFING') || taskHandlers.has('daily_briefing')) return;

  const dailyBriefingHandler: TaskHandler = async (ctx) => {
    const locale = typeof ctx.input.locale === 'string' ? ctx.input.locale : 'en';
    const message = await buildBriefing(ctx.tenantId, ctx.businessId, locale);
    const notification = await enqueueNotification({
      tenantId: ctx.tenantId,
      businessId: ctx.businessId,
      channel: 'web_push',
      notificationType: 'DAILY_BRIEFING',
      title: 'Daily Business Briefing',
      content: message,
      priority: 'normal',
      idempotencyKey: `daily-briefing:${ctx.businessId}:${new Date().toISOString().slice(0, 10)}`,
    });
    return {
      result: { notificationId: notification.id, queued: notification.created },
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

/** Main task worker loop. */
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

    const context: TaskHandlerContext = {
      tenantId: run.tenant_id,
      businessId: run.business_id,
      taskId: run.task_id,
      runId: run.id,
      input: run.input ?? {},
      payload: run.input ?? {},
      context: run.context ?? {},
    };

    try {
      const handlerResult = await handler(context);
      await completeTaskRun(run, handlerResult);
      executedCount++;
    } catch (error) {
      await failTaskRun(workerId, run, error);
    }
  }

  return executedCount;
}
