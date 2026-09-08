import { getSupabaseClient } from '@/storage/database/supabase-client';
import { enqueueNotification } from '@/lib/notifications/outbox';

export interface BusinessEvent {
  type: 'inventory_alert' | 'review_anomaly' | 'sales_anomaly' | 'churn_risk';
  level: 'info' | 'warning' | 'critical';
  title: string;
  content: string;
  details?: Record<string, unknown>;
}

// P0-20：检测器只产出事件（agent_events）+ 通知 outbox；不再创建无 handler 的
// 库存补货/差评分析/销售下滑三类死任务（任务触发路径已随契约对齐移除）。

export async function detectBusinessEvents(tenantId: string, businessId: string): Promise<BusinessEvent[]> {
  const supabase = getSupabaseClient();
  const events: BusinessEvent[] = [];
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Inventory Event Detection (stock < safety_stock)
  const { data: lowStockItems } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock, safety_stock, unit')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId);

  if (lowStockItems) {
    for (const item of lowStockItems) {
      const stock = Number(item.current_stock);
      const safety = Number(item.safety_stock);
      if (stock < safety) {
        events.push({
          type: 'inventory_alert',
          level: stock === 0 ? 'critical' : 'warning',
          title: `Low Stock Alert: ${item.name}`,
          content: `${item.name} stock (${stock} ${item.unit}) is below safety threshold (${safety} ${item.unit}).`,
          details: { itemId: item.id, stock, safety, unit: item.unit },
        });
      }
    }
  }

  // 2. Review Event Detection (rating < 3 OR 30% negative review spike over 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const [{ data: recentReviews }, { data: priorReviews }] = await Promise.all([
    supabase
      .from('reviews')
      .select('id, rating, sentiment')
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .gte('created_at', sevenDaysAgo),
    supabase
      .from('reviews')
      .select('id, rating, sentiment')
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .gte('created_at', fourteenDaysAgo)
      .lt('created_at', sevenDaysAgo),
  ]);

  const recentNegatives = (recentReviews ?? []).filter((r) => r.rating <= 2 || r.sentiment === 'negative').length;
  const priorNegatives = (priorReviews ?? []).filter((r) => r.rating <= 2 || r.sentiment === 'negative').length;

  const spikeRatio = priorNegatives > 0 ? (recentNegatives - priorNegatives) / priorNegatives : recentNegatives > 0 ? 1 : 0;
  const hasLowRating = (recentReviews ?? []).some((r) => r.rating < 3);

  if (hasLowRating || spikeRatio >= 0.3) {
    events.push({
      type: 'review_anomaly',
      level: spikeRatio >= 0.5 || recentNegatives >= 3 ? 'critical' : 'warning',
      title: `Review Anomaly Detected (${recentNegatives} low rating reviews)`,
      content: `Detected low rating review or ${Math.round(spikeRatio * 100)}% spike in negative reviews over past 7 days.`,
      details: { recentNegatives, priorNegatives, spikeRatio },
    });
  }

  // 3. Sales Event Detection (today sales dropped 20% vs 7-day average)
  const { data: recentOrders } = await supabase
    .from('orders')
    .select('total, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .gte('created_at', sevenDaysAgo);

  if (recentOrders && recentOrders.length > 0) {
    const todayOrders = recentOrders.filter((o) => o.created_at.slice(0, 10) === todayStr);
    const todayTotal = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const totalWeeklyRevenue = recentOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const avgDailyRevenue = totalWeeklyRevenue / 7;

    // Evaluate drop if today is late enough or compare daily total
    if (avgDailyRevenue > 0 && todayTotal < avgDailyRevenue * 0.8) {
      const dropPercent = Math.round((1 - todayTotal / avgDailyRevenue) * 100);
      events.push({
        type: 'sales_anomaly',
        level: dropPercent >= 40 ? 'critical' : 'warning',
        title: `Sales Revenue Drop Alert (-${dropPercent}%)`,
        content: `Today's revenue ($${todayTotal.toFixed(2)}) is ${dropPercent}% below the 7-day daily average ($${avgDailyRevenue.toFixed(2)}).`,
        details: { todayTotal, avgDailyRevenue, dropPercent },
      });
    }
  }

  // Log events into `agent_events` & enqueue notification outbox items
  for (const event of events) {
    const dedupeKey = `${event.type}:${event.title}:${todayStr}`;

    const { data: insertedEvent } = await supabase
      .from('agent_events')
      .upsert(
        {
          tenant_id: tenantId,
          business_id: businessId,
          event_type: event.type,
          severity: event.level,
          title: event.title,
          content: event.content,
          dedupe_key: dedupeKey,
          status: 'open',
          metadata: event.details ?? {},
        },
        { onConflict: 'business_id,dedupe_key', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle();

    if (event.level === 'warning' || event.level === 'critical') {
      await enqueueNotification({
        tenantId,
        businessId,
        eventId: insertedEvent?.id,
        channel: 'web_push',
        notificationType: event.type,
        title: event.title,
        content: event.content,
        priority: event.level === 'critical' ? 'high' : 'normal',
        idempotencyKey: `notif:${dedupeKey}`,
      });
    }
  }

  return events;
}
