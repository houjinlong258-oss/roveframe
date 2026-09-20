import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getSettings } from '@/lib/settings';
import { businessDayRange, localDateInTimeZone, resolveBusinessTimeZone } from '@/lib/time';

/**
 * 员工端考勤：一个按钮，两个方向，方向由**服务端**判定（Phase 18 Frontend Spec §5.3）。
 *
 * ## 为什么不接受客户端传方向
 *
 * 请求体里没有任何参数。客户端说"我要签退"没有意义 —— 服务端看一眼
 * "这名员工此刻有没有未签退的记录"，有就签退、没有就签到。
 * 一旦接受客户端方向，就出现两类必然的错误：弱网下按钮重复提交同一方向、
 * 或客户端状态与服务端不一致时先签退再签到，直接产出负时长记录。
 *
 * ## 幂等靠数据库，不靠应用层判断
 *
 * "查不到开放记录 → 插入" 之间存在窗口。两个并发请求会同时查不到、
 * 同时插入 —— 于是出现两条未签退记录。挡住它的是迁移里的部分唯一索引：
 *
 *     create unique index staff_attendance_open_key
 *       on public.staff_attendance (staff_id) where clock_out_at is null;
 *
 * 并发的第二条 INSERT 必然撞 23505，这里把它翻译成 409 already_open。
 * **不重试、不吞掉**：重试只会把并发写放大成死循环，吞掉则等于假装成功。
 */

/** 默认窗口：今天 + 过去 13 天（考勤是"回看"型列表，与排班的"前瞻"口径相反）。 */
const DEFAULT_WINDOW_DAYS = 13;
const MAX_WINDOW_DAYS = 31;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

interface AttendanceRange {
  startIso: string;
  endIso: string;
}

