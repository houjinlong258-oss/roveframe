import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { writeRequiredAudit } from '@/lib/audit';
import { getSettings } from '@/lib/settings';
import {
  businessDayRange,
  localDateInTimeZone,
  resolveBusinessTimeZone,
} from '@/lib/time';

/**
 * 老板端考勤：全店打卡记录 + 补卡（补卡 = 事后修正打卡时间）。
 *
 * ## 为什么"补卡必须填理由"
 *
 * 补卡改的是**工时证据**。没有理由的补卡在事后审计里与"改数"无法区分 ——
 * 谁改的、为什么改，两者都没有。因此 `reason` 是硬性要求（缺失或空白 → 400），
 * 并且整条修改会走中央守卫写入审计（`attendance.retroactive`），
 * 记录 before/after 与实际操作人。
 *
 * ## 权限
 *
 * 读与写都要求 `workforce:manage`（员工自己看自己的走 /api/staff/attendance）。
 * 补卡**不**给员工自助入口：员工能改自己的工时就等于工时不可信。
 */

const MAX_ROWS = 500;
/** 单次查询的时间跨度上限（天）。没有上限时一次请求可以拉全表历史。 */
const MAX_RANGE_DAYS = 62;
const DEFAULT_RANGE_DAYS = 7;
/** 与迁移里 staff_attendance.note 的长度一致。 */
const MAX_NOTE = 240;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 纯日历加天数（不经过 Date 的时区语义）。 */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daySpan(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export async function GET(request: NextRequest) {
  let context;
  let timeZone: string;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'workforce:manage');
    const settings = await getSettings(context.tenantId, context.businessId);
    timeZone = resolveBusinessTimeZone(settings.locale.timezone);
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  // 默认区间按**业务时区**算今天，绝不用进程时区（服务器可能是 CST，
  // 门店在 America/New_York；用进程时区会让"今天"整体错一天）。
  const today = localDateInTimeZone(new Date(), timeZone);
  const fromRaw = request.nextUrl.searchParams.get('from');
  const toRaw = request.nextUrl.searchParams.get('to');
  const from = (fromRaw ?? addDays(today, -(DEFAULT_RANGE_DAYS - 1))).trim();
  const to = (toRaw ?? today).trim();
  if (!YMD.test(from) || !YMD.test(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  const span = daySpan(from, to);
  if (span < 0) return NextResponse.json({ error: 'from must not be after to' }, { status: 400 });
  if (span + 1 > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `range too large (max ${MAX_RANGE_DAYS} days)` },
      { status: 400 },
    );
  }

  const staffId = (request.nextUrl.searchParams.get('staff_id') ?? '').trim();
  if (staffId && staffId.length > 36) {
    return NextResponse.json({ error: 'invalid staff_id' }, { status: 400 });
  }

  // 用业务日的 UTC 起止时刻做闭开区间比较 —— 直接拿 'YYYY-MM-DD' 比 timestamptz
  // 会把边界上的记录算错（而且错法随时区变化）。
  const { start } = businessDayRange(from, timeZone);
  const { end } = businessDayRange(to, timeZone);

  const client = getSupabaseClient();
  let query = client
    .from('staff_attendance')
    .select('id, staff_id, shift_id, clock_in_at, clock_out_at, clock_in_source, note')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .gte('clock_in_at', start.toISOString())
    .lt('clock_in_at', end.toISOString())
    .order('clock_in_at', { ascending: false })
    .limit(MAX_ROWS);
  if (staffId) query = query.eq('staff_id', staffId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 员工姓名单独查一次：staff 与 staff_attendance 之间**没有外键**，
  // PostgREST 的嵌套关系推断嵌不进去（与 team/delivery 同一处理）。
  const staffIds = Array.from(new Set(
    (data ?? []).map((row) => (row as { staff_id?: string }).staff_id).filter(Boolean) as string[],
  ));
  const nameById = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staffRows, error: staffError } = await client
      .from('staff')
      .select('id, name')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .in('id', staffIds);
    if (staffError) return NextResponse.json({ error: staffError.message }, { status: 500 });
    for (const row of staffRows ?? []) {
      const typed = row as { id: string; name: string };
      nameById.set(String(typed.id), String(typed.name));
    }
  }

  const records = (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const clockIn = String(row.clock_in_at ?? '');
    const clockOut = row.clock_out_at ? String(row.clock_out_at) : null;
    const fromMs = Date.parse(clockIn);
    const toMs = clockOut ? Date.parse(clockOut) : Number.NaN;
    // worked_minutes 只在两端都可解析且顺序正确时给出，否则 **null**。
    // 用 0 代替会让"还没签退"看起来像"上了 0 分钟"，那是两条完全不同的语义。
    const workedMinutes = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs
      ? Math.round((toMs - fromMs) / 60_000)
      : null;
    return {
      id: String(row.id),
      staff_id: String(row.staff_id ?? ''),
      staff_name: nameById.get(String(row.staff_id ?? '')) ?? null,
      shift_id: row.shift_id ?? null,
      clock_in_at: clockIn,
      clock_out_at: clockOut,
      worked_minutes: workedMinutes,
      clock_in_source: String(row.clock_in_source ?? 'staff_pwa'),
      note: row.note ?? null,
    };
  });

  return NextResponse.json({ records, from, to, timezone: timeZone });
}

