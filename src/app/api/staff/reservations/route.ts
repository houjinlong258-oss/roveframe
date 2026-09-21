import { NextRequest, NextResponse } from 'next/server';
import { staffRequestContext } from '@/lib/workforce';
import { scopedTable } from '@/lib/tenant-db';
import { businessDayRange, localDateInTimeZone, resolveBusinessTimeZone } from '@/lib/time';
import { getSettings } from '@/lib/settings';
import { requireStaffFeature } from '@/lib/staff-access';
import type { RoleKey } from '@/lib/rbac';

/**
 * 员工端「今日预约」（Phase 18 / P18-x）。
 *
 * ## 与 /api/reservations 的区别
 *
 * 后台那个接口要求 `reservations:read`（staff 没有这个权限，因为响应里带 PII 统计），
 * 员工端只回答"今天哪些客人要来"，字段是现场必需的七项 —— 姓名、电话、人数、时间、
 * 桌号、状态、备注。**不返回周统计与取消率**：员工不需要，也不该顺手看到全店经营数字。
 *
 * ## 租户与商家只从会话来
 *
 * 走 `scopedTable` 而不是裸 `getSupabaseClient().from()`：它会强制
 * tenant_id + business_id 两个过滤条件同时存在，漏一个就直接抛错。
 * 这是"跨门店越权"最省事的防法 —— 靠人记得写 `.eq('business_id')` 迟早会漏。
 *
 * ## 日期按业务时区切，不按进程时区
 *
 * 服务器是 CST，`reserved_at` 存的是 UTC。用进程时区切"今天"会让纽约店的
 * 员工在下午看到"明天的预约"。统一走 src/lib/time.ts 的 businessDayRange。
 *
 * ## 商家开关（`reservations`）
 *
 * 老板可以在 `/api/team/staff-access` 关掉"员工端确认预订"这个面。关掉后本接口
 * 返回 403 + `feature_disabled`，**不返回空列表**：空列表会让员工以为"今天没有
 * 预订"，而真相是这个功能被关掉了（两者在界面上必须能分辨）。
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 收敛到 RoleKey 白名单；未知角色按最小权限的 'staff' 处理（fail-closed）。 */
function asRoleKey(role: string): RoleKey {
  return role === 'owner' || role === 'manager' ? role : 'staff';
}

export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId } = resolved.ctx;

  const gate = await requireStaffFeature(tenantId, businessId, 'reservations');
  if (gate) return gate;

  let timeZone: string;
  let localToday: string;
  try {
    const settings = await getSettings(tenantId, businessId);
    timeZone = resolveBusinessTimeZone(settings.locale?.timezone);
    localToday = localDateInTimeZone(new Date(), timeZone);
  } catch (error) {
    console.error('[staff/reservations] settings lookup failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'could not resolve the business time zone' }, { status: 500 });
  }

  const date = request.nextUrl.searchParams.get('date') ?? localToday;
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  let startIso: string;
  let endIso: string;
  try {
    const range = businessDayRange(date, timeZone);
    startIso = range.start.toISOString();
    endIso = range.end.toISOString();
  } catch (error) {
    console.error('[staff/reservations] invalid date:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'date is not a real date' }, { status: 400 });
  }

  const { data, error } = await scopedTable(
    {
      tenantId,
      businessId,
      userId: resolved.ctx.userId,
      // staffRequestContext 把 role 放宽成 string（它要供路由做"第二个"权限判定），
      // 而 scopedTable 要的是 TenantContext.role（RoleKey）。这里只做**类型收敛**，
      // 取值本身来自 getTenantContext 从 JWT 解析的同一份 role，不做任何语义改动。
      role: asRoleKey(resolved.ctx.role),
    },
    'reservations',
    'id, customer_name, phone, party_size, reserved_at, table_no, status, notes',
  )
    .gte('reserved_at', startIso)
    .lt('reserved_at', endIso)
    .order('reserved_at', { ascending: true });

  if (error) {
    console.error('[staff/reservations] list failed:', error.message);
    return NextResponse.json({ error: 'could not load reservations' }, { status: 500 });
  }

  return NextResponse.json({ reservations: data ?? [] });
}
