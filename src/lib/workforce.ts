import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';

/**
 * 员工身份的解析（Phase 18 / P18-1）。
 *
 * ## 为什么需要这个文件
 *
 * `users`（登录账号）与 `staff`（员工档案）此前**没有任何字段相连**
 * （见 scripts/migrate-staff-identity.sql 的说明）。员工端每一个接口都需要回答
 * 同一个问题：「当前会话对应哪条员工记录」。把答案写在一处，而不是让每个路由
 * 各自查一次 —— 各自查就会各自漂移。
 *
 * ## 为什么查不到要 409 而不是返回空
 *
 * "账号有效但没有员工档案"是配置错误里最常见的一种（店长建了账号忘了建档案，
 * 或档案建在另一个门店）。返回 200 + 空对象会让员工端显示一片空白，
 * 而真正的原因永远不会暴露 —— 这正是仓库里已经记录过的那类"错误语义丢失"。
 */

export interface StaffIdentity {
  staffId: string;
  name: string;
  /**
   * 岗位。取 `staff.position` —— 老板端「员工目录」编辑的就是这一列
   * （见 src/app/api/team/route.ts 的 SELECT_COLUMNS）。
   *
   * 为什么不是直接取 `staff.role`：`role` 是 Phase 1 留下的旧列，
   * 而员工端要把这个值显示给**员工本人**看。取错列的后果不是报错，
   * 是员工看到一个与店长填的不同的岗位名（或者一片空白），
   * 而接口照样 200 —— 这种"不报错的错"最难被发现。
   * 旧数据里只有 role 有值的行仍然回落到 role，不丢信息。
   */
  position: string | null;
  photoUrl: string | null;
  /**
   * 入职日期，`YYYY-MM-DD`。
   *
   * `StaffMeResponse.staff.hired_at` 声明了它、`StaffPwa.readHiredAt` 也读它，
   * 但此前没有任何一处把它透传出来 —— 结果是"入职日期"那一行**永远不渲染**，
   * 而且不报错。这是与 `position` 取错列同类的问题：不报错的错最难发现。
   *
   * pg 对 `date` 列返回 Date 对象，直接塞进 JSON 会变成带时区的 ISO 串，
   * 前端按 `YYYY-MM-DD` 渲染时会多出一截。因此这里统一裁成日期部分。
   */
  hiredAt: string | null;
  isActive: boolean;
}

/** `date` 列 → `YYYY-MM-DD`；空值与非法值都返回 null，不编造日期。 */
function toDateOnly(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

export type StaffResolveResult =
  | { ok: true; staff: StaffIdentity }
  | { ok: false; reason: 'not_linked' | 'inactive' | 'error'; message?: string };

export async function resolveStaffForUser(
  tenantId: string,
  businessId: string,
  userId: string,
): Promise<StaffResolveResult> {
  const { data, error } = await getSupabaseClient()
    .from('staff')
    .select('id, name, role, position, photo_url, hired_at, is_active')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: error.message };
  if (!data) return { ok: false, reason: 'not_linked' };

  const row = data as {
    id: string; name: string; role: string | null; position: string | null;
    photo_url: string | null; hired_at: unknown; is_active: boolean;
  };
  if (row.is_active === false) return { ok: false, reason: 'inactive' };

  return {
    ok: true,
    staff: {
      staffId: row.id,
      name: row.name,
      // position 优先（老板端填的那一列），空值或纯空白时回落 role（旧列）。
      // 用 `||` 而不是 `??`：空字符串在这里等价于"没填"，落到 role 才是对的。
      position: (row.position && row.position.trim()) || (row.role && row.role.trim()) || null,
      photoUrl: row.photo_url,
      hiredAt: toDateOnly(row.hired_at),
      isActive: true,
    },
  };
}

export interface StaffRequestContext {
  tenantId: string;
  businessId: string;
  userId: string;
  staffId: string;
  staffName: string;
  /**
   * 岗位（与 `StaffIdentity.position` 同一来源）。
   *
   * 为什么放在这里而不是让 /api/staff/me 与 /api/staff/export 各自再查一次
   * staff 行：同一个值的两处查询就是两处漂移点 —— 一处按 position 取、
   * 另一处按 role 取，员工在"我的"页和导出的 JSON 里会看到两个岗位名，
   * 而两边都不会报错。
   */
  staffPosition: string | null;
  /** 头像 URL。没有就是 null —— 不编造占位图。 */
  staffPhotoUrl: string | null;
  /** 入职日期 `YYYY-MM-DD`。没有就是 null —— 不编造日期。 */
  staffHiredAt: string | null;
  /** 供路由做**第二个**权限判定（例如认领外卖单还要 delivery:claim）。 */
  role: string;
}

/**
 * 员工端路由的统一入口：会话 → 权限 → 员工档案，一次做完。
 *
 * 三个失败各自有独立状态码，因为它们的 UI 处置完全不同：
 *   401 未登录      → 跳员工登录页
 *   403 无权限      → 提示无权限（**不要**跳登录，会让人以为自己没登录）
 *   409 未关联档案  → 提示"请联系店长关联员工档案"
 * 把三者压成一个 401 是这个项目已经记录过的错误语义丢失。
 *
 * 失败时直接返回 `response`，调用方 `if (!ctx.ok) return ctx.response;` 即可。
 */
export async function staffRequestContext(
  request: NextRequest,
): Promise<{ ok: true; ctx: StaffRequestContext } | { ok: false; response: NextResponse }> {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return {
      ok: false,
      response: NextResponse.json(
        { error: status === 403 ? 'forbidden' : 'unauthorized' },
        { status },
      ),
    };
  }

  try {
    requirePermission(context, 'workforce:self');
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }

  const resolved = await resolveStaffForUser(context.tenantId, context.businessId, context.userId);
  if (!resolved.ok) {
    if (resolved.reason === 'error') {
      return {
        ok: false,
        response: NextResponse.json({ error: 'staff lookup failed' }, { status: 500 }),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: resolved.reason === 'inactive'
            ? 'your staff profile is no longer active'
            : 'your account is not linked to a staff profile',
          code: resolved.reason === 'inactive' ? 'staff_inactive' : 'staff_not_linked',
        },
        { status: 409 },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      tenantId: context.tenantId,
      businessId: context.businessId,
      userId: context.userId,
      staffId: resolved.staff.staffId,
      staffName: resolved.staff.name,
      staffPosition: resolved.staff.position,
      staffPhotoUrl: resolved.staff.photoUrl,
      staffHiredAt: resolved.staff.hiredAt,
      role: context.role,
    },
  };
}
