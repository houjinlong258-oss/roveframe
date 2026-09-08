import { getSupabaseClient } from '@/storage/database/supabase-client';
import { enqueueNotification } from '@/lib/notifications/outbox';

export interface BusinessEvent {
  type: 'inventory_alert' | 'review_anomaly' | 'sales_anomaly' | 'churn_risk';
  level: 'info' | 'warning' | 'critical';
  title: string;
  content: string;
  details?: Record<string, unknown>;
}

async function triggerEventTask(opts: {
  tenantId: string;
  businessId: string;
  taskType: string;
  name: string;
  priority: 'high' | 'medium' | 'low';
  input: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const scheduledAt = new Date().toISOString();

  // Deduplicate
  const { data: existing } = await supabase
    .from('agent_tasks')
    .select('id')
    .eq('tenant_id', opts.tenantId)
    .eq('business_id', opts.businessId)
    .eq('idempotency_key', opts.idempotencyKey)
    .maybeSingle();

  if (existing) return;

  const { data: task } = await supabase
    .from('agent_tasks')
    .insert({
      tenant_id: opts.tenantId,
      business_id: opts.businessId,
      agent_type: 'coo-agent',
      task_type: opts.taskType,
      name: opts.name,
      priority: opts.priority,
      status: 'QUEUED',
      input: opts.input,
      context: {},
      idempotency_key: opts.idempotencyKey,
      scheduled_at: scheduledAt,
    })
    .select('id')
    .maybeSingle();

  if (task?.id) {
    await supabase.from('agent_task_runs').insert({
      tenant_id: opts.tenantId,
      business_id: opts.businessId,
      task_id: task.id,
      attempt_number: 1,
      max_attempts: 3,
      status: 'QUEUED',
      idempotency_key: `${opts.idempotencyKey}:run:1`,
      available_at: scheduledAt,
      input: opts.input,
    });
  }
}

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

        // Trigger INVENTORY_ALERT_TASK
        await triggerEventTask({
          tenantId,
          businessId,
          taskType: 'INVENTORY_ALERT_TASK',
          name: `Inventory Restock Task: ${item.name}`,
          priority: stock === 0 ? 'high' : 'medium',
          input: { itemId: item.id, itemName: item.name, stock, safety, unit: item.unit },
          idempotencyKey: `inventory_alert_${item.id}_${todayStr}`,
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

    // Trigger REVIEW_ANALYSIS_TASK
    await triggerEventTask({
      tenantId,
      businessId,
      taskType: 'REVIEW_ANALYSIS_TASK',
      name: 'Negative Review Deep Analysis Task',
      priority: 'high',
      input: { recentNegatives, priorNegatives, spikeRatio },
      idempotencyKey: `review_anomaly_${businessId}_${todayStr}`,
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

      // Trigger SALES_DROP_ANALYSIS_TASK
      await triggerEventTask({
        tenantId,
        businessId,
        taskType: 'SALES_DROP_ANALYSIS_TASK',
        name: 'Sales Drop Diagnostic & Strategy Task',
        priority: 'high',
        input: { todayTotal, avgDailyRevenue, dropPercent },
        idempotencyKey: `sales_drop_${businessId}_${todayStr}`,
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
