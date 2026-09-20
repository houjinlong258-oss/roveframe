import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { updateSettings } from '@/lib/settings';
import {
  assignDelivery,
  getDeliveryRules,
  listPendingDeliveries,
  normalizeDeliveryRules,
  RIDER_STATUSES,
  type DeliveryRow,
} from '@/lib/delivery';

/**
 * 店长侧的外卖管理：配送规则读写 + 全店配送单列表 + 指派骑手。
 *
 * 与员工端严格分开：
 *   /api/staff/deliveries  —— 员工看"待接单 + 我的"
 *   /api/team/delivery     —— 店长看**全店**、改规则、指派给别人
 * 合在一个接口里会迫使员工端也拿到"全店 + 规则写权限"，那是权限扩大。
 */

const MAX_ROWS = 200;

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'settings:read');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  const statusFilter = request.nextUrl.searchParams.get('status') ?? '';
  const client = getSupabaseClient();
  let query = client
    .from('delivery_orders')
    .select('id, order_id, recipient_name, recipient_phone, address_line, address_note, fee, '
      + 'rider_staff_id, rider_status, promised_at, created_at, updated_at, '
      + 'orders(order_no, total, items)')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (statusFilter && RIDER_STATUSES.includes(statusFilter as never)) {
    query = query.eq('rider_status', statusFilter);
  } else {
    query = query.in('rider_status', ['pending', 'claimed', 'picked_up']);
  }

  const [{ data, error }, rules] = await Promise.all([
    query,
    getDeliveryRules(context.tenantId, context.businessId),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 骑手姓名单独查一次，避免依赖 PostgREST 的嵌套关系推断（staff 与
  // delivery_orders 之间没有外键，嵌不进去）。
  const riderIds = Array.from(new Set(
    (data ?? []).map((row) => (row as { rider_staff_id?: string | null }).rider_staff_id).filter(Boolean) as string[],
  ));
  const nameById = new Map<string, string>();
  if (riderIds.length > 0) {
    const { data: staffRows } = await client
      .from('staff')
      .select('id, name')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .in('id', riderIds);
    for (const row of staffRows ?? []) {
      nameById.set(String((row as { id: string }).id), String((row as { name: string }).name));
    }
  }

  const deliveries = (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown> & {
      orders?: { order_no?: string; total?: string | number } | null;
    };
    return {
      id: String(row.id),
      order_id: String(row.order_id),
      order_no: String(row.orders?.order_no ?? ''),
      total: Number(row.orders?.total ?? 0),
      recipient_name: String(row.recipient_name ?? ''),
      recipient_phone: String(row.recipient_phone ?? ''),
      address_line: String(row.address_line ?? ''),
      address_note: row.address_note ?? null,
      fee: Number(row.fee ?? 0),
      rider_staff_id: row.rider_staff_id ?? null,
      rider_name: row.rider_staff_id ? (nameById.get(String(row.rider_staff_id)) ?? null) : null,
      rider_status: String(row.rider_status ?? 'pending'),
      promised_at: row.promised_at ?? null,
      created_at: row.created_at ?? null,
    };
  });

  const { data: staffRows } = await client
    .from('staff')
    .select('id, name, is_active')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .eq('is_active', true)
    .order('name', { ascending: true });

  return NextResponse.json({
    deliveries,
    rules,
    riders: (staffRows ?? []).map((row) => ({
      id: String((row as { id: string }).id),
      name: String((row as { name: string }).name),
    })),
  });
}

interface PatchBody {
  rules?: unknown;
  assign?: { delivery_id?: unknown; staff_id?: unknown };
}

async function updateDelivery(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'delivery:dispatch');

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 指派骑手
  if (body.assign) {
    const deliveryId = typeof body.assign.delivery_id === 'string' ? body.assign.delivery_id.trim() : '';
    const staffId = typeof body.assign.staff_id === 'string' ? body.assign.staff_id.trim() : '';
    if (!deliveryId || !staffId) {
      return NextResponse.json({ error: 'assign.delivery_id and assign.staff_id are required' }, { status: 400 });
    }
    // 被指派的必须是**本店在职**员工 —— 否则可以把单指派给别的店的员工。
    const { data: staff } = await getSupabaseClient()
      .from('staff')
      .select('id')
      .eq('id', staffId)
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .eq('is_active', true)
      .maybeSingle();
    if (!staff) return NextResponse.json({ error: 'rider not found in this store' }, { status: 404 });

    const outcome = await assignDelivery(context.tenantId, context.businessId, staffId, deliveryId);
    if (outcome.ok) return NextResponse.json({ ok: true });
    if (outcome.reason === 'not_found') {
      return NextResponse.json({ error: 'delivery not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'this delivery is already delivered or cancelled', code: 'already_settled' },
      { status: 409 },
    );
  }

  // 配送规则。整块替换而不是逐字段 merge：逐字段 merge 会让"把 freeDeliveryAbove
  // 清空"无法表达（undefined 与 null 在 JSON 里不可区分）。
  if (body.rules !== undefined) {
    const normalized = normalizeDeliveryRules(body.rules);
    const current = await getDeliveryRules(context.tenantId, context.businessId);
    if (normalized.enabled && current.fee === 0 && normalized.fee === 0) {
      // 不拦，只提示：0 配送费是合法的（自配送商家常见做法）。
      console.warn(`[team/delivery] delivery enabled with zero fee for ${context.businessId}`);
    }
    await updateSettings(context.tenantId, context.businessId, {
      delivery: { ...normalized } as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true, rules: normalized });
  }

  return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
}

export const PATCH = protectBusinessMutation(
  { permission: 'delivery:dispatch', action: 'delivery.update', entity: 'delivery_orders' },
  updateDelivery,
);

export type { DeliveryRow };
