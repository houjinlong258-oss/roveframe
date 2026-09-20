import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';
import { invokeChat } from '@/lib/ai/router';
import { getBusinessContext, contextToPrompt } from '@/lib/business-context';
import { getChannelConfig, listConnectedChannels, sendChannelMessage, buildBriefing } from '@/lib/channels';
import type { ChannelKey } from '@/lib/channels-presets';
import { pollAndExecuteTasks } from '@/lib/agent/tasks/worker';
import { dispatchNotificationOutbox } from '@/lib/notifications/outbox';
import { syncImapAccount } from '@/lib/email/imap-sync';
import { processEmailSendQueue } from '@/lib/email/outgoing';
import { syncSquareBusiness } from '@/lib/connectors/square-sync';
import { purgeOldPositions } from '@/lib/delivery-position';

const DEFAULT_BRIEFING_TIME = '08:00';
const TICK_SKIPPED_MSG =
  '[scheduler] cron_state 表不存在，已跳过定时任务。请在 Supabase SQL 编辑器执行建表语句（见 schema.ts 中 cronState 定义）。';

interface SchedulingConfig {
  timeZone: string;
  lang: string;
  briefingTime: string;
  anomalyPush: boolean;
}

// ---------- cron_state 水位线读写 ----------
let _cronStateReady: boolean | null = null;
let _lastSkipReason: string | null = null;
let _lastSkipAt: string | null = null;

/**
 * 调度器心跳在 cron_state 里的键。
 *
 * Phase 15：为什么状态要落库，而不是只留在模块变量里。
 *
 * `/api/health` 导入的 `src/lib/scheduler.ts` 与 `src/server.ts` 启动的
 * `startScheduler()` **不是同一个模块实例**（Next.js 给不同入口独立实例化）。
 * 实测证据：`cron_state` 在容器启动 18 秒后就被调度器写入（`imap_sync.*`、
 * `square_sync_throttle.*`），说明 tick 确实在跑；而同一时刻 `/api/health`
 * 报 `cronStateReady: null` —— 路由侧那个实例从未被 `ensureCronState()` 置位。
 *
 * 后果：`degraded` 由这个空实例算出，恒为 false，**健康端点永远无法上报调度器降级**。
 *
 * 修法：把"调度器是否活着"变成**落库的事实**，由健康端点读取。
 * 这样无论有几个模块实例、状态在谁身上，health 看到的都是真实调度器写下的证据。
 * 心跳本身不引入任何新依赖，也不新增表（复用 cron_state）。
 */
export const SCHEDULER_HEARTBEAT_KEY = 'scheduler.heartbeat';

/**
 * 健康状态（供 preflight/health 使用）。
 *
 * 判定优先级：
 *   1. **心跳**（权威）：真调度器每 tick 写一行，任何模块实例都能读到；
 *   2. 本实例的 `_cronStateReady`（回退）：心跳还没写过时（冷启动瞬间）用它；
 *   3. 两者都没有 → `degraded: false` 且 `source: 'unknown'`，
 *      **不谎报健康**：调用方能看到"还没有证据"，而不是把 null 当成正常。
 */
export async function schedulerHealth(): Promise<{
  cronStateReady: boolean | null;
  degraded: boolean;
  lastSkipReason: string | null;
  lastSkipAt: string | null;
  lastTickAt: string | null;
  tickAgeMs: number | null;
  source: 'heartbeat' | 'instance' | 'unknown';
}> {
  const heartbeat = await readSchedulerHeartbeat();
  if (heartbeat) {
    return {
      cronStateReady: heartbeat.cronStateReady,
      degraded: heartbeat.cronStateReady === false,
      lastSkipReason: heartbeat.lastSkipReason,
      lastSkipAt: heartbeat.lastSkipAt,
      lastTickAt: heartbeat.at,
      tickAgeMs: Math.max(0, Date.now() - Date.parse(heartbeat.at)),
      source: 'heartbeat',
    };
  }
  const hasInstance = _cronStateReady !== null;
  return {
    cronStateReady: _cronStateReady,
    degraded: _cronStateReady === false,
    lastSkipReason: _lastSkipReason,
    lastSkipAt: _lastSkipAt,
    lastTickAt: null,
    tickAgeMs: null,
    source: hasInstance ? 'instance' : 'unknown',
  };
}