interface PunchBody {
  clock_in_at?: unknown;
  clock_out_at?: unknown;
  reason?: unknown;
}

async function retroactivePunch(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  const id = (request.nextUrl.searchParams.get('id') ?? '').trim();
  if (!id || id.length > 36) {
    return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
  }

  let body: PunchBody;
  try {
    body = (await request.json()) as PunchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 理由必填。**空白字符串也算缺失** —— 只判断 undefined 的话，
  // UI 上一个空输入框提交会被当成"已填写理由"，审计里就出现一条没有理由的补卡。
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json(
      { error: 'reason is required for a retroactive punch', code: 'reason_required' },
      { status: 400 },
    );
  }
  if (reason.length > 200) {
    return NextResponse.json({ error: 'reason must be at most 200 characters' }, { status: 400 });
  }

  const clockIn = typeof body.clock_in_at === 'string' ? body.clock_in_at.trim() : '';
  if (!clockIn) {
    return NextResponse.json({ error: 'clock_in_at is required' }, { status: 400 });
  }
  const fromMs = Date.parse(clockIn);
  if (Number.isNaN(fromMs)) {
    return NextResponse.json({ error: 'clock_in_at must be an ISO-8601 timestamp' }, { status: 400 });
  }
  // 不允许把打卡时间写到未来：那会让"未签退"永远成立、工时统计立即失真。
  // 给 5 分钟容差，避免客户端与服务端时钟偏差把刚打的卡判成未来。
  if (fromMs > Date.now() + 5 * 60_000) {
    return NextResponse.json({ error: 'clock_in_at must not be in the future' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {
    clock_in_at: new Date(fromMs).toISOString(),
    // 来源列是"这条记录是补出来的"的**可查证据**（与 staff_pwa 区分）。
    clock_in_source: 'manager_fix',
    note: `${reason}（补卡 by ${context.userId}）`.slice(0, MAX_NOTE),
  };

  if (body.clock_out_at !== undefined && body.clock_out_at !== null) {
    if (typeof body.clock_out_at !== 'string' || !body.clock_out_at.trim()) {
      return NextResponse.json({ error: 'clock_out_at must be an ISO-8601 timestamp or null' }, { status: 400 });
    }
    const toMs = Date.parse(body.clock_out_at.trim());
    if (Number.isNaN(toMs)) {
      return NextResponse.json({ error: 'clock_out_at must be an ISO-8601 timestamp' }, { status: 400 });
    }
    if (toMs <= fromMs) {
      return NextResponse.json({ error: 'clock_out_at must be after clock_in_at' }, { status: 400 });
    }
    if (toMs > Date.now() + 5 * 60_000) {
      return NextResponse.json({ error: 'clock_out_at must not be in the future' }, { status: 400 });
    }
    patch.clock_out_at = new Date(toMs).toISOString();
  }

  // 补卡可能把一条记录变成"已签退"或反之，因此要带上原先的 before 值给审计用。
  const client = getSupabaseClient();
  const { data: before, error: beforeError } = await client
    .from('staff_attendance')
    .select('id, staff_id, clock_in_at, clock_out_at, clock_in_source, note')
    .eq('id', id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .maybeSingle();
  if (beforeError) return NextResponse.json({ error: beforeError.message }, { status: 500 });
  if (!before) return NextResponse.json({ error: 'attendance record not found' }, { status: 404 });

  // 先读后写之间存在窗口，因此 UPDATE 链上仍然带 tenant + business 过滤。
  const { data, error } = await client
    .from('staff_attendance')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .select('id, staff_id, clock_in_at, clock_out_at, clock_in_source, note')
    .maybeSingle();
  if (error) {
    // 23505 = 撞 staff_attendance_open_key（同一员工只能有一条未签退记录）。
    // 这是**语义冲突**而不是服务器错误：补卡把 clock_out_at 置空、或把
    // 一条已签退记录改成未签退，都可能撞上。
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'this staff member already has an open punch', code: 'already_open' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'attendance record not found' }, { status: 404 });

  // before/after 直接进审计（中央守卫已写 outcome 条目；这里补一条带差异的明细）。
  // 审计失败必须让请求失败 —— 补卡是"改工时证据"，没有留痕的补卡不可接受。
  await writeRequiredAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: 'attendance.retroactive.detail',
    entity: 'staff_attendance',
    entityId: id,
    before,
    after: { ...patch, reason },
  });

  return NextResponse.json({ ok: true, record: data });
}

export const PATCH = protectBusinessMutation(
  { permission: 'workforce:manage', action: 'attendance.retroactive', entity: 'staff_attendance' },
  retroactivePunch,
);
