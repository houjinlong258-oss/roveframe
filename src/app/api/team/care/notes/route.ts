import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { writeRequiredAudit } from '@/lib/audit';

/**
 * 关怀记录（一对一谈话 / 观察 / 支持记录）。**本文件是整个关怀模块最需要守住的地方。**
 *
 * ===========================================================================
 * 可见性规则（硬要求，不是可调参数）
 * ===========================================================================
 *
 * 一条关怀记录的内容**只对两种人可读**：
 *
 *     author_user_id = <会话 userId>          —— 我写的
 *     该记录所属 staff.user_id = <会话 userId> —— 写我的
 *
 * 其他任何人 —— 包括 owner —— 都读不到。owner 的权限里是 `['*']`，
 * 但 `['*']` **不能**推翻这条规则：
 *
 *   · 权限矩阵表达的是"你能执行哪些**操作**"（读名册、改档案、看考勤），
 *     它无法表达"你只能读**关于你自己**的那几行" —— 那需要行级所有权，
 *     而所有权是数据属性，不是角色属性。
 *   · 于是这条规则**必须写在查询里**，而不是指望 requirePermission 拦住。
 *     这正是"权限通过 ≠ 数据可见"的经典分界：把两者混为一谈，
 *     就会写出"owner 是全能的，所以 owner 能读所有人的心理咨询记录"。
 *   · 心理安全是这块功能成立的前提。老板能读到"某员工最近情绪低落"的记录，
 *     员工就再也不会说真话，而这个模块的价值也就没了 —— 所以这不是合规姿势，
 *     是功能本身。
 *
 * 用 `isStaffVisibleToUser` 一处判定、两处使用（GET 的 staff_id 过滤与 POST 的
 * 写入目标），避免"读的时候守住了、写的时候开了个口子"这类漂移：
 * 若能给任意员工写记录，那条记录会永远对自己可见 —— 那就是一条绕过可见性的通道。
 *
 * ===========================================================================
 * 不泄露存在性
 * ===========================================================================
 *
 *  · GET 不带 staff_id → 只返回被允许的行。**不返回 403**：
 *    名单本身不该暴露"某个人有没有记录"。
 *  · GET 显式带 staff_id 且无权读 → **403**（这是刻意的，见
 *    docs/current/Phase18_Frontend_Spec.md §7.3）。为什么这里允许 403 而上面不允许：
 *    调用方已经**指名道姓**问了一个具体的员工，回答"没有"会变成一句谎言
 *    （可能确实有记录，只是你看不到）。403 只说明"你不能问这个人"，
 *    不透露这个人的记录是否存在、有几条。
 *  · **每一次读取都写审计**（`care.notes.read`）：这是隐私数据，可查证性优先于
 *    "少写一条日志"。审计只记**谁、什么时候、读了谁的记录、几条**，
 *    绝不记 content —— 审计表本身是更宽的可见面，把内容抄进去等于让隐私规则失效。
 */

const MAX_ROWS = 200;
const MAX_CONTENT = 20_000;
const NOTE_KINDS = ['one_on_one', 'observation', 'support', 'follow_up'] as const;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 当前会话可读的 staff_id 集合：**只包含 `staff.user_id = 会话 userId` 的档案**。
 *
 * 不按 tenant/business 之外的任何条件放宽 —— 这个集合就是"我本人"。
 * 一个人在同一门店通常只有一条档案，但这里用集合而不是单值：
 * 历史数据里同一账号挂多条档案是可能的（重复建档），
 * 用 `.maybeSingle()` 会在那一刻直接报错，而报错的表现是"这个人看不到自己的记录"。
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

