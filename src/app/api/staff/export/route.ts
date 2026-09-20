import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { writeRequiredAudit } from '@/lib/audit';

/**
 * 员工自己的数据导出：`GET /api/staff/export`。
 *
 * ===========================================================================
 * 这是一条**隐私义务**，不是功能
 * ===========================================================================
 *
 * 项目承诺过"员工可以导出自己的考勤与档案数据"。数据层重写时这条链路丢了，
 * 本文件把它补回来。因此这里的每一条约束都按"审计会看"的标准写，而不是
 * 按"页面能跑通"的标准写。
 *
 * ## 1. 只能导出**自己**，且 staff id 只来自会话
 *
 * 本路由**没有** `?staff_id=`：目标员工由 `staffRequestContext` 从会话解析
 * （会话 → 权限 `workforce:self` → 员工档案）。只要有一个查询参数能指定别人，
 * 它就立刻变成"导出任意同事的档案与考勤"的接口，而权限矩阵**表达不了**
 * "你只能导出关于你自己的那几行"（那是行级所有权，不是角色属性）。
 * 这与 src/app/api/staff/attendance/route.ts、shifts/route.ts 同一口径。
 *
 * ## 2. 关怀记录的可见性规则**逐条照抄**老板端
 *
 * 内容来自 `staff_care_notes`，而那条规则写在
 * src/app/api/team/care/notes/route.ts 的文件头：一条关怀记录只对两种人可读 ——
 *
 *     author_user_id = <会话 userId>          —— 我写的
 *     该记录所属 staff.user_id = <会话 userId> —— 写我的
 *
 * 这里**不发明第二套规则**，连查询形态都一致：作者分支与当事人分支**分开取**
 * 再按 id 去重，而不是拼一个 PostgREST 的 `or(...)` 字符串
 * （or 语法对 null / in-list 的拼接极易写错，而写错的表现是**静默多返回**）。
 *
 * ## 3. 每一次导出都写审计，写不进去就不导出
 *
 * 这是一次**个人数据的批量读取**，可查证性优先。与关怀记录的读取用的是同一个
 * 函数：`writeRequiredAudit`（src/lib/audit.ts）—— 它在写库失败时**抛错**，
 * 而不是像 `writeAudit` 那样 best-effort。本路由捕获后返回 **503**，
 * 并且在审计落库**之前**不把任何一条数据交给调用方：
 * "读到了但没留痕"正是这类接口最不该出现的状态。
 *
 * 审计只记**谁、什么时候、导出了几行**，绝不记 content —— 审计表本身是更宽的
 * 可见面，把关怀记录抄进去等于让隐私规则失效。
 *
 * ## 4. 返回的是原始列，不是派生视图
 *
 * 导出的定位是"数据副本"：考勤/排班只给库里的列本身，不在这里算
 * `worked_minutes` 之类的派生字段 —— 那套算法住在 /api/staff/attendance 里，
 * 抄一份过来就会漂移，而漂移的症状是"导出的工时和页面上显示的不一样"。
 */

/** 每块的取数上限。导出是"取全量"，但仍要有上限，否则一条 10 年的考勤会拖垮进程。 */
const MAX_ROWS = 2000;

/**
 * 当前会话可读的 staff_id 集合：**只包含 `staff.user_id = 会话 userId` 的档案**。
 *
 * 与 src/app/api/team/care/notes/route.ts 的同名逻辑逐字一致（含"用集合而不是
 * 单值"的理由：历史数据里同一账号挂多条档案是可能的，`.maybeSingle()` 会在
 * 那一刻直接报错，而报错的表现是"这个人看不到自己的记录"）。
 */
async function subjectStaffIdsForUser(
  tenantId: string,
  businessId: string,
  userId: string,
): Promise<{ ok: true; staffIds: string[] } | { ok: false; error: string }> {
  const { data, error } = await getSupabaseClient()
    .from('staff')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, staffIds: (data ?? []).map((row) => String((row as { id: string }).id)) };
}

/** 某个 staff_id 是否对当前会话可见（= 是当事人本人）。 */
function isStaffVisibleToUser(staffIds: string[], staffId: string): boolean {
  return staffIds.includes(staffId);
}

