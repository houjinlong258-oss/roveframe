import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getSettings } from '@/lib/settings';
import {
  businessDayRange,
  localDateInTimeZone,
  resolveBusinessTimeZone,
  timeZoneOffsetMinutes,
} from '@/lib/time';
import { computeSignals, type SignalInput } from '@/lib/workforce-signals';

/**
 * 老板端关怀信号：今天的待办 + 「立即计算」。
 *
 * ## 为什么 GET 与 POST 在同一个文件
 *
 * 两者读写的都是同一份 `staff_care_tasks`，且 POST 的结果就是 GET 的内容。
 * 拆成两个文件会让"计算一次然后看结果"这条路径跨两个接口，
 * 而它的前端用法恰恰是"点一下，然后列表刷新"。
 *
 * ## 计算窗口为什么是 [今天-21 天, 今天+7 天]
 *
 * 信号里有三处需要**历史**：
 *   · rest          连续上班天数 —— 最长只需回看 restStreakDays + 1 天；
 *   · overtime      本周工时 —— 只需本周；
 *   · missing_punch 过去某天的排班没有打卡 —— 回看得越久越多噪音。
 * 21 天足以覆盖 6 天连续判断加上补卡后重算的时间差，同时把单次查询限制在
 * 有界范围内（没有窗口时一次请求会拉全表历史）。
 * +7 天是为了让"下周的班次"也进入 missing_punch 的判断范围（它只回看过去，
 * 但取数时先把窗口取全，避免"今天之后排的班"被当成不存在）。
 *
 * ## 落库幂等靠唯一索引，不靠"先查再插"
 *
 * 插入用 `onConflict: tenant_id,business_id,signal_key` + `ignoreDuplicates`，
 * 撞的是迁移里那条部分唯一索引。定时任务与「立即计算」按钮并发触发时，
 * 数据库只会留下一条。用"先查有没有再插"在并发下必然漏（两个请求都查到"没有"）。
 */

const MAX_ROWS = 200;
const MAX_SIGNAL_ROWS = 200;
const LOOKBACK_DAYS = 21;
const LOOKAHEAD_DAYS = 7;
/** 与迁移里的列长度一致；超长会让整批插入失败，因此在插入前收敛。 */
const MAX_TITLE = 160;
const MAX_DETAIL = 600;

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

interface StaffRow { id: string; name: string; birthday: string | null; hired_at: string | null }

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'workforce:care');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  const statusFilter = request.nextUrl.searchParams.get('status') ?? 'open';
  const client = getSupabaseClient();
  let query = client
    .from('staff_care_tasks')
    .select('id, staff_id, kind, title, detail, due_at, status, suggested_by, signal_key, decided_by, decided_at, decision_note, created_at')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    // 待办先按到期时间升序（null 由 Postgres 默认排在最后），再按创建时间倒序：
    // 只按 created_at 排会让"今天到期"的事项淹没在昨天批量写入的行里。
    .order('due_at', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  const signals = (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      staff_id: String(row.staff_id ?? ''),
      // 员工档案可能已被删除（无外键，见迁移说明）。此时名称是 **null** 而不是空串，
      // 让 UI 能显示"员工记录已删除"而不是一个没有名字的待办。
      staff_name: nameById.get(String(row.staff_id ?? '')) ?? null,
      kind: String(row.kind ?? ''),
      title: String(row.title ?? ''),
      detail: row.detail ?? null,
      due_at: row.due_at ?? null,
      status: String(row.status ?? 'open'),
      suggested_by: String(row.suggested_by ?? 'agent'),
      signal_key: row.signal_key ?? null,
      decided_by: row.decided_by ?? null,
      decided_at: row.decided_at ?? null,
      decision_note: row.decision_note ?? null,
      created_at: row.created_at ?? null,
    };
  });

  return NextResponse.json({ signals });
}

/**
 * 立即计算一遍信号并落库。
 *
 * 返回值里的 `created` 才是真正新插入的条数；`computed` 是本轮算出的信号总数。
 * 两者不同是**正常**的（绝大多数信号当天已经提过，撞唯一索引被忽略），
 * 前端不该把"没有新增"显示成失败。
 */
