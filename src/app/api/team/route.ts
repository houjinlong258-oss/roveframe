import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * 老板端的员工档案：列表 / 新建 / 修改。
 *
 * 与员工端严格分开：
 *   /api/staff/me        —— 员工看**自己**的档案
 *   /api/team            —— 老板看**全店**、建人、改档案
 * 合并成一个接口等于让员工端也拿到全店员工的名册与薪资字段。
 *
 * `hourly_rate` 属于敏感字段：它只出现在这条路（`workforce:manage`）上，
 * 员工端接口不 select 它。
 */

const MAX_ROWS = 200;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
const STAFF_STATUSES = ['active', 'inactive', 'on_leave'] as const;
/** 与迁移里的列长度一致。超长直接 400，不要靠数据库截断报 500。 */
const EMPLOYMENT_TYPE_LENGTH = 20;
const STATUS_LENGTH = 20;
const MAX_NAME = 128;
const MAX_POSITION = 60;
const MAX_PHONE = 40;
const MAX_EMAIL = 255;
const MAX_EMERGENCY_CONTACT = 160;

const SELECT_COLUMNS =
  'id, name, position, phone, email, employment_type, hourly_rate, hired_at, birthday, '
  + 'emergency_contact, status, is_active, user_id, role, photo_url, created_at';

interface StaffListItem {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  employment_type: string;
  hourly_rate: number | null;
  hired_at: string | null;
  birthday: string | null;
  emergency_contact: string | null;
  status: string;
  is_active: boolean;
  user_id: string | null;
  /** 是否已关联登录账号。UI 用它决定显示"邀请"还是"已绑定"。 */
  has_account: boolean;
  role: string | null;
  photo_url: string | null;
  created_at: string | null;
}

/**
 * 把 PostgREST 回来的任意值收敛成 `string | null`。
 *
 * 不做 `String(value)` 兜底：那会把 null 变成 "null"、把对象变成 "[object Object]"，
 * 于是页面上出现字面量 "null" 而不是空字段 —— 比直接留空难查得多。
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function mapStaff(raw: unknown): StaffListItem {
  const row = raw as Record<string, unknown>;
  const userId = stringOrNull(row.user_id);
  const rate = row.hourly_rate;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    position: stringOrNull(row.position),
    phone: stringOrNull(row.phone),
    email: stringOrNull(row.email),
    employment_type: stringOrNull(row.employment_type) ?? 'full_time',
    // numeric 列经 PostgREST 回来是**字符串**（避免精度丢失）。这里统一成数字：
    // 让每个页面各自 parseFloat 是漏点，而漏点的症状是"某处金额算成 NaN"。
    hourly_rate: rate === null || rate === undefined || rate === '' || !Number.isFinite(Number(rate))
      ? null
      : Number(rate),
    hired_at: stringOrNull(row.hired_at),
    birthday: stringOrNull(row.birthday),
    emergency_contact: stringOrNull(row.emergency_contact),
    status: stringOrNull(row.status) ?? 'active',
    // is_active 是历史列（Phase 1 就在），status 是新列。两者都保留：
    // 直接删 is_active 会让既有查询（外卖派单只取 is_active 员工）静默变成
    // "取到离职员工"。这里以 status 为源同步 is_active，避免两份真相漂移。
    is_active: Boolean(row.is_active ?? true),
    user_id: userId,
    has_account: userId !== null,
    role: stringOrNull(row.role),
    photo_url: stringOrNull(row.photo_url),
    created_at: stringOrNull(row.created_at),
  };
}

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    // 读接口按仓库既有口径要求一个读权限；`workforce:manage` 是写权限，
    // 只给需要改档案的人，读名册不该顺带要求它。
    requirePermission(context, 'workforce:manage');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  const statusFilter = request.nextUrl.searchParams.get('status') ?? '';
  const client = getSupabaseClient();
  let query = client
    .from('staff')
    .select(SELECT_COLUMNS)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .order('name', { ascending: true })
    .limit(MAX_ROWS);
  if (statusFilter && (STAFF_STATUSES as readonly string[]).includes(statusFilter)) {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ staff: (data ?? []).map(mapStaff) });
}

interface StaffBody {
  name?: unknown;
  position?: unknown;
  phone?: unknown;
  email?: unknown;
  employment_type?: unknown;
  hourly_rate?: unknown;
  hired_at?: unknown;
  birthday?: unknown;
  emergency_contact?: unknown;
  status?: unknown;
  /** 关联/解绑登录账号。传 null 表示解绑。 */
  user_id?: unknown;
}

function trimmedOrNull(value: unknown, max: number): string | null | { error: string } {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return { error: 'must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return { error: `must be at most ${max} characters` };
  return trimmed;
}

/** 只接受 'YYYY-MM-DD'。date 列收到 '2026/09/10' 这类值 PostgREST 会报 400 而不是 500。 */
function dateOrNull(value: unknown, field: string): string | null | { error: string } {
  const str = trimmedOrNull(value, 10);
  if (str === null || typeof str === 'object') return str;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : { error: `${field} must be YYYY-MM-DD` };
}

function rateOrNull(value: unknown): number | null | { error: string } {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num < 0 || num > 99999999) return { error: 'hourly_rate out of range' };
  return Math.round(num * 100) / 100;
}

