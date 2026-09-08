import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { json } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { analyzeChurnCustomers, executeRecoveryCampaign } from '@/lib/agent/recovery-campaign';

const READ_OPERATIONS = [
  'read_sales',
  'read_orders',
  'read_customers',
  'read_products',
  'read_inventory',
  'read_reviews',
  'read_payments',
  'read_business_profile',
  'read_snapshot',
  'analyze_churn_customers',
] as const;

const WRITE_OPERATIONS = [
  'upsert_order',
  'upsert_product',
  'upsert_customer',
  'set_inventory',
  'send_recovery_campaign',
] as const;

const operationSchema = z.enum([...READ_OPERATIONS, ...WRITE_OPERATIONS]);
export type BusinessDataOperation = z.infer<typeof operationSchema>;

const requestSchema = z.object({
  tenant_id: z.string().trim().min(1).max(128),
  business_id: z.string().trim().min(1).max(128),
  operation: operationSchema,
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();

const limitSchema = z.coerce.number().int().min(1).max(500).default(100);

function validServiceKey(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function periodStart(period: 'today' | 'week'): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 6);
  return start.toISOString();
}

function scopeEnvelope(tenantId: string, businessId: string, data: unknown) {
  return {
    ok: true as const,
    scope: { tenant_id: tenantId, business_id: businessId },
    data,
  };
}

async function assertBusinessScope(tenantId: string, businessId: string): Promise<boolean> {
  const result = await getSupabaseClient()
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (result.error) throw new Error(`business scope verification failed: ${result.error.message}`);
  return Boolean(result.data);
}

async function readOrders(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const parsed = z.object({
    start: z.coerce.number().finite().optional(),
    end: z.coerce.number().finite().optional(),
    limit: limitSchema,
  }).strict().parse(params);
  let query = getSupabaseClient()
    .from('orders')
    .select('id, order_no, customer_id, items, total, tip, channel, status, source, external_id, table_no, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(parsed.limit);
  if (parsed.start !== undefined) query = query.gte('created_at', new Date(parsed.start * 1000).toISOString());
  if (parsed.end !== undefined) query = query.lte('created_at', new Date(parsed.end * 1000).toISOString());
  const result = await query;
  if (result.error) throw new Error(`orders query failed: ${result.error.message}`);
  return result.data ?? [];
}

async function readCustomers(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const { limit } = z.object({ limit: limitSchema }).strict().parse(params);
  const result = await getSupabaseClient()
    .from('customers')
    .select('id, name, email, phone, tags, total_spent, visit_count, last_visit_at, ai_score, churn_risk, preference_notes')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .order('last_visit_at', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`customers query failed: ${result.error.message}`);
  return result.data ?? [];
}

async function readProducts(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const parsed = z.object({
    active_only: z.boolean().default(true),
    limit: limitSchema,
  }).strict().parse(params);
  let query = getSupabaseClient()
    .from('products')
    .select('id, name, category, price, cost, stock, sales_count, status, description, source, external_id, updated_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .order('sales_count', { ascending: false })
    .limit(parsed.limit);
  if (parsed.active_only) query = query.eq('status', 'active');
  const result = await query;
  if (result.error) throw new Error(`products query failed: ${result.error.message}`);
  return result.data ?? [];
}

async function readInventory(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const parsed = z.object({
    low_only: z.boolean().default(false),
    limit: limitSchema,
  }).strict().parse(params);
  const result = await getSupabaseClient()
    .from('inventory_items')
    .select('id, name, category, unit, current_stock, safety_stock, supplier, erp_item_code, synced_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .order('current_stock', { ascending: true })
    .limit(parsed.limit);
  if (result.error) throw new Error(`inventory query failed: ${result.error.message}`);
  const rows = result.data ?? [];
  return parsed.low_only
    ? rows.filter((row) => Number(row.current_stock ?? 0) <= Number(row.safety_stock ?? 0))
    : rows;
}

async function readReviews(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const { limit } = z.object({ limit: limitSchema }).strict().parse(params);
  const result = await getSupabaseClient()
    .from('reviews')
    .select('id, customer_id, author_name, platform, rating, content, sentiment, status, reply_status, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`reviews query failed: ${result.error.message}`);
  return result.data ?? [];
}

async function readPayments(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const { limit } = z.object({ limit: limitSchema }).strict().parse(params);
  const result = await getSupabaseClient()
    .from('payments')
    .select('id, provider, external_id, amount, currency, status, description, order_id, failure_reason, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`payments query failed: ${result.error.message}`);
  return result.data ?? [];
}

async function readProfile(tenantId: string, businessId: string) {
  const result = await getSupabaseClient()
    .from('businesses')
    .select('id, name, industry, location, language, currency, brand_style, schema_config, created_at')
    .eq('tenant_id', tenantId)
    .eq('id', businessId)
    .single();
  if (result.error) throw new Error(`business profile query failed: ${result.error.message}`);
  return result.data;
}

async function readSales(tenantId: string, businessId: string, params: Record<string, unknown>) {
  const { period } = z.object({ period: z.enum(['today', 'week']).default('week') }).strict().parse(params);
  const result = await getSupabaseClient()
    .from('orders')
    .select('total, channel, customer_id, items, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .gte('created_at', periodStart(period))
    .neq('status', 'cancelled');
  if (result.error) throw new Error(`sales query failed: ${result.error.message}`);
  const rows = result.data ?? [];
  const revenue = rows.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
  return {
    period,
    revenue: Math.round(revenue * 100) / 100,
    orders: rows.length,
    customers: new Set(rows.map((row) => row.customer_id).filter(Boolean)).size,
    average_order_value: rows.length ? Math.round((revenue / rows.length) * 100) / 100 : 0,
  };
}

async function readOperation(
  operation: BusinessDataOperation,
  tenantId: string,
  businessId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case 'read_sales': return readSales(tenantId, businessId, params);
    case 'read_orders': return readOrders(tenantId, businessId, params);
    case 'read_customers': return readCustomers(tenantId, businessId, params);
    case 'read_products': return readProducts(tenantId, businessId, params);
    case 'read_inventory': return readInventory(tenantId, businessId, params);
    case 'read_reviews': return readReviews(tenantId, businessId, params);
    case 'read_payments': return readPayments(tenantId, businessId, params);
    case 'read_business_profile': return readProfile(tenantId, businessId);
    case 'analyze_churn_customers': {
      const parsed = z.object({
        days_inactive: z.coerce.number().int().min(7).max(365).default(60),
        min_total_spent: z.coerce.number().finite().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }).strict().parse(params);
      return analyzeChurnCustomers(tenantId, businessId, {
        daysInactive: parsed.days_inactive,
        minTotalSpent: parsed.min_total_spent,
        limit: parsed.limit,
      });
    }
    case 'read_snapshot': {
      const [profile, sales, orders, customers, products, inventory, reviews, payments] = await Promise.all([
        readProfile(tenantId, businessId),
        readSales(tenantId, businessId, { period: 'week' }),
        readOrders(tenantId, businessId, { limit: 25 }),
        readCustomers(tenantId, businessId, { limit: 50 }),
        readProducts(tenantId, businessId, { active_only: true, limit: 50 }),
        readInventory(tenantId, businessId, { low_only: false, limit: 50 }),
        readReviews(tenantId, businessId, { limit: 25 }),
        readPayments(tenantId, businessId, { limit: 25 }),
      ]);
      return { profile, sales, orders, customers, products, inventory, reviews, payments };
    }
    default: throw new Error(`unsupported read operation: ${operation}`);
  }
}

async function auditConnectorWrite(tenantId: string, businessId: string, operation: string, entityId: string) {
  const result = await getSupabaseClient().from('audit_logs').insert({
    tenant_id: tenantId,
    action: operation,
    entity: 'business_data_adapter',
    entity_id: entityId || businessId,
    after: { business_id: businessId, source: 'roveagent_connector' },
  });
  if (result.error) throw new Error(`business adapter audit failed: ${result.error.message}`);
}

async function writeOperation(
  operation: BusinessDataOperation,
  tenantId: string,
  businessId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const client = getSupabaseClient();
  if (operation === 'upsert_order') {
    const value = z.object({
      source: z.string().trim().min(1).max(20), external_id: z.string().trim().min(1).max(128),
      total: z.number().finite().nonnegative(), items: z.array(z.record(z.string(), z.unknown())).max(200),
      status: z.string().trim().min(1).max(20), customer_id: z.string().nullable().optional(),
      currency: z.string().trim().min(3).max(8), created_at: z.number().finite().nullable().optional(),
    }).strict().parse(params);
    const orderNo = `${value.source.toUpperCase()}-${value.external_id}`.slice(0, 40);
    const result = await client.from('orders').upsert({
      tenant_id: tenantId, business_id: businessId, order_no: orderNo,
      source: value.source, external_id: value.external_id, total: value.total,
      items: value.items, status: value.status, customer_id: value.customer_id ?? null,
      created_at: value.created_at ? new Date(value.created_at * 1000).toISOString() : new Date().toISOString(),
    }, { onConflict: 'tenant_id,business_id,source,external_id' }).select('id').single();
    if (result.error) throw new Error(`order upsert failed: ${result.error.message}`);
    const id = String(result.data.id);
    await auditConnectorWrite(tenantId, businessId, operation, id);
    return { id };
  }
  if (operation === 'upsert_product') {
    const value = z.object({
      source: z.string().trim().min(1).max(20), external_id: z.string().trim().min(1).max(128),
      name: z.string().trim().min(1).max(128), price: z.number().finite().nonnegative(),
      category: z.string().max(50), active: z.boolean(),
    }).strict().parse(params);
    const result = await client.from('products').upsert({
      tenant_id: tenantId, business_id: businessId, source: value.source,
      external_id: value.external_id, name: value.name, price: value.price,
      category: value.category || 'Other', status: value.active ? 'active' : 'inactive',
    }, { onConflict: 'tenant_id,business_id,source,external_id' }).select('id').single();
    if (result.error) throw new Error(`product upsert failed: ${result.error.message}`);
    const id = String(result.data.id);
    await auditConnectorWrite(tenantId, businessId, operation, id);
    return { id };
  }
  if (operation === 'upsert_customer') {
    const value = z.object({
      source: z.string().trim().min(1).max(20), external_id: z.string().trim().min(1).max(128),
      name: z.string().max(128), email: z.string().max(255), phone: z.string().max(32),
    }).strict().parse(params);
    const result = await client.from('customers').upsert({
      tenant_id: tenantId, business_id: businessId, source: value.source,
      external_id: value.external_id, name: value.name || 'Guest',
      email: value.email || null, phone: value.phone || null,
    }, { onConflict: 'tenant_id,business_id,source,external_id' }).select('id').single();
    if (result.error) throw new Error(`customer upsert failed: ${result.error.message}`);
    const id = String(result.data.id);
    await auditConnectorWrite(tenantId, businessId, operation, id);
    return { id };
  }
  if (operation === 'set_inventory') {
    const value = z.object({
      name: z.string().trim().min(1).max(128), quantity: z.number().finite(),
      unit: z.string().trim().min(1).max(20), low_threshold: z.number().finite().nonnegative(),
      product_id: z.string().nullable().optional(),
    }).strict().parse(params);
    const existing = await client.from('inventory_items').select('id')
      .eq('tenant_id', tenantId).eq('business_id', businessId).eq('name', value.name).maybeSingle();
    if (existing.error) throw new Error(`inventory lookup failed: ${existing.error.message}`);
    const id = existing.data?.id ? String(existing.data.id) : randomUUID();
    const result = existing.data
      ? await client.from('inventory_items').update({
          current_stock: value.quantity, safety_stock: value.low_threshold,
          unit: value.unit, synced_at: new Date().toISOString(),
        }).eq('id', id).eq('tenant_id', tenantId).eq('business_id', businessId)
      : await client.from('inventory_items').insert({
          id, tenant_id: tenantId, business_id: businessId, name: value.name,
          current_stock: value.quantity, safety_stock: value.low_threshold,
          unit: value.unit, synced_at: new Date().toISOString(),
        });
    if (result.error) throw new Error(`inventory write failed: ${result.error.message}`);
    await auditConnectorWrite(tenantId, businessId, operation, id);
    return { id };
  }
  if (operation === 'send_recovery_campaign') {
    const value = z.object({
      campaign_title: z.string().trim().min(1).max(120),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(8000),
      customer_ids: z.array(z.string().trim().min(1)).min(1).max(500),
      language: z.enum(['en', 'zh', 'es']).default('en'),
      invocation_id: z.string().trim().max(128).optional(),
    }).strict().parse(params);

    // 关联本次审批执行周期（Python 侧 invocation 由门禁冻结时生成）。
    let approvalId = '';
    let executionId = '';
    let agentId = 'roveagent';
    let userId = '';
    if (value.invocation_id) {
      const { data: approval } = await client.from('agent_approvals')
        .select('id, execution_id, agent, user_id')
        .eq('tenant_id', tenantId)
        .eq('business_id', businessId)
        .eq('invocation_id', value.invocation_id)
        .maybeSingle();
      if (approval) {
        approvalId = String((approval as { id: string }).id);
        executionId = String((approval as { execution_id?: string | null }).execution_id ?? '');
        agentId = String((approval as { agent?: string }).agent ?? 'roveagent');
        userId = String((approval as { user_id?: string | null }).user_id ?? '');
      }
    }
    const result = await executeRecoveryCampaign(tenantId, businessId, {
      campaign_title: value.campaign_title,
      subject: value.subject,
      body: value.body,
      customer_ids: value.customer_ids,
      language: value.language,
    }, { approvalId, executionId, agentId, userId });
    await auditConnectorWrite(tenantId, businessId, operation, result.campaign_id);
    return result;
  }
  throw new Error(`unsupported write operation: ${operation}`);
}

/** Service-to-service business-data boundary; never accepts browser identity headers. */
export async function POST(request: Request) {
  const expectedKey = process.env.ROVEAGENT_API_KEY ?? '';
  if (!validServiceKey(request.headers.get('x-roveagent-key') ?? '', expectedKey)) {
    return json({ error: 'invalid service authentication' }, 401);
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid business-data request' }, 400);
  const { tenant_id: tenantId, business_id: businessId, operation, params } = parsed.data;
  try {
    if (!(await assertBusinessScope(tenantId, businessId))) {
      return json({ error: 'business scope not found' }, 404);
    }
    const data = READ_OPERATIONS.includes(operation as (typeof READ_OPERATIONS)[number])
      ? await readOperation(operation, tenantId, businessId, params)
      : await writeOperation(operation, tenantId, businessId, params);
    return json(scopeEnvelope(tenantId, businessId, data));
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'invalid operation parameters' }, 400);
    return json({ error: error instanceof Error ? error.message : 'business-data operation failed' }, 500);
  }
}