interface SchedulerHeartbeat {
  at: string;
  cronStateReady: boolean;
  lastSkipReason: string | null;
  lastSkipAt: string | null;
}

/** 读调度器心跳。读不到（表缺失 / 无行 / 网络失败）返回 null，绝不抛。 */
async function readSchedulerHeartbeat(): Promise<SchedulerHeartbeat | null> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('cron_state')
      .select('value')
      .eq('key', SCHEDULER_HEARTBEAT_KEY)
      .maybeSingle();
    if (error || !data) return null;
    const value = (data as { value: Record<string, unknown> | null }).value;
    if (!value || typeof value.at !== 'string') return null;
    return {
      at: value.at,
      cronStateReady: value.cronStateReady !== false,
      lastSkipReason: typeof value.lastSkipReason === 'string' ? value.lastSkipReason : null,
      lastSkipAt: typeof value.lastSkipAt === 'string' ? value.lastSkipAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * 写一次心跳。由**真正在跑的**那个调度器实例在每个 tick 调用。
 *
 * 失败必须静默：心跳写不进去（例如 cron_state 缺失）不能反过来影响调度本身，
 * 那只会把"健康信息不可用"升级成"调度不可用"。此时 health 会退到
 * `source:'unknown'`，如实表示"没有证据"，而不是谎报健康。
 */
async function writeSchedulerHeartbeat(cronStateReady: boolean): Promise<void> {
  try {
    const client = getSupabaseClient();
    await client.from('cron_state').upsert(
      {
        key: SCHEDULER_HEARTBEAT_KEY,
        value: {
          at: new Date().toISOString(),
          cronStateReady,
          lastSkipReason: _lastSkipReason,
          lastSkipAt: _lastSkipAt,
        },
      },
      { onConflict: 'key' },
    );
  } catch {
    // 心跳是观测手段，不是调度前提；失败不得影响 tick。
  }
}

async function ensureCronState(): Promise<boolean> {
  if (_cronStateReady !== null) return _cronStateReady;
  try {
    const client = getSupabaseClient();
    // 探测 cron_state 是否存在。必须用列投影而不是 `head: true`：
    // Phase 15 实测，`select('*', {count:'exact', head:true})` 对**不存在的表**
    // 返回 204 且 error 为 null，于是 `!error` 恒成立 → `_cronStateReady` 永远
    // 为 true，`schedulerHealth().degraded` 永远为 false，健康检查会漏报调度器降级。
    // `key` 是 cron_state 的主键列（该表没有 id），投影后 404 才能被检出。
    const { error } = await client.from('cron_state').select('key', { count: 'exact' });
    if (!error) {
      _cronStateReady = true;
      return true;
    }
    _lastSkipReason = error.message;
    _lastSkipAt = new Date().toISOString();
    console.error(`${TICK_SKIPPED_MSG} (原因: ${error.message})`);
    _cronStateReady = false;
    return false;
  } catch (err) {
    _lastSkipReason = err instanceof Error ? err.message : String(err);
    _lastSkipAt = new Date().toISOString();
    console.error(`${TICK_SKIPPED_MSG} (原因: ${_lastSkipReason})`);
    _cronStateReady = false;
    return false;
  }
}

async function getCronState(key: string): Promise<Record<string, unknown> | null> {
  const client = getSupabaseClient();
  const { data } = await client.from('cron_state').select('value').eq('key', key).maybeSingle();
  return (data?.value as Record<string, unknown>) ?? null;
}

async function setCronState(key: string, value: Record<string, unknown>): Promise<void> {
  const client = getSupabaseClient();
  const payload = { key, value, updated_at: new Date().toISOString() };
  const { data } = await client.from('cron_state').select('key').eq('key', key).maybeSingle();
  if (data) {
    await client.from('cron_state').update(payload).eq('key', key);
  } else {
    await client.from('cron_state').insert(payload);
  }
}

// ---------- 时区本地时间 ----------
function formatParts(timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).formatToParts(new Date());
}

