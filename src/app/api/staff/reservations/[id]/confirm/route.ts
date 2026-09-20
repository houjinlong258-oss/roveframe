import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * 员工端确认/推进一张预约（Phase 18 / P18-x）。
 *
 * 允许的跃迁**只有两条链**：
 *
 *     pending   → confirmed | cancelled
 *     confirmed → arrived   | cancelled
 *
 * 别的都是 409 invalid_transition。为什么要把状态机写在代码白名单里而不是
 * 交给客户端判断：员工端有三个按钮（确认 / 到店 / 取消），弱网下按钮状态会滞后，
 * 很容易对一条已经 arrived 的记录再点"确认"。若不做服务端校验，这条 upsert
 * 会静默把"已到店"改回"已确认" —— 前台台账因此回退，而且没人会发现。
 *
 * ## 越权边界
 *
 * 更新语句同时带 id + tenant_id + business_id，并把 from 状态写进 WHERE：
 * 影响 0 行有两种含义，通过回读区分 404（不存在/不属于本店）与 409（状态冲突）。
 * 客户端传的 id 只能指向**本店**的行。
 */

const TARGETS = ['confirmed', 'arrived', 'cancelled'] as const;
type Target = (typeof TARGETS)[number];

/**
 * 状态机白名单。与 src/lib/delivery.ts 的 RIDER_TRANSITIONS 同一形态：
 * 放代码而不是 check 约束 —— 演进状态机不应要求 DDL。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly Target[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['arrived', 'cancelled'],
  // arrived / cancelled / completed 都是终点，不再接受任何跃迁。
  arrived: [],
  cancelled: [],
  completed: [],
};

async function confirmHandler(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId } = resolved.ctx;

  const { id } = await routeContext.params;
  const reservationId = typeof id === 'string' ? id.trim() : '';
  if (!reservationId || reservationId.length > 36) {
    return NextResponse.json({ error: 'invalid reservation id' }, { status: 400 });
  }

  let body: { status?: unknown };
  try {
    body = (await request.json()) as { status?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const next = typeof body.status === 'string' ? body.status.trim() : '';
  if (!TARGETS.includes(next as Target)) {
    return NextResponse.json(
      { error: 'status must be confirmed, arrived or cancelled', allowed: [...TARGETS] },
      { status: 400 },
    );
  }
  const target = next as Target;

  const client = getSupabaseClient();
  const { data: current, error: readError } = await client
    .from('reservations')
    .select('id, status')
    .eq('id', reservationId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (readError) {
    console.error('[staff/reservations/confirm] read failed:', readError.message);
    return NextResponse.json({ error: 'could not read the reservation' }, { status: 500 });
  }
  // 404 不在本店或根本不存在 —— 两种情况对员工端是同一件事：这张预订不在你的列表里，
  // 刷新即可。刻意不区分，避免把"别的门店存在这个 id"变成可探测的信息。
  if (!current) return NextResponse.json({ error: 'reservation not found' }, { status: 404 });

  const from = String((current as { status: string }).status);
  if (!ALLOWED_TRANSITIONS[from]?.includes(target)) {
    return NextResponse.json(
      { error: `cannot change a ${from} reservation to ${target}`, code: 'invalid_transition' },
      { status: 409 },
    );
  }

  // WHERE 里保留 from：读与写之间可能有人（另一个员工）已经推进过。
  const { data, error } = await client
    .from('reservations')
    .update({ status: target })
    .eq('id', reservationId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('status', from)
    .select('id');

  if (error) {
    console.error('[staff/reservations/confirm] update failed:', error.message);
    return NextResponse.json({ error: 'confirmation failed' }, { status: 500 });
  }
  if ((data ?? []).length !== 1) {
    // 并发：另一个员工在同一瞬间推进了这条记录 → 同样是状态冲突，不是故障。
    return NextResponse.json(
      { error: `the reservation is no longer ${from}`, code: 'invalid_transition' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, id: reservationId, status: target });
}

export const POST = protectBusinessMutation(
  { permission: 'reservations:confirm', action: 'reservations.confirm', entity: 'reservations' },
  confirmHandler,
);