/** 导出到 JSON 里的一条关怀记录。**不含 author_user_id**（见下）。 */
export interface ExportedCareNote {
  id: string;
  staff_id: string;
  kind: string;
  content: string;
  visibility: string;
  created_at: unknown;
}

/**
 * 把"我写的"（作者分支）与"写我的"（当事人分支）合并成一份可见清单。
 *
 * 抽成纯函数是为了它能被**执行**验证，而不是只被正则检查：这里三件事
 * 少做一件，导出内容都会失真，而且**不会报错** ——
 *   · 按 id 去重：两个分支会重叠（我写的、且写的是我自己），不去重的话
 *     同一条记录会在导出里出现两次，员工会以为有过两次谈话；
 *   · 按 created_at 倒序：与老板端 /api/team/care/notes 的列表顺序一致；
 *   · 丢掉 author_user_id：当事人需要知道"这话是谁说的"，但不需要对方的
 *     账号 id —— 那是另一个人的标识符，与"我自己的数据"无关。
 */
export function mergeVisibleCareNotes(
  branchRows: (Record<string, unknown>[] | null)[],
): ExportedCareNote[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const rows of branchRows) {
    for (const row of rows ?? []) byId.set(String(row.id), row);
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
    .map((row) => ({
      id: String(row.id),
      staff_id: String(row.staff_id),
      kind: String(row.kind ?? 'one_on_one'),
      content: String(row.content ?? ''),
      visibility: String(row.visibility ?? 'private'),
      created_at: row.created_at ?? null,
    }));
}

