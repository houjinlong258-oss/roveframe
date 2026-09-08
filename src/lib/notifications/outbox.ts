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
  const items = await claimNotificationOutbox(workerId, limit);
  let sent = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (item.channel === 'web_push') {
        await dispatchWebPushToBusiness({
          tenantId: item.tenant_id,
          businessId: item.business_id,
          title: item.title,
          body: item.content,
          data: { eventId: item.event_id, notificationType: item.notification_type },
          userId: item.user_id,
        });
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