async function recomputeSignals(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  // body 允许为空（Curl / 定时调用常见）。有 body 时必须是合法 JSON ——
  // 静默吞掉解析错误会让"我传了参数却没生效"无从排查。
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const settings = await getSettings(context.tenantId, context.businessId);
  const timeZone = resolveBusinessTimeZone(settings.locale.timezone);
  const offsetMinutes = timeZoneOffsetMinutes(new Date(), timeZone);
  const today = localDateInTimeZone(new Date(), timeZone);
  const windowStartDate = addDays(today, -LOOKBACK_DAYS);
  const windowEndDate = addDays(today, LOOKAHEAD_DAYS);
  const { start } = businessDayRange(windowStartDate, timeZone);
  const { end } = businessDayRange(windowEndDate, timeZone);

  const client = getSupabaseClient();
  // 在职员工才计算信号。离职的人不该出现在"今天该关心谁"里 ——
  // 那不是关怀，那是噪音，而且会让老板不再看这个页面。
  const { data: staffRows, error: staffError } = await client
    .from('staff')
    .select('id, name, birthday, hired_at')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .eq('status', 'active')
    .limit(MAX_SIGNAL_ROWS);
  if (staffError) return NextResponse.json({ error: staffError.message }, { status: 500 });

  const staff: StaffRow[] = (staffRows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      birthday: stringOrNull(row.birthday),
      hired_at: stringOrNull(row.hired_at),
    };
  });
  if (staff.length === 0) {
    return NextResponse.json({ ok: true, computed: 0, created: 0, today, timezone: timeZone });
  }

  const staffIds = staff.map((s) => s.id);
  // 两张输入表都用同一窗口一次取回，避免 N+1（每个员工两条查询）。
  const [shiftsResult, attendanceResult] = await Promise.all([
    client
      .from('staff_shifts')
      .select('staff_id, starts_at, ends_at')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .in('staff_id', staffIds)
      .gte('starts_at', start.toISOString())
      .lt('starts_at', end.toISOString())
      .order('starts_at', { ascending: true })
      .limit(MAX_ROWS * 4),
    client
      .from('staff_attendance')
      .select('staff_id, clock_in_at, clock_out_at')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .in('staff_id', staffIds)
      .gte('clock_in_at', start.toISOString())
      .lt('clock_in_at', end.toISOString())
      .order('clock_in_at', { ascending: true })
      .limit(MAX_ROWS * 4),
  ]);
  if (shiftsResult.error) {
    return NextResponse.json({ error: shiftsResult.error.message }, { status: 500 });
  }
  if (attendanceResult.error) {
    return NextResponse.json({ error: attendanceResult.error.message }, { status: 500 });
  }

  const shiftsByStaff = new Map<string, { starts_at: string; ends_at: string }[]>();
  for (const raw of shiftsResult.data ?? []) {
    const row = raw as { staff_id: string; starts_at: string; ends_at: string };
    const list = shiftsByStaff.get(row.staff_id) ?? [];
    list.push({ starts_at: row.starts_at, ends_at: row.ends_at });
    shiftsByStaff.set(row.staff_id, list);
  }
  const attendanceByStaff = new Map<string, { clock_in_at: string; clock_out_at: string | null }[]>();
  for (const raw of attendanceResult.data ?? []) {
    const row = raw as { staff_id: string; clock_in_at: string; clock_out_at: string | null };
    const list = attendanceByStaff.get(row.staff_id) ?? [];
    list.push({ clock_in_at: row.clock_in_at, clock_out_at: row.clock_out_at });
    attendanceByStaff.set(row.staff_id, list);
  }

  const rows: Record<string, unknown>[] = [];
  for (const member of staff) {
    const input: SignalInput = {
      staffId: member.id,
      staffName: member.name,
      birthday: member.birthday,
      hiredAt: member.hired_at,
      shifts: shiftsByStaff.get(member.id) ?? [],
      attendance: attendanceByStaff.get(member.id) ?? [],
      today,
      tzOffsetMinutes: offsetMinutes,
    };
    for (const signal of computeSignals(input)) {
      rows.push({
        tenant_id: context.tenantId,
        business_id: context.businessId,
        staff_id: signal.staffId,
        kind: signal.kind,
        title: signal.title.slice(0, MAX_TITLE),
        detail: signal.detail.slice(0, MAX_DETAIL),
        due_at: signal.dueAt,
        status: 'open',
        // 信号是**建议**，提出者固定为 agent；只有人 accept / dismiss 才推进状态。
        suggested_by: 'agent',
        signal_key: signal.signalKey,
      });
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, computed: 0, created: 0, today, timezone: timeZone });
  }

  // upsert + ignoreDuplicates 而不是 insert：insert 撞唯一索引会返回 23505，
  // 而"重复"在这里是**预期状态**（每天都会重算同一批信号），不是错误。
  const { data: inserted, error: insertError } = await client
    .from('staff_care_tasks')
    .upsert(rows, {
      onConflict: 'tenant_id,business_id,signal_key',
      ignoreDuplicates: true,
    })
    .select('id');
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    computed: rows.length,
    created: (inserted ?? []).length,
    today,
    timezone: timeZone,
  });
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:care', action: 'care.signals.recompute', entity: 'staff_care_tasks' },
  recomputeSignals,
);
