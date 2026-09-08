import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { dispatchWebPushToBusiness } from './push';
import { sendEmailWithDefaultAccount } from '@/lib/email/outgoing';

export type NotificationChannel = 'web_push' | 'email' | 'whatsapp' | 'telegram' | 'sms';

export interface NotificationOutboxItem {
  id: string;
  tenant_id: string;
  business_id: string;
  event_id: string | null;
  user_id: string | null;
  channel: NotificationChannel;
  notification_type: string;
  title: string;
  content: string;
  priority: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
}

/** Writes a notification to notifications table & notification_outbox. */
export async function enqueueNotification(input: {
  tenantId: string;
  businessId: string;
  eventId?: string | null;
  userId?: string | null;
  channel: NotificationChannel;
  notificationType: string;
  title: string;
  content: string;
  priority?: string;
  idempotencyKey: string;
  maxAttempts?: number;
  availableAt?: string;
}): Promise<{ id: string | null; created: boolean }> {
  const client = getSupabaseClient();

  // 1. Insert into notifications table for UI/dashboard storage
  await client.from('notifications').insert({
    tenant_id: input.tenantId,
    business_id: input.businessId,
    user_id: input.userId ?? null,
    type: input.notificationType,
    title: input.title,
    content: input.content,
    priority: input.priority ?? 'normal',
    status: 'unread',
  });

  // 2. Insert into notification_outbox for transport delivery
  const row = {
    tenant_id: input.tenantId,
    business_id: input.businessId,
    event_id: input.eventId ?? null,
    user_id: input.userId ?? null,
    channel: input.channel,
    notification_type: input.notificationType,
    title: input.title,
    content: input.content,
    priority: input.priority ?? 'normal',
    status: 'queued',
    idempotency_key: input.idempotencyKey,
    max_attempts: input.maxAttempts ?? 3,
    available_at: input.availableAt ?? new Date().toISOString(),
  };

  const { data, error } = await client
    .from('notification_outbox')
    .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`notification outbox enqueue failed: ${error.message}`);
  if (data?.id) return { id: data.id, created: true };

  const { data: existing } = await client
    .from('notification_outbox')
    .select('id')
    .eq('idempotency_key', input.idempotencyKey)
    .eq('tenant_id', input.tenantId)
    .eq('business_id', input.businessId)
    .maybeSingle();

  return { id: existing?.id ?? null, created: false };
}

/** Claims a bounded batch using the database lease function. */
export async function claimNotificationOutbox(
  workerId = `notification-${randomUUID().slice(0, 8)}`,
  limit = 20,
): Promise<NotificationOutboxItem[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_notification_outbox', {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(limit, 100)),
  });
  if (error) return [];
  return (data ?? []) as NotificationOutboxItem[];
}

/** P0-15：outbox 租约超时（与 email_send_tasks 同口径 15 分钟）。 */
export const OUTBOX_LEASE_TIMEOUT_MS = 15 * 60_000;

/**
 * P0-15：回收崩溃残留的 sending 行（租约过期 → queued 重发 / failed）。
 * 与 email_send_tasks 同构：claimed_at 超时后按 attempts/backoff 重试。
 */
export async function recoverStaleOutboxItems(): Promise<{ requeued: number; failed: number }> {
  const client = getSupabaseClient();
  const cutoffIso = new Date(Date.now() - OUTBOX_LEASE_TIMEOUT_MS).toISOString();
  const { data, error } = await client.from('notification_outbox')
    .select('id, tenant_id, business_id, status, claimed_at, attempts, max_attempts')
    .eq('status', 'sending')
    .lte('claimed_at', cutoffIso)
    .limit(100);
  if (error) {
    console.error('[notifications/outbox] stale lease lookup failed:', error.message);
    return { requeued: 0, failed: 0 };
  }
  let requeued = 0;
  let failed = 0;
  const nowMs = Date.now();
  for (const raw of data ?? []) {
    const row = raw as typeof raw & { claimed_at: string | null; attempts: number | null; max_attempts: number | null };
    if (!row.claimed_at) continue;
    const claimedAt = new Date(row.claimed_at).getTime();
    if (Number.isNaN(claimedAt) || nowMs - claimedAt < OUTBOX_LEASE_TIMEOUT_MS) continue;
    const nextAttempts = Number(row.attempts ?? 0) + 1;
    const maxAttempts = Number(row.max_attempts ?? 3);
    const toFailed = nextAttempts >= maxAttempts;
    const patch = toFailed
      ? {
          status: 'failed',
          attempts: nextAttempts,
          last_error: 'outbox lease expired; recovered as failed',
          claimed_by: null,
          claimed_at: null,
        }
      : {
          status: 'queued',
          attempts: nextAttempts,
          available_at: new Date(nowMs).toISOString(),
          last_error: 'outbox lease expired; requeued',
          claimed_by: null,
          claimed_at: null,
        };
    const { error: updateError } = await client.from('notification_outbox')
      .update(patch)
      .eq('id', row.id)
      .eq('tenant_id', row.tenant_id)
      .eq('business_id', row.business_id)
      .eq('status', 'sending')
      .eq('claimed_at', row.claimed_at);
    if (updateError) continue;
    if (toFailed) failed += 1;
    else requeued += 1;
  }
  return { requeued, failed };
}

