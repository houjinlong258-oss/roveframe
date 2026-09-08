import { getSupabaseClient } from '@/storage/database/supabase-client';
import type { AgentToolContext } from '@/lib/agent/types';

type SalesRow = { total: string | number | null; channel: string | null };
type ReviewRow = { rating: number | null; content: string | null; status: string | null; created_at: string };
type CustomerRow = { name: string | null; churn_risk: string | null };
type InventoryRow = { name: string | null; current_stock: string | number | null; safety_stock: string | number | null };

function scopedQuery(context: AgentToolContext, table: string, columns: string) {
  return getSupabaseClient()
    .from(table)
    .select(columns)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
}

function startOfPeriod(period: 'today' | 'week'): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 6);
  return start.toISOString();
}

export async function getSalesSummary(
  context: AgentToolContext,
  period: 'today' | 'week',
): Promise<{
  period: 'today' | 'week';
  revenue: number;
  orders: number;
  averageOrderValue: number;
  byChannel: Array<{ channel: string; revenue: number; orders: number }>;
}> {
  const { data, error } = await scopedQuery(context, 'orders', 'total, channel')
    .gte('created_at', startOfPeriod(period))
    .neq('status', 'cancelled');
  if (error) throw new Error(`sales query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as SalesRow[];
  const byChannel = new Map<string, { revenue: number; orders: number }>();
  let revenue = 0;
  for (const row of rows) {
    const amount = Number(row.total ?? 0);
    const channel = row.channel || 'other';
    revenue += amount;
    const current = byChannel.get(channel) ?? { revenue: 0, orders: 0 };
    byChannel.set(channel, { revenue: current.revenue + amount, orders: current.orders + 1 });
  }

  const roundedRevenue = Math.round(revenue * 100) / 100;
  return {
    period,
    revenue: roundedRevenue,
    orders: rows.length,
    averageOrderValue: rows.length ? Math.round((revenue / rows.length) * 100) / 100 : 0,
    byChannel: Array.from(byChannel.entries())
      .map(([channel, value]) => ({
        channel,
        revenue: Math.round(value.revenue * 100) / 100,
        orders: value.orders,
      }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

export async function getNegativeReviewTrend(context: AgentToolContext): Promise<{
  sampleSize: number;
  negativeCount: number;
  averageRating: number;
  pendingCount: number;
  samples: string[];
}> {
  const { data, error } = await scopedQuery(context, 'reviews', 'rating, content, status, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`review query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as ReviewRow[];
  const ratings = rows.map((row) => Number(row.rating ?? 0)).filter((rating) => rating > 0);
  const negative = rows.filter((row) => Number(row.rating ?? 5) <= 3);
  return {
    sampleSize: rows.length,
    negativeCount: negative.length,
    averageRating: ratings.length
      ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10
      : 0,
    pendingCount: rows.filter((row) => row.status === 'pending').length,
    samples: negative
      .map((row) => (row.content ?? '').trim().slice(0, 240))
      .filter(Boolean)
      .slice(0, 5),
  };
}

export async function getCustomerRiskSummary(context: AgentToolContext): Promise<{
  sampleSize: number;
  highRiskCount: number;
  mediumRiskCount: number;
  highRiskCustomers: string[];
}> {
  const { data, error } = await scopedQuery(context, 'customers', 'name, churn_risk').limit(500);
  if (error) throw new Error(`customer query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as CustomerRow[];
  const highRisk = rows.filter((row) => row.churn_risk === 'high');
  return {
    sampleSize: rows.length,
    highRiskCount: highRisk.length,
    mediumRiskCount: rows.filter((row) => row.churn_risk === 'medium').length,
    highRiskCustomers: highRisk
      .map((row) => (row.name ?? '').trim())
      .filter(Boolean)
      .slice(0, 20),
  };
}

export async function getLowStockItems(context: AgentToolContext): Promise<{
  count: number;
  items: Array<{ name: string; currentStock: number; safetyStock: number }>;
}> {
  const { data, error } = await scopedQuery(context, 'inventory_items', 'name, current_stock, safety_stock');
  if (error) throw new Error(`inventory query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as InventoryRow[];
  const items = rows
    .map((row) => ({
      name: (row.name ?? '').trim(),
      currentStock: Number(row.current_stock ?? 0),
      safetyStock: Number(row.safety_stock ?? 0),
    }))
    .filter((row) => row.name && row.currentStock < row.safetyStock)
    .sort((a, b) => a.currentStock - b.currentStock)
    .slice(0, 50);
  return { count: items.length, items };
}