function hhmmInTz(timeZone: string): string {
  const p = formatParts(timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
  const h = p.find((x) => x.type === 'hour')?.value ?? '00';
  const m = p.find((x) => x.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

function dateInTz(timeZone: string): string {
  const p = formatParts(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const y = p.find((x) => x.type === 'year')?.value;
  const mo = p.find((x) => x.type === 'month')?.value;
  const d = p.find((x) => x.type === 'day')?.value;
  return `${y}-${mo}-${d}`;
}

async function getSchedulingConfig(tenantId: string, businessId: string): Promise<SchedulingConfig> {
  const settings = await getSettings(tenantId, businessId);
  const locale = (settings.locale ?? {}) as Record<string, unknown>;
  const prefs = (settings.ai_prefs ?? {}) as Record<string, unknown>;
  return {
    timeZone: (locale.timezone as string) || 'America/New_York',
    lang: (locale.language as string) || 'en',
    briefingTime: (prefs.channel_briefing_time as string) || DEFAULT_BRIEFING_TIME,
    anomalyPush: prefs.channel_anomaly_push !== false,
  };
}

// ---------- 双向查询：AI 回复老板 ----------
async function replyToBoss(tenantId: string, businessId: string, lang: string, question: string): Promise<string> {
  const ctx = await getBusinessContext(tenantId, businessId);
  const system =
    lang === 'zh'
      ? '你是 RoveFrame AI COO —— 中小企业 AI 首席运营官。基于店铺真实数据，用 Markdown 简洁回答老板的问题，金额用美元（$）。'
      : 'You are RoveFrame AI COO — an AI Chief Operating Officer for SMBs. Answer concisely in Markdown based on real store data, using USD ($).';
  return invokeChat('agent', [
    { role: 'system', content: `${system}\n\n${contextToPrompt(ctx, lang)}` },
    { role: 'user', content: question },
  ], undefined, { tenantId, businessId }, { agent: 'scheduler:boss-reply' });
}

async function broadcast(tenantId: string, businessId: string, connected: ChannelKey[], text: string): Promise<void> {
  for (const ch of connected) {
    try {
      const config = await getChannelConfig(tenantId, businessId, ch);
      if (config) await sendChannelMessage(ch, config, text);
    } catch (error) {
      console.warn(`[scheduler] ${ch} delivery failed for scoped business:`, error instanceof Error ? error.name : 'unknown_error');
    }
  }
}

// ---------- 每日简报 ----------
/**
 * P0-17：DB 水位原子抢占（update-where-guard + insert on conflict do nothing），
 * 多实例/重叠 tick 下同一商户当日简报恰发送一次。
 */
export async function claimDailyBriefingSlot(tenantId: string, businessId: string, today: string): Promise<boolean> {
  const client = getSupabaseClient();
  const key = `daily_briefing.${tenantId}.${businessId}`;
  const { data, error } = await client.rpc('claim_daily_briefing_slot', {
    p_key: key,
    p_today: today,
  });
  if (error) {
    // RPC 不可用（旧库未跑迁移）→ 回落旧的读-判-写（多实例下可能有极小重复风险）
    console.error('[scheduler] claim_daily_briefing_slot RPC unavailable, falling back:', error.message);
    const state = await getCronState(key);
    if (state?.last_date === today) return false;
    await setCronState(key, { last_date: today });
    return true;
  }
  return data === true;
}

async function maybeSendDailyBriefing(tenantId: string, businessId: string, cfg: SchedulingConfig): Promise<void> {
  const connected = await listConnectedChannels(tenantId, businessId);
  if (connected.length === 0) return;
  const today = dateInTz(cfg.timeZone);
  if (hhmmInTz(cfg.timeZone) < cfg.briefingTime) return;
  // P0-17：先原子抢占当日发送槽位；未抢到（已发送/他实例占用）直接返回。
  if (!(await claimDailyBriefingSlot(tenantId, businessId, today))) return;
  const message = await buildBriefing(tenantId, businessId, cfg.lang);
  await broadcast(tenantId, businessId, connected, message);
}

// ---------- 异常告警推送 ----------
async function maybePushAlerts(tenantId: string, businessId: string, cfg: SchedulingConfig): Promise<void> {
  if (!cfg.anomalyPush) return;
  const connected = await listConnectedChannels(tenantId, businessId);
  if (connected.length === 0) return;
  const client = getSupabaseClient();

  const state = await getCronState(`anomaly_push.${tenantId}.${businessId}`);
  const since = state?.last_pushed_at as string | undefined;
  if (!since) {
    // 首次运行：设基线，不推送历史告警，避免打扰
    await setCronState(`anomaly_push.${tenantId}.${businessId}`, { last_pushed_at: new Date().toISOString() });
    return;
  }

  const { data } = await client
    .from('alerts')
    .select('id, type, level, title, content, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .gt('created_at', since)
    .order('created_at')
    .limit(20);
  const rows = (data ?? []) as { level: string; title: string; content: string; created_at: string }[];
  if (rows.length === 0) return;

  const text = rows
    .map((a) => `${a.level === 'error' ? '🔴' : a.level === 'warning' ? '🟡' : '🔵'} ${a.title}\n${a.content}`)
    .join('\n\n');
  await broadcast(tenantId, businessId, connected, text);
  await setCronState(`anomaly_push.${tenantId}.${businessId}`, { last_pushed_at: rows[rows.length - 1].created_at });
}

// ---------- Telegram 双向查询（长轮询，无需公网 webhook） ----------
async function pollTelegram(tenantId: string, businessId: string, cfg: SchedulingConfig): Promise<void> {
  const config = await getChannelConfig(tenantId, businessId, 'telegram');
  const token = config?.botToken?.trim();
  if (!token) return;

  const state = await getCronState(`telegram_offset.${tenantId}.${businessId}`);
  const offset = (state?.offset as number) ?? 0;
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ''}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return;
  const body = (await resp.json()) as { result?: { update_id: number; message?: { chat?: { id: number }; text?: string } }[] };
  const updates = body.result ?? [];
  if (updates.length === 0) return;

  let lastId = offset;
  for (const u of updates) {
    if (!u?.message) continue;
    lastId = Math.max(lastId, u.update_id ?? 0);
    const text = u.message.text ?? '';
    const chatId = u.message.chat?.id;
    if (!text.trim() || !chatId) continue;
    try {
      const answer = await replyToBoss(tenantId, businessId, cfg.lang, text);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: answer }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      console.warn('[scheduler] Telegram reply failed:', error instanceof Error ? error.name : 'unknown_error');
    }
  }
  await setCronState(`telegram_offset.${tenantId}.${businessId}`, { offset: lastId + 1 });
}

// ---------- Square 定时同步（15 分钟节流；游标/水位由 square-sync 持久化） ----------
// P0：失败绝不再推进水位。原实现在 catch 之后无条件 setCronState(last_sync_at)，
// 于是「同步抛错」被记录成「刚刚同步成功」，15 分钟节流随即抑制重试 ——
// 订单可能永远不再对账，而外部只能看到一个 error.name 的 console.warn。
// 现在的语义：
//   last_attempt_at  每次尝试都写（用于节流 + 失败退避）
//   last_success_at  仅在成功时写（真正的水位）
//   consecutive_failures  失败累加，成功清零
async function maybeSyncSquare(tenantId: string, businessId: string): Promise<void> {
  const stateKey = `square_sync_throttle.${tenantId}.${businessId}`;
  const state = await getCronState(stateKey);
  const failures = typeof state?.consecutive_failures === 'number' ? state.consecutive_failures : 0;
  const lastAttempt = typeof state?.last_attempt_at === 'string' ? new Date(state.last_attempt_at).getTime() : 0;
  // 基准 15 分钟保持原有节奏；连续失败按 2 次方退避，封顶 60 分钟。
  const intervalMs = Math.min(60 * 60_000, 15 * 60_000 * 2 ** Math.min(failures, 2));
  if (Number.isFinite(lastAttempt) && lastAttempt > 0 && Date.now() - lastAttempt < intervalMs) return;

  const now = new Date().toISOString();
  try {
    await syncSquareBusiness(tenantId, businessId);
    await setCronState(stateKey, {
      last_attempt_at: now,
      last_success_at: now,
      consecutive_failures: 0,
      last_error: null,
    });
  } catch (syncError) {
    await setCronState(stateKey, {
      last_attempt_at: now,
      last_success_at: state?.last_success_at ?? null,
      consecutive_failures: failures + 1,
      last_error: syncError instanceof Error ? syncError.message : String(syncError),
    });
    console.warn(
      `[scheduler] square sync failed (attempt ${failures + 1}, retry in ${Math.round(Math.min(60 * 60_000, 15 * 60_000 * 2 ** Math.min(failures + 1, 2)) / 60_000)}m):`,
      syncError instanceof Error ? syncError.message : String(syncError),
    );
  }
}

// ---------- IMAP inbound sync（5 分钟水位；邮件自身以 mailbox + Message-ID/UID 去重） ----------
// P0：与 Square 同理 —— 失败不得推进水位。原实现在循环内吞掉每个账号的异常后
// 仍然写 last_sync_at，于是「一封邮件都没导进来」被记成「刚刚同步成功」。
// 现在只要本轮存在失败账号，就不写 last_success_at，并累加 consecutive_failures。
async function maybeSyncInboundEmail(tenantId: string, businessId: string): Promise<void> {
  const stateKey = `imap_sync.${tenantId}.${businessId}`;
  const state = await getCronState(stateKey);
  const failures = typeof state?.consecutive_failures === 'number' ? state.consecutive_failures : 0;
  const lastAttempt = typeof state?.last_attempt_at === 'string' ? new Date(state.last_attempt_at).getTime() : 0;
  // 基准 5 分钟保持原有节奏；连续失败退避封顶 30 分钟。
  const intervalMs = Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.min(failures, 2));
  if (Number.isFinite(lastAttempt) && lastAttempt > 0 && Date.now() - lastAttempt < intervalMs) return;

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseClient().from('email_accounts')
    .select('id, tenant_id, business_id, email, imap_host, imap_port, credentials_encrypted')
    .eq('tenant_id', tenantId).eq('business_id', businessId).eq('status', 'active')
    .not('imap_host', 'is', null).limit(5);
  if (error) {
    await setCronState(stateKey, {
      last_attempt_at: now,
      last_success_at: state?.last_success_at ?? null,
      consecutive_failures: failures + 1,
      last_error: `email_accounts query failed: ${error.message}`,
    });
    throw new Error(error.message);
  }

  let failedAccounts = 0;
  let lastError: string | null = null;
  for (const raw of data ?? []) {
    try {
      await syncImapAccount(raw as Parameters<typeof syncImapAccount>[0]);
    } catch (syncError) {
      failedAccounts += 1;
      lastError = syncError instanceof Error ? syncError.message : String(syncError);
      console.warn('[scheduler] IMAP sync failed for scoped account:', lastError);
    }
  }

  const accountCount = (data ?? []).length;
  const allFailed = accountCount > 0 && failedAccounts === accountCount;
  if (failedAccounts > 0) {
    await setCronState(stateKey, {
      last_attempt_at: now,
      // 只要有一个账号失败就不推进成功水位：宁可下轮重复扫描（有去重兜底），
      // 也不能把「全部失败」记成「已同步」。
      last_success_at: state?.last_success_at ?? null,
      consecutive_failures: failures + 1,
      last_error: lastError,
    });
    if (allFailed) {
      console.warn(`[scheduler] IMAP sync failed for all ${accountCount} scoped account(s); watermark NOT advanced`);
    }
    return;
  }

  await setCronState(stateKey, {
    last_attempt_at: now,
    last_success_at: now,
    consecutive_failures: 0,
    last_error: null,
  });
}

// ---------- 对外入口：每一 tick（60s）调用一次 ----------
// P0-17：模块级 in-flight 锁 —— 上一 tick 未结束则跳过本轮，避免重叠
// tick 导致 cron_state 读-判-写竞态与重复外发；卡死超过上限强制续跑。
const TICK_STALL_TIMEOUT_MS = 10 * 60_000;
let _tickInFlight = false;
let _tickStartedAt = 0;

export function _resetTickLockForTests(): void {
  _tickInFlight = false;
  _tickStartedAt = 0;
}

export function _forceTickInFlightForTests(): void {
  _tickInFlight = true;
  _tickStartedAt = Date.now();
}

async function runScheduledJobsInner(): Promise<void> {
  try {
    const ready = await ensureCronState();
    // Phase 15：每 tick 写一次心跳，**包括降级路径** —— 否则 cron_state 缺失时
    // 心跳停摆，health 会退到 source:'unknown'，而真实原因（表缺失）就丢了。
    await writeSchedulerHeartbeat(ready);
    if (!ready) return;

    // 1. Run Durable Agent Tasks Engine Worker Loop
    try {
      await pollAndExecuteTasks();
    } catch (taskErr) {
      console.error('[scheduler] durable task worker failed:', taskErr);
    }
    // 真实外发出件（召回活动/营销邮件）：队列 → SMTP → sent/failed。每 tick 必跑。
    try {
      await processEmailSendQueue();
    } catch (emailOutErr) {
      console.error('[scheduler] email send queue worker failed:', emailOutErr);
    }

    // Web Push 出件（默认开启；仅当显式设置 === 'false' 时关闭）。
    if (process.env.ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH !== 'false') {
      try {
        await dispatchNotificationOutbox();
      } catch (notificationErr) {
        console.error('[scheduler] notification outbox worker failed:', notificationErr);
      }
    }

    const { data: tenants, error } = await getSupabaseClient()
      .from('tenants')
      .select('id')
      .eq('status', 'active');
    if (error) throw new Error(error.message);

    for (const tenant of (tenants ?? []) as { id: string }[]) {
      let businesses: { id: string }[] = [];
      try {
        const { data, error: businessesError } = await getSupabaseClient()
          .from('businesses')
          .select('id')
          .eq('tenant_id', tenant.id);
        if (businessesError) throw new Error(businessesError.message);
        businesses = (data ?? []) as { id: string }[];
      } catch (tenantError) {
        // P0-17：单租户失败不得中断整轮 —— 记录并继续其余租户。
        console.error('[scheduler] business list failed for tenant:', tenantError instanceof Error ? tenantError.message : tenantError);
        continue;
      }
      for (const business of businesses) {
        // P0-17：逐 business 独立 try/catch —— 任一门店配置/任务异常不跳过其它门店。
        try {
          const cfg = await getSchedulingConfig(tenant.id, business.id);

          // Detection and delivery now run through durable agent tasks/outbox. The legacy
          // channel briefing remains in place as a migration fallback for connected channels.
          await maybeSendDailyBriefing(tenant.id, business.id, cfg);
          await maybePushAlerts(tenant.id, business.id, cfg);
          await pollTelegram(tenant.id, business.id, cfg);
          await maybeSyncInboundEmail(tenant.id, business.id);
          await maybeSyncSquare(tenant.id, business.id);

          // Phase 18 / P18-10：骑手位置的保留期清理。
          //
          // 位置是**员工位置数据**，只在配送进行中由骑手设备显式上报，因此必须
          // 有到期删除的机制，而不是"先留着以后再说"。清理放在这个已有的
          // tenants → businesses 循环里，不另起调度器：这里本来每 tick 就会走到
          // 每个门店，多一条 DELETE（`purgeOldPositions` 单条语句删完，
          // 保留期默认 24 小时，可由 settings.delivery.positionRetentionHours 覆盖）。
          //
          // 幂等：删的都是 recorded_at 早于截止点的行，重复执行只会是第二次数到 0。
          try {
            const purgedPositions = await purgeOldPositions(tenant.id, business.id);
            // 0 才是常态（绝大多数 tick 没有任何过期行），逐 tick 打 0 会把日志里
            // 真正有意义的那一行淹掉；只有真的删了行才留证据。
            if (purgedPositions > 0) {
              console.log(
                `[scheduler] purged ${purgedPositions} expired delivery position(s) for ${tenant.id}/${business.id}`,
              );
            }
          } catch (positionPurgeError) {
            // 清理失败不得中断本门店的其余任务，但也绝不静默：位置超期留存是
            // 隐私问题，必须能在日志里看见。
            console.error(
              `[scheduler] delivery position purge failed for ${tenant.id}/${business.id}:`,
              positionPurgeError instanceof Error ? positionPurgeError.message : positionPurgeError,
            );
          }
        } catch (businessError) {
          console.error(
            `[scheduler] tick failed for business ${tenant.id}/${business.id}:`,
            businessError instanceof Error ? businessError.message : businessError,
          );
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
  }
}

export async function runScheduledJobs(): Promise<void> {
  if (_tickInFlight) {
    if (Date.now() - _tickStartedAt < TICK_STALL_TIMEOUT_MS) {
      console.warn('[scheduler] skip tick: previous tick still in flight');
      return;
    }
    console.error('[scheduler] previous tick stalled beyond timeout; forcing re-entry');
  }
  _tickInFlight = true;
  _tickStartedAt = Date.now();
  try {
    await runScheduledJobsInner();
  } finally {
    _tickInFlight = false;
  }
}

// 供 server.ts 启动间隔任务
export function startScheduler(intervalMs = 60_000): NodeJS.Timeout {
  // 启动后立即跑一次，之后每 intervalMs 一次
  void runScheduledJobs();
  return setInterval(() => {
    void runScheduledJobs();
  }, intervalMs);
}
