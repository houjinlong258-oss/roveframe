import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { getSettings } from '@/lib/settings';
import { businessDayRange, localDateInTimeZone, resolveBusinessTimeZone } from '@/lib/time';

/**
 * 员工端「我的排班」（Phase 18 / P18-x）。
 *
 * ## 三条不可退让的边界
 *
 * 1. **只返回本人的班次**。`staff_id` 由 `staffRequestContext` 从会话解析
 *    （users.user_id → staff.id），筛选条件写死为它。
 *    接口**不接受**客户端传 staff_id —— 一旦接受，"看同事的排班"就只需要改一个
 *    查询字符串，而排班里带着岗位与备注，属于他人信息。
 *
 * 2. **按业务时区切日，不按进程时区**。`from` / `to` 是自然日（YYYY-MM-DD），
 *    而服务器进程时区是 CST。若用 `new Date('2026-09-08')` 解析，边界会整体
 *    偏移 8 小时 —— 员工会看到"昨天的班"或漏掉"今晚的班"。统一走
 *    `businessDayRange`（src/lib/time.ts）。
 *
 * 3. **时间窗必须有上限**。默认"今天起 14 天"（Frontend Spec §5.4 的周视图/列表口径），
 *    客户端最多可要 31 天。没有上限时 `to=2999-12-31` 会把全表拉出来。
 */

/** 默认窗口长度：今天起 14 天（含今天共 15 个自然日）。 */
const DEFAULT_WINDOW_DAYS = 14;
/** 显式指定 from/to 时的最大跨度，与默认窗口同为"两周视图"的量级。 */
const MAX_WINDOW_DAYS = 31;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 把 YYYY-MM-DD 平移 n 天，仍以 UTC 零点为锚（纯日期运算，不涉及时区）。 */
function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, staffId } = resolved.ctx;

  // 业务时区来自 settings.locale.timezone；读不到就没有可信口径，明确失败而不是猜。
  let timeZone: string;
  let localToday: string;
  try {
    const settings = await getSettings(tenantId, businessId);
    timeZone = resolveBusinessTimeZone(settings.locale?.timezone);
    localToday = localDateInTimeZone(new Date(), timeZone);
  } catch (error) {
    console.error('[staff/shifts] settings lookup failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'could not resolve the business time zone' }, { status: 500 });
  }

  const from = request.nextUrl.searchParams.get('from') ?? localToday;
  const to = request.nextUrl.searchParams.get('to') ?? addDays(from, DEFAULT_WINDOW_DAYS);
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    return NextResponse.json(
      { error: 'from and to must be YYYY-MM-DD' },
      { status: 400 },
    );
  }

  let range: { startIso: string; endIso: string };
  try {
    // businessDayRange 对 2026-02-31 这类语义非法日期会抛错 —— 不能落到 500，
    // 那是客户端输入问题。
    const start = businessDayRange(from, timeZone).start;
    const end = businessDayRange(to, timeZone).end;
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (spanDays <= 0) {
      return NextResponse.json({ error: 'to must not be earlier than from' }, { status: 400 });
    }
    if (spanDays > MAX_WINDOW_DAYS + 1) {
      return NextResponse.json(
        { error: `the range must not exceed ${MAX_WINDOW_DAYS} days` },
        { status: 400 },
      );
    }
    range = { startIso: start.toISOString(), endIso: end.toISOString() };
  } catch (error) {
    console.error('[staff/shifts] invalid range:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'from or to is not a real date' }, { status: 400 });
  }

  const { data, error } = await getSupabaseClient()
    .from('staff_shifts')
    .select('id, starts_at, ends_at, role, note')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    // 越权边界就在这一行：会话解析出的 staff id，客户端无从影响。
    .eq('staff_id', staffId)
    .gte('starts_at', range.startIso)
    .lt('starts_at', range.endIso)
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('[staff/shifts] list failed:', error.message);
    return NextResponse.json({ error: 'could not load shifts' }, { status: 500 });
  }

  return NextResponse.json({
    shifts: (data ?? []) as {
      id: string;
      starts_at: string;
      ends_at: string;
      role: string | null;
      note: string | null;
    }[],
  });
}