/** 解析 ?from=&to=（业务时区切日）。失败时返回 400 响应，由调用方直接返回。 */
async function resolveRange(
  request: NextRequest,
  tenantId: string,
  businessId: string,
): Promise<AttendanceRange | NextResponse> {
  let timeZone: string;
  let localToday: string;
  try {
    const settings = await getSettings(tenantId, businessId);
    timeZone = resolveBusinessTimeZone(settings.locale?.timezone);
    localToday = localDateInTimeZone(new Date(), timeZone);
  } catch (error) {
    console.error('[staff/attendance] settings lookup failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'could not resolve the business time zone' }, { status: 500 });
  }

  const to = request.nextUrl.searchParams.get('to') ?? localToday;
  const from = request.nextUrl.searchParams.get('from') ?? addDays(to, -DEFAULT_WINDOW_DAYS);
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
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
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  } catch (error) {
    console.error('[staff/attendance] invalid range:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'from or to is not a real date' }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, staffId } = resolved.ctx;

  const range = await resolveRange(request, tenantId, businessId);
  if (range instanceof NextResponse) return range;

  const { data, error } = await getSupabaseClient()
    .from('staff_attendance')
    .select('id, clock_in_at, clock_out_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    // 只有本人的记录；staff_id 来自会话，不接受客户端筛选。
    .eq('staff_id', staffId)
    .gte('clock_in_at', range.startIso)
    .lt('clock_in_at', range.endIso)
    .order('clock_in_at', { ascending: false });

  if (error) {
    console.error('[staff/attendance] list failed:', error.message);
    return NextResponse.json({ error: 'could not load attendance' }, { status: 500 });
  }

  const records = ((data ?? []) as {
    id: string;
    clock_in_at: string;
    clock_out_at: string | null;
  }[]).map((row) => ({
    id: row.id,
    clock_in_at: row.clock_in_at,
    clock_out_at: row.clock_out_at,
    // 未签退时没有"已工作时长"这回事。返回 0 会让前端显示"已工作 0 分钟"，
    // 而真相是"还在上班" —— 用 null 让两种状态在数据层就分得开。
    worked_minutes: row.clock_out_at === null
      ? null
      : workedMinutes(row.clock_in_at, row.clock_out_at),
  }));

  return NextResponse.json({ records });
}

/**
 * 时长取**整数分钟**，向下取整。
 * 刻意不夹到 0：调用方只在已签退时算它，而签退要求"不得产生负时长"（见下），
 * 因此正常路径上它必然 >= 0；真出现负数说明有人绕过了校验，应当看得见。
 */
function workedMinutes(clockInAt: string, clockOutAt: string): number {
  const inMs = new Date(clockInAt).getTime();
  const outMs = new Date(clockOutAt).getTime();
  return Math.floor((outMs - inMs) / 60_000);
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

/**
 * 打卡。**handler 不读请求体** —— 这正是"方向由服务端判定"的实现形态。
 */
async function attendanceHandler(request: NextRequest) {
  // 中央守卫已经做过会话 + 租户 + workforce:self 权限判定；这里再解析一次是为了拿到
  // **员工档案 id**（staff id 的唯一来源）。权限矩阵回答"是否允许打卡"，
  // 但它不回答"这条记录归谁" —— 与 claim / status 两个路由同一形态。
  const context = await staffRequestContext(request);
  if (!context.ok) return context.response;
  const { tenantId, businessId, staffId } = context.ctx;

  const client = getSupabaseClient();
  const now = new Date();

  const { data: open, error: openError } = await client
    .from('staff_attendance')
    .select('id, clock_in_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    .is('clock_out_at', null)
    .maybeSingle();

  if (openError) {
    console.error('[staff/attendance] open lookup failed:', openError.message);
    return NextResponse.json({ error: 'could not read the current attendance state' }, { status: 500 });
  }

  if (!open) {
    // ---- 签到 ----
    const { data, error } = await client
      .from('staff_attendance')
      .insert({
        tenant_id: tenantId,
        business_id: businessId,
        staff_id: staffId,
        // 由数据库默认值写入，但显式给出可以让"这条记录是什么时刻产生的"与
        // 返回给客户端的 at 完全一致（避免应用时间与库时间出现毫秒级漂移）。
        clock_in_at: now.toISOString(),
        clock_in_source: 'staff_pwa',
      })
      .select('id')
      .single();

    if (error) {
      if (isUniqueViolation(error as { code?: string })) {
        // 并发双击：两条 INSERT 同时到达，另一条已经开了记录。
        // 这不是故障，是**正常的竞争结果** —— 409 让客户端刷新状态即可。
        return NextResponse.json(
          { error: 'already clocked in', code: 'already_open' },
          { status: 409 },
        );
      }
      console.error('[staff/attendance] clock-in failed:', error.message);
      return NextResponse.json({ error: 'clock in failed' }, { status: 500 });
    }

    return NextResponse.json({
      action: 'clock_in',
      at: now.toISOString(),
      attendance_id: (data as { id: string }).id,
    });
  }

  // ---- 签退 ----
  const openRow = open as { id: string; clock_in_at: string };
  const clockInMs = new Date(openRow.clock_in_at).getTime();
  if (!Number.isFinite(clockInMs)) {
    // 时间戳读不出来就没有可信的时长，宁可明确失败也不写一条乱码记录。
    console.error('[staff/attendance] unparsable clock_in_at on record', openRow.id);
    return NextResponse.json({ error: 'the open record has an unusable clock-in time' }, { status: 500 });
  }

  // 时钟回拨（客户端/库时间落后于签到时刻）会让时长为负。**仍然关闭这条记录**
  // —— 卡在"未签退"状态会挡住之后的所有签到；把负时长如实返回，让异常可见，
  // 而不是静默夹成 0 把问题藏起来。
  const worked = Math.floor((now.getTime() - clockInMs) / 60_000);

  const { data, error } = await client
    .from('staff_attendance')
    .update({ clock_out_at: now.toISOString() })
    .eq('id', openRow.id)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    // 读与写之间可能有人关过这条记录；条件不满足就不写。
    .is('clock_out_at', null)
    .select('id');

  if (error) {
    console.error('[staff/attendance] clock-out failed:', error.message);
    return NextResponse.json({ error: 'clock out failed' }, { status: 500 });
  }
  if ((data ?? []).length !== 1) {
    // 别处已经关了这条记录（例如两个标签页同时点签退）。
    return NextResponse.json(
      { error: 'already clocked in', code: 'already_open' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    action: 'clock_out',
    at: now.toISOString(),
    attendance_id: openRow.id,
    worked_minutes: worked,
  });
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:self', action: 'attendance.clock', entity: 'staff_attendance' },
  attendanceHandler,
);
