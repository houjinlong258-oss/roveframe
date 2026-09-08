import { getSupabaseClient } from '@/storage/database/supabase-client';
import webpush, { type PushSubscription } from 'web-push';

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, unknown>;
}

/**
 * P0-16：结构化投递结果。调用方必须遵守：
 * - noSubscribers=true → 终端失败（无订阅，重试无意义）；
 * - 否则 sent===0 或 failed>0 → 视为未完成，由 outbox 按 attempts/backoff 重试；
 * - 410/404 只删除订阅（deleted），不计入 failed（不阻塞其它订阅的成功）。
 */
export interface PushDispatchResult {
  sent: number;
  failed: number;
  deleted: number;
  noSubscribers: boolean;
}

/** Dispatches a Web Push notification to registered subscriptions for a business. */
export async function dispatchWebPushToBusiness(opts: {
  tenantId: string;
  businessId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  userId?: string | null;
}): Promise<PushDispatchResult> {
  const supabase = getSupabaseClient();
  let ownersQuery = supabase.from('users').select('id')
    .eq('tenant_id', opts.tenantId).eq('business_id', opts.businessId).eq('role', 'owner');
  if (opts.userId) ownersQuery = ownersQuery.eq('id', opts.userId);
  const { data: owners, error: ownersError } = await ownersQuery;
  if (ownersError) throw new Error(`Owner notification lookup failed: ${ownersError.message}`);
  const ownerIds = (owners ?? []).map((owner) => String(owner.id));
  if (ownerIds.length === 0) return { sent: 0, failed: 0, deleted: 0, noSubscribers: true };
  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, keys')
    .eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId)
    .in('user_id', ownerIds);
  if (subscriptionsError) throw new Error(`Owner subscriptions lookup failed: ${subscriptionsError.message}`);

  if (!subscriptions || subscriptions.length === 0) {
    // P0-16：无订阅不得计入 sent —— 明确标记 noSubscribers，由调用方落终端失败。
    return { sent: 0, failed: 0, deleted: 0, noSubscribers: true };
  }

  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim();
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) {
    throw new Error('Web Push VAPID credentials are not configured');
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  let sent = 0;
  let failed = 0;
  let deleted = 0;

  for (const sub of subscriptions) {
    try {
      const subscription: PushSubscription = {
        endpoint: sub.endpoint,
        keys: sub.keys as PushSubscription['keys'],
      };
      await webpush.sendNotification(subscription, JSON.stringify({
        title: opts.title,
        body: opts.body,
        icon: '/icons/icon-192x192.png',
        data: opts.data ?? {},
      }), { TTL: 86400 });
      sent++;
    } catch (error) {
      const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : null;
      if (statusCode === 410 || statusCode === 404) {
        // 订阅已失效：仅删除订阅（不影响其它订阅的投递结果）
        await supabase.from('push_subscriptions').delete()
          .eq('id', sub.id).eq('tenant_id', opts.tenantId).eq('business_id', opts.businessId);
        deleted++;
      } else {
        failed++;
      }
    }
  }

  return { sent, failed, deleted, noSubscribers: false };
}
