import { getSupabaseClient } from '@/storage/database/supabase-client';
import webpush, { type PushSubscription } from 'web-push';

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, unknown>;
}

/** Dispatches a Web Push notification to registered subscriptions for a business. */
export async function dispatchWebPushToBusiness(opts: {
  tenantId: string;
  businessId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  userId?: string | null;
}): Promise<{ sent: number; failed: number }> {
  const supabase = getSupabaseClient();
  let ownersQuery = supabase.from('users').select('id')
    .eq('tenant_id', opts.tenantId).eq('business_id', opts.businessId).eq('role', 'owner');
  if (opts.userId) ownersQuery = ownersQuery.eq('id', opts.userId);
  const { data: owners, error: ownersError } = await ownersQuery;
  if (ownersError) throw new Error(`Owner notification lookup failed: ${ownersError.message}`);
  const ownerIds = (owners ?? []).map((owner) => String(owner.id));
  if (ownerIds.length === 0) return { sent: 0, failed: 0 };
  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, keys')
    .eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId)
    .in('user_id', ownerIds);
  if (subscriptionsError) throw new Error(`Owner subscriptions lookup failed: ${subscriptionsError.message}`);

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
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
        await supabase.from('push_subscriptions').delete()
          .eq('id', sub.id).eq('tenant_id', opts.tenantId).eq('business_id', opts.businessId);
        failed++;
      } else {
        failed++;
      }
    }
  }

  return { sent, failed };
}