async function auditRead(
  context: { tenantId: string; businessId: string; userId: string },
  outcome: 'allowed' | 'denied',
  requestedStaffId: string | null,
  rowCount: number,
): Promise<void> {
  await writeRequiredAudit({
    tenantId: context.tenantId,
    actorId: context.userId,
    action: `care.notes.read.${outcome}`,
    entity: 'staff_care_notes',
    // 刻意用 null 而不是把某个 note id 写进去：这条审计是"一次读取行为"，
    // 不是"某一条记录被改"。挂上单条 id 会让"读了 20 条"变成 20 条无意义的行。
    entityId: null,
    after: {
      business_id: context.businessId,
      requested_staff_id: requestedStaffId,
      rows_returned: rowCount,
      outcome,
    },
  });
}

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'workforce:care');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  const requestedStaffId = (request.nextUrl.searchParams.get('staff_id') ?? '').trim();
  if (requestedStaffId.length > 36) {
    return NextResponse.json({ error: 'invalid staff_id' }, { status: 400 });
  }

  const subjects = await subjectStaffIdsForUser(context.tenantId, context.businessId, context.userId);
  if (!subjects.ok) return NextResponse.json({ error: subjects.error }, { status: 500 });

  // 指名道姓问一个自己不是当事人的员工 → 403 + 审计。
  // 这里**不**回答"没有"，因为那可能是一句谎话（见文件头说明）。
  if (requestedStaffId && !isStaffVisibleToUser(subjects.staffIds, requestedStaffId)) {
    try {
      await auditRead(context, 'denied', requestedStaffId, 0);
    } catch {
      // 审计写不进去时**仍然拒绝**（fail-closed），但要说清原因：
      // 返回 503 而不是 403，避免调用方把"审计不可用"读成"你没有权限"。
      return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 });
    }
    return NextResponse.json(
      { error: 'care notes are only readable by their author and their subject' },
      { status: 403 },
    );
  }

  const client = getSupabaseClient();
  // 两条分支显式分开取，而不是拼一个 `or(...)` 字符串：
  //   · 作者分支：author_user_id = 我
  //   · 当事人分支：staff_id ∈ 我的档案
  // PostgREST 的 or 语法对 null / in-list 的拼接极易写错，而写错的表现是
  // **静默多返回**（把别人的记录读出来），这是最不能出错的一类。
  type NotesResult = { data: unknown[] | null; error: { message: string } | null };
  const selectColumns = 'id, staff_id, author_user_id, kind, content, visibility, created_at';

  const authorBranch = await (
    client
      .from('staff_care_notes')
      .select(selectColumns)
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .eq('author_user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS) as unknown as PromiseLike<NotesResult>
  );
  if (authorBranch.error) {
    return NextResponse.json({ error: authorBranch.error.message }, { status: 500 });
  }

  const results: NotesResult[] = [authorBranch];
  if (subjects.staffIds.length > 0) {
    const subjectBranch = await (
      client
        .from('staff_care_notes')
        .select(selectColumns)
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId)
        .in('staff_id', subjects.staffIds)
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS) as unknown as PromiseLike<NotesResult>
    );
    if (subjectBranch.error) {
      return NextResponse.json({ error: subjectBranch.error.message }, { status: 500 });
    }
    results.push(subjectBranch);
  }

  // 作者分支与当事人分支会**重叠**（我写的、且写的是我自己），必须按 id 去重，
  // 否则同一条记录在列表里出现两次。
  const byId = new Map<string, Record<string, unknown>>();
  for (const result of results) {
    for (const raw of result.data ?? []) {
      const row = raw as Record<string, unknown>;
      byId.set(String(row.id), row);
    }
  }

  const notes = Array.from(byId.values())
    .filter((row) => !requestedStaffId || String(row.staff_id) === requestedStaffId)
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
    .slice(0, MAX_ROWS)
    .map((row) => {
      const isAuthor = String(row.author_user_id) === context.userId;
      return {
        id: String(row.id),
        staff_id: String(row.staff_id),
        kind: String(row.kind ?? 'one_on_one'),
        content: String(row.content ?? ''),
        visibility: String(row.visibility ?? 'private'),
        created_at: row.created_at ?? null,
        // 只暴露"是不是我写的"，**不暴露 author_user_id**：
        // 当事人需要知道"这话是我说的还是别人对我说的话"，但不需要知道
        // 对方在 users 表里的 id（那是另一个人的标识符，与本次读取无关）。
        mine: isAuthor,
        author_is_me: isAuthor,
      };
    });

  try {
    await auditRead(context, 'allowed', requestedStaffId || null, notes.length);
  } catch {
    // 读取已经发生，但审计写不进去 → 不返回内容。隐私数据的读取必须可查证，
    // "读到了但没留痕"正是这个模块最不该出现的状态。
    return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 });
  }

  return NextResponse.json({ notes });
}

async function createNote(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: { staff_id?: unknown; kind?: unknown; content?: unknown; visibility?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const staffId = typeof body.staff_id === 'string' ? body.staff_id.trim() : '';
  if (!staffId || staffId.length > 36) {
    return NextResponse.json({ error: 'staff_id is required' }, { status: 400 });
  }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 });
  if (content.length > MAX_CONTENT) {
    return NextResponse.json(
      { error: `content must be at most ${MAX_CONTENT} characters` },
      { status: 400 },
    );
  }
  const kind = typeof body.kind === 'string' && body.kind.trim()
    ? body.kind.trim()
    : 'one_on_one';
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { error: `kind must be one of ${NOTE_KINDS.join(', ')}` },
      { status: 400 },
    );
  }
  const visibility = typeof body.visibility === 'string' && body.visibility.trim()
    ? body.visibility.trim()
    : 'private';
  // 白名单固定为 private。**不接受**任何"更宽"的取值：这列将来若要区分展示方式，
  // 也只能在同一套读取规则下区分。现在放开取值等于给未来埋一个
  // "把 visibility 写成 public 就绕过了隐私规则"的隐患。
  if (visibility !== 'private') {
    return NextResponse.json(
      { error: 'visibility is currently fixed to private', allowed: ['private'] },
      { status: 400 },
    );
  }

  const subjects = await subjectStaffIdsForUser(context.tenantId, context.businessId, context.userId);
  if (!subjects.ok) return NextResponse.json({ error: subjects.error }, { status: 500 });

  // 目标员工必须**本店在职/在册**，且必须是"我自己" —— 理由见文件头：
  // 给自己之外的员工写记录会制造一条只有作者能读的内容，那是绕过可见性的通道。
  const { data: target, error: targetError } = await getSupabaseClient()
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: 'staff not found in this store' }, { status: 404 });
  if (!isStaffVisibleToUser(subjects.staffIds, staffId)) {
    try {
      await writeRequiredAudit({
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'care.notes.write.denied',
        entity: 'staff_care_notes',
        entityId: null,
        after: { business_id: context.businessId, requested_staff_id: staffId, outcome: 'denied' },
      });
    } catch {
      return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 });
    }
    return NextResponse.json(
      { error: 'care notes can only be written about yourself in this release' },
      { status: 403 },
    );
  }

  const { data, error } = await getSupabaseClient()
    .from('staff_care_notes')
    .insert({
      tenant_id: context.tenantId,
      business_id: context.businessId,
      staff_id: staffId,
      // 作者**只来自会话**。绝不从请求体读 author_user_id ——
      // 那等于允许把自己写的内容挂到别人名下，可见性规则立刻失效。
      author_user_id: context.userId,
      kind,
      content,
      visibility,
    })
    .select('id, staff_id, kind, content, visibility, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, note: { ...(data as Record<string, unknown>), mine: true } }, { status: 201 });
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:care', action: 'care.notes.create', entity: 'staff_care_notes' },
  createNote,
);