interface OwnerRow { id: string; email: string }

/** Email 通道：把通知真实发送给该 business 的 owner 邮箱。 */
async function dispatchEmailNotification(item: NotificationOutboxItem): Promise<void> {
  const supabase = getSupabaseClient();
  let ownersQuery = supabase.from('users').select('id, email')
    .eq('tenant_id', item.tenant_id).eq('business_id', item.business_id).eq('role', 'owner');
  if (item.user_id) ownersQuery = ownersQuery.eq('id', item.user_id);
  const { data: owners, error: ownersError } = await ownersQuery;
  if (ownersError) throw new Error(`Owner email lookup failed: ${ownersError.message}`);
  const recipients = (owners ?? []) as OwnerRow[];
  if (recipients.length === 0) throw new Error('No owner recipients configured for email notifications');
  const failures: string[] = [];
  for (const owner of recipients) {
    try {
      await sendEmailWithDefaultAccount(
        item.tenant_id, item.business_id, owner.email, item.title, item.content,
      );
    } catch (sendError) {
      failures.push(owner.email + ': ' + (sendError instanceof Error ? sendError.message : String(sendError)));
    }
  }
  if (failures.length === recipients.length) {
    throw new Error('Email notification delivery failed for all owners: ' + failures.join(' | '));
  }
}

/** Delivers claimed intents via Web Push adapter. */
export async function dispatchNotificationOutbox(
  workerId = `notification-${randomUUID().slice(0, 8)}`,
  limit = 20,
): Promise<{ processed: number; sent: number; failed: number }> {
  const client = getSupabaseClient();
  // P0-15：先回收崩溃残留的 sending 行，避免通知永久卡死。
  await recoverStaleOutboxItems();
  const items = await claimNotificationOutbox(workerId, limit);
  let sent = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (item.channel === 'web_push') {
        // P0-16：瞬时失败/零送达视为未完成（抛出 → 下方按 attempts/backoff 重试）；
        // 无订阅为终端失败（不重试）。
        const result = await dispatchWebPushToBusiness({
          tenantId: item.tenant_id,
          businessId: item.business_id,
          title: item.title,
          body: item.content,
          data: { eventId: item.event_id, notificationType: item.notification_type },
          userId: item.user_id,
        });
        if (result.noSubscribers) {
          await client
            .from('notification_outbox')
            .update({
              status: 'failed',
              attempts: item.max_attempts,
              last_error: 'no push subscriptions for recipients',
              claimed_by: null,
              claimed_at: null,
            })
            .eq('id', item.id)
            .eq('tenant_id', item.tenant_id)
            .eq('business_id', item.business_id);
          failed++;
          continue;
        }
        if (result.sent === 0 || result.failed > 0) {
          throw new Error(
            `web push delivery incomplete: ${result.sent} sent, ${result.failed} failed, ${result.deleted} deleted`,
          );
        }
      } else if (item.channel === 'email') {
        await dispatchEmailNotification(item);
      } else {
        throw new Error(`Unsupported notification channel: ${item.channel}`);
      }

      await client
        .from('notification_outbox')
        .update({ status: 'sent', sent_at: new Date().toISOString(), claimed_by: null, claimed_at: null })
        .eq('id', item.id)
        .eq('tenant_id', item.tenant_id)
        .eq('business_id', item.business_id);
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'notification delivery failed';
      const retryable = item.attempts < item.max_attempts;
      const backoffMinutes = Math.min(60, 2 ** Math.max(0, item.attempts - 1));
      await client
        .from('notification_outbox')
        .update({
          status: retryable ? 'queued' : 'failed',
          available_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          claimed_by: null,
          claimed_at: null,
        })
        .eq('id', item.id)
        .eq('tenant_id', item.tenant_id)
        .eq('business_id', item.business_id);
      failed++;
    }
  }

  return { processed: items.length, sent, failed };
}