/**
 * 把请求体归一化成一行待写字段。
 *
 * 为什么白名单而不是直接 spread 请求体：`staff` 上有 `tenant_id` / `business_id` /
 * `user_id` / `is_active` 等归属与状态列 —— spread 等于让客户端自己决定
 * 这些行属于哪个门店。越权不一定表现为"读到别人的数据"，
 * 也可能表现为"把自己的档案写进别人的门店"。
 */
function normalizeStaffBody(body: StaffBody, requireName: boolean):
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: string } {
  const row: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = trimmedOrNull(body.name, MAX_NAME);
    if (name === null || typeof name === 'object') return { ok: false, error: 'name is required' };
    row.name = name;
  } else if (requireName) {
    return { ok: false, error: 'name is required' };
  }

  for (const [field, max] of [
    ['position', MAX_POSITION],
    ['phone', MAX_PHONE],
    ['email', MAX_EMAIL],
    ['emergency_contact', MAX_EMERGENCY_CONTACT],
  ] as const) {
    if (body[field] === undefined) continue;
    const value = trimmedOrNull(body[field], max);
    if (value !== null && typeof value === 'object') {
      return { ok: false, error: `${field} ${value.error}` };
    }
    row[field] = value;
  }

  if (body.employment_type !== undefined) {
    const value = trimmedOrNull(body.employment_type, EMPLOYMENT_TYPE_LENGTH);
    if (value === null || typeof value === 'object'
      || !(EMPLOYMENT_TYPES as readonly string[]).includes(value)) {
      return { ok: false, error: `employment_type must be one of ${EMPLOYMENT_TYPES.join(', ')}` };
    }
    row.employment_type = value;
  }

  if (body.status !== undefined) {
    const value = trimmedOrNull(body.status, STATUS_LENGTH);
    if (value === null || typeof value === 'object'
      || !(STAFF_STATUSES as readonly string[]).includes(value)) {
      return { ok: false, error: `status must be one of ${STAFF_STATUSES.join(', ')}` };
    }
    row.status = value;
    // 两份真相必须同步（见 mapStaff 的说明）。
    row.is_active = value === 'active';
  }

  if (body.hourly_rate !== undefined) {
    const rate = rateOrNull(body.hourly_rate);
    if (rate !== null && typeof rate === 'object') return { ok: false, error: rate.error };
    row.hourly_rate = rate;
  }

  for (const field of ['hired_at', 'birthday'] as const) {
    if (body[field] === undefined) continue;
    const value = dateOrNull(body[field], field);
    if (value !== null && typeof value === 'object') return { ok: false, error: value.error };
    row[field] = value;
  }

  if (body.user_id !== undefined) {
    const value = trimmedOrNull(body.user_id, 36);
    if (value !== null && typeof value === 'object') {
      return { ok: false, error: `user_id ${value.error}` };
    }
    row.user_id = value;
  }

  return { ok: true, row };
}

/**
 * 校验 `user_id` 必须是**本租户**的账号。
 *
 * 不校验的话，老板端的"关联账号"可以填另一个租户的 user id ——
 * 于是那条 staff 档案的 user_id 指向别人的账号，而
 * `resolveStaffForUser(tenant, business, userId)` 按 (tenant, business, user_id)
 * 精确匹配，看起来"关联成功"但永远解析不到；更糟的是，关怀记录的可见性规则
 * 恰好建立在 `staff.user_id = 会话 userId` 上 —— 跨租户的 user_id 会让
 * 别人写的私密记录对错误的账号可见。这是最需要堵死的一类。
 */
async function assertUserInTenant(
  tenantId: string,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (!userId) return { ok: true };
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('id')
    .eq('id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) };
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'user_id is not a member of this tenant' }, { status: 400 }),
    };
  }
  return { ok: true };
}

async function createStaff(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: StaffBody;
  try {
    body = (await request.json()) as StaffBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const normalized = normalizeStaffBody(body, true);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });

  const membership = await assertUserInTenant(
    context.tenantId,
    stringOrNull(normalized.row.user_id),
  );
  if (!membership.ok) return membership.response;

  const { data, error } = await getSupabaseClient()
    .from('staff')
    .insert({
      ...normalized.row,
      tenant_id: context.tenantId,
      business_id: context.businessId,
    })
    .select(SELECT_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, staff: mapStaff(data) }, { status: 201 });
}

async function updateStaff(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  const id = (request.nextUrl.searchParams.get('id') ?? '').trim();
  if (!id || id.length > 36) {
    return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
  }

  let body: StaffBody;
  try {
    body = (await request.json()) as StaffBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const normalized = normalizeStaffBody(body, false);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  if (Object.keys(normalized.row).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  if (normalized.row.user_id !== undefined) {
    const membership = await assertUserInTenant(
      context.tenantId,
      stringOrNull(normalized.row.user_id),
    );
    if (!membership.ok) return membership.response;
  }

  // UPDATE 链上同时带 tenant_id + business_id：仅按 id 更新意味着任何知道
  // 别店员工 id 的人都能改别店档案。过滤条件必须在 UPDATE 链上，
  // 不能"先查再改"（两者之间有竞态窗口）。
  const { data, error } = await getSupabaseClient()
    .from('staff')
    .update(normalized.row)
    .eq('id', id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .select(SELECT_COLUMNS)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'staff not found in this store' }, { status: 404 });

  return NextResponse.json({ ok: true, staff: mapStaff(data) });
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:manage', action: 'staff.create', entity: 'staff' },
  createStaff,
);

export const PATCH = protectBusinessMutation(
  { permission: 'workforce:manage', action: 'staff.update', entity: 'staff' },
  updateStaff,
);