export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, userId, staffId, staffName, staffPosition, staffPhotoUrl } =
    resolved.ctx;

  const client = getSupabaseClient();

  // ---- 档案 --------------------------------------------------------------
  // 只取**身份上下文里没有的**列：name / position / photo_url 直接用
  // `staffRequestContext` 解析出来的值（与 /api/staff/me 同源）——
  // 同一次请求里把同一个值读两遍，就多出两处可以漂移的地方。
  const { data: staffRaw, error: staffError } = await client
    .from('staff')
    .select('phone, email, employment_type, hired_at, birthday, status')
    .eq('id', staffId)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (staffError) {
    console.error('[staff/export] staff lookup failed:', staffError.message);
    return NextResponse.json({ error: 'could not read the staff profile' }, { status: 500 });
  }
  if (!staffRaw) {
    // staffRequestContext 刚刚解析出这条档案，这里却查不到 —— 只可能是
    // 这一瞬间被删了。回 409 而不是空档案：回一份"没有档案的导出"会让员工
    // 以为自己的数据丢了，而真相是"这条档案不存在了"。
    return NextResponse.json(
      { error: 'your staff profile no longer exists', code: 'staff_not_found' },
      { status: 409 },
    );
  }
  const staffRow = staffRaw as Record<string, unknown>;

  // ---- 考勤（只取本人） ---------------------------------------------------
  const { data: attendanceRaw, error: attendanceError } = await client
    .from('staff_attendance')
    .select('id, clock_in_at, clock_out_at, clock_in_source, note')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    .order('clock_in_at', { ascending: false })
    .limit(MAX_ROWS);
  if (attendanceError) {
    console.error('[staff/export] attendance read failed:', attendanceError.message);
    return NextResponse.json({ error: 'could not read attendance' }, { status: 500 });
  }

  // ---- 排班（只取本人） ---------------------------------------------------
  const { data: shiftsRaw, error: shiftsError } = await client
    .from('staff_shifts')
    .select('id, starts_at, ends_at, role, note')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    .order('starts_at', { ascending: true })
    .limit(MAX_ROWS);
  if (shiftsError) {
    console.error('[staff/export] shifts read failed:', shiftsError.message);
    return NextResponse.json({ error: 'could not read shifts' }, { status: 500 });
  }

  // ---- 关怀记录（可见性规则与老板端完全一致） ------------------------------
  const subjects = await subjectStaffIdsForUser(tenantId, businessId, userId);
  if (!subjects.ok) {
    console.error('[staff/export] care-note subject lookup failed:', subjects.error);
    return NextResponse.json({ error: 'could not read care notes' }, { status: 500 });
  }
  // 防御性断言：会话解析出的 staffId 必须在"我本人"集合里。不在，说明两条
  // 查询口径已经漂移（例如 resolveStaffForUser 的过滤条件被改窄/改宽），
  // 那时**导出内容是不可信的** —— 宁可 500，也不要交出一份来源不明的数据。
  if (!isStaffVisibleToUser(subjects.staffIds, staffId)) {
    console.error('[staff/export] resolved staff id is not a subject of the session user');
    return NextResponse.json({ error: 'could not verify data ownership' }, { status: 500 });
  }

  type NotesResult = { data: unknown[] | null; error: { message: string } | null };
  const noteColumns = 'id, staff_id, author_user_id, kind, content, visibility, created_at';

  const authorBranch = await (
    client
      .from('staff_care_notes')
      .select(noteColumns)
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .eq('author_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS) as unknown as PromiseLike<NotesResult>
  );
  if (authorBranch.error) {
    console.error('[staff/export] care-note author branch failed:', authorBranch.error.message);
    return NextResponse.json({ error: 'could not read care notes' }, { status: 500 });
  }

  const branches: NotesResult[] = [authorBranch];
  if (subjects.staffIds.length > 0) {
    const subjectBranch = await (
      client
        .from('staff_care_notes')
        .select(noteColumns)
        .eq('tenant_id', tenantId)
        .eq('business_id', businessId)
        .in('staff_id', subjects.staffIds)
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS) as unknown as PromiseLike<NotesResult>
    );
    if (subjectBranch.error) {
      console.error('[staff/export] care-note subject branch failed:', subjectBranch.error.message);
      return NextResponse.json({ error: 'could not read care notes' }, { status: 500 });
    }
    branches.push(subjectBranch);
  }

  // 两个分支会**重叠**（我写的、且写的是我自己），合并逻辑见 mergeVisibleCareNotes。
  const careNotes = mergeVisibleCareNotes(
    branches.map((branch) => (branch.data ?? []) as Record<string, unknown>[]),
  );

  const attendance = (attendanceRaw ?? []) as Record<string, unknown>[];
  const shifts = (shiftsRaw ?? []) as Record<string, unknown>[];

  try {
    await writeRequiredAudit({
      tenantId,
      actorId: userId,
      action: 'staff.export',
      entity: 'staff',
      // 与关怀记录读取刻意用 null 的写法不同：导出的主体**就是这一条**员工档案，
      // 而这个 id 来自会话（客户端无从指定），把它记下来才回答得了
      // "谁在什么时候导出了谁的数据"。
      entityId: staffId,
      after: {
        business_id: businessId,
        attendance_rows: attendance.length,
        shift_rows: shifts.length,
        care_note_rows: careNotes.length,
        // 只记条数，绝不记内容：审计表是更宽的可见面。
      },
    });
  } catch (error) {
    console.error(
      '[staff/export] required audit write failed:',
      error instanceof Error ? error.message : error,
    );
    // 审计写不进去 → 一个字节都不给。这不是"少写一条日志"，是这条导出行为
    // 失去了可查证性（见文件头第 3 条）。
    return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 });
  }

  const body = {
    exported_at: new Date().toISOString(),
    staff: {
      id: staffId,
      // name / position / photo_url 来自会话解析出的身份（与 /api/staff/me 同源）。
      name: staffName,
      position: staffPosition,
      photo_url: staffPhotoUrl,
      // 其余列来自档案行本身。
      phone: staffRow.phone ?? null,
      email: staffRow.email ?? null,
      employment_type: staffRow.employment_type ?? null,
      hired_at: staffRow.hired_at ?? null,
      birthday: staffRow.birthday ?? null,
      status: staffRow.status ?? null,
    },
    attendance,
    shifts,
    care_notes: careNotes,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // 文件名里的 staff id 来自会话解析出的档案，客户端无从注入。
      'Content-Disposition': `attachment; filename="roveframe-staff-export-${staffId}.json"`,
      // 个人数据不得被中间缓存（CDN / 代理 / 浏览器磁盘缓存）留存。
      'Cache-Control': 'no-store',
    },
  });
}
