import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';
import { invokeChat } from '@/lib/ai/router';
import { getBusinessContext, contextToPrompt } from '@/lib/business-context';
import { getChannelConfig, listConnectedChannels, sendChannelMessage, buildBriefing } from '@/lib/channels';
import type { ChannelKey } from '@/lib/channels-presets';
import { pollAndExecuteTasks } from '@/lib/agent/tasks/worker';
import { dispatchNotificationOutbox } from '@/lib/notifications/outbox';
import { syncImapAccount } from '@/lib/email/imap-sync';

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
 * 调度器健康状态（供 preflight/health 使用）。
 * cron_state 缺失时不再是静默跳过：health 端点与启动自检必须显式失败并告警。
 */
export function schedulerHealth(): { cronStateReady: boolean | null; degraded: boolean; lastSkipReason: string | null; lastSkipAt: string | null } {
  return {
    cronStateReady: _cronStateReady,
    degraded: _cronStateReady === false,
    lastSkipReason: _lastSkipReason,
    lastSkipAt: _lastSkipAt,
  };
}

async function ensureCronState(): Promise<boolean> {
  if (_cronStateReady !== null) return _cronStateReady;
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('cron_state').select('key', { count: 'exact', head: true });
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
async function maybeSendDailyBriefing(tenantId: string, businessId: string, cfg: SchedulingConfig): Promise<void> {
  const connected = await listConnectedChannels(tenantId, businessId);
  if (connected.length === 0) return;
  const today = dateInTz(cfg.timeZone);
  const state = await getCronState(`daily_briefing.${tenantId}.${businessId}`);
  if (state?.last_date === today) return;
  if (hhmmInTz(cfg.timeZone) < cfg.briefingTime) return;
  const message = await buildBriefing(tenantId, businessId, cfg.lang);
  await broadcast(tenantId, businessId, connected, message);
  await setCronState(`daily_briefing.${tenantId}.${businessId}`, { last_date: today });
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

// ---------- IMAP inbound sync（5 分钟水位；邮件自身以 mailbox + Message-ID/UID 去重） ----------
async function maybeSyncInboundEmail(tenantId: string, businessId: string): Promise<void> {
  const stateKey = `imap_sync.${tenantId}.${businessId}`;
  const state = await getCronState(stateKey);
  const lastSync = typeof state?.last_sync_at === 'string' ? new Date(state.last_sync_at).getTime() : 0;
  if (Number.isFinite(lastSync) && Date.now() - lastSync < 5 * 60_000) return;
  const { data, error } = await getSupabaseClient().from('email_accounts')
    .select('id, tenant_id, business_id, email, imap_host, imap_port, credentials_encrypted')
    .eq('tenant_id', tenantId).eq('business_id', businessId).eq('status', 'active')
    .not('imap_host', 'is', null).limit(5);
  if (error) throw new Error(error.message);
  for (const raw of data ?? []) {
    try {
      await syncImapAccount(raw as Parameters<typeof syncImapAccount>[0]);
    } catch (syncError) {
      console.warn('[scheduler] IMAP sync failed for scoped account:', syncError instanceof Error ? syncError.name : 'unknown_error');
    }
  }
  await setCronState(stateKey, { last_sync_at: new Date().toISOString() });
}

// ---------- 对外入口：每一 tick（60s）调用一次 ----------
export async function runScheduledJobs(): Promise<void> {
  try {
    if (!(await ensureCronState())) return;

    // 1. Run Durable Agent Tasks Engine Worker Loop
    try {
      await pollAndExecuteTasks();
    } catch (taskErr) {
      console.error('[scheduler] durable task worker failed:', taskErr);
    }
    // Delivery is opt-in until Web Push credentials and channel policy are configured.
    if (process.env.ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH === 'true') {
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
      const { data: businesses, error: businessesError } = await getSupabaseClient()
        .from('businesses')
        .select('id')
        .eq('tenant_id', tenant.id);
      if (businessesError) throw new Error(businessesError.message);
      for (const business of (businesses ?? []) as { id: string }[]) {
        const cfg = await getSchedulingConfig(tenant.id, business.id);

        // Detection and delivery now run through durable agent tasks/outbox. The legacy
        // channel briefing remains in place as a migration fallback for connected channels.
        await maybeSendDailyBriefing(tenant.id, business.id, cfg);
        await maybePushAlerts(tenant.id, business.id, cfg);
        await pollTelegram(tenant.id, business.id, cfg);
        await maybeSyncInboundEmail(tenant.id, business.id);
      }
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
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
