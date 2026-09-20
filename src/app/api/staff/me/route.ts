import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { readStaffPreference } from '@/app/api/staff/preferences/route';

/**
 * 员工端启动时调一次：我是谁、在哪家店、什么岗位、我的隐私开关是什么状态。
 *
 * 三种失败各有独立状态码（由 staffRequestContext 统一给出）：
 * 401 未登录 / 403 无权限 / **409 账号未关联员工档案**。
 * 最后一条尤其重要：这是"店长建了账号忘了建档案"的直接症状，
 * 必须让员工看到可执行的指引，而不是一片空白。
 *
 * ## 为什么必须返回 preferences（本轮修复）
 *
 * `src/lib/api.ts` 的 `StaffMeResponse` 声明了
 * `preferences.personal_data_opt_in`，`src/app/api/staff/preferences/route.ts`
 * 的文件头也写着"GET /api/staff/me 在缺省时返回 false" —— 而这个路由此前
 * 只回 staff/business/role，**根本没返回 preferences**。后果是实测到的：
 * 员工在「我的」页打开隐私开关、刷新页面后显示成**关闭**，
 * 而服务端其实记着开启（PATCH 写进 `settings.wellbeing.staff_prefs` 是成功的）。
 *
 * 客户端当时的兜底是"读不到就当 false"—— 那条兜底永远不会把关闭显示成开启，
 * 所以它是安全的；但它会把开启显示成关闭，也就是让员工以为自己被关掉了。
 * 接口缺字段是**服务端**的问题，不能靠客户端猜。
 *
 * 读语义与写入路径共用 `readStaffPreference`（唯一实现）；读失败时返回 500
 * 而不是回落 false —— 见该函数的说明。
 *
 * ## 另外两个此前缺失的字段
 *
 * `StaffMeResponse.staff` 还声明了 `position` 与 `photo_url`。
 * 它们由 `staffRequestContext`（内部 `resolveStaffForUser`）解析出来并透传，
 * 不需要在这里再查一次 staff 行。原先回的 `employee_role: null` 是**写死的
 * 空值**（没有任何数据源），已由真实的 `position` 取代。
 *
 * ## 一个**仍然存在**的缺口（本轮未修，如实记录）
 *
 * `StaffMeResponse.staff.hired_at` 是可选字段，`StaffPwa` 的 `readHiredAt`
 * 确实会读它，而本路由不返回它 —— 后果是「我的」页那一行"入职日期"永远不显示。
 * 它**有**数据源（`staff.hired_at` 列，迁移已落地，实测可查），缺的只是把它
 * 从 `resolveStaffForUser` 一路透传出来。本轮的任务范围只点名了 position 与
 * photo_url，所以这里不顺手扩大改动 —— 但要写清楚它还在，别让下一个人
 * 以为"类型里有就一定回"。
 */
export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, staffId, role, staffName, staffPosition, staffPhotoUrl, staffHiredAt } =
    resolved.ctx;

  const { data: business, error } = await getSupabaseClient()
    .from('businesses')
    .select('id, name, currency')
    .eq('tenant_id', tenantId)
    .eq('id', businessId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'business lookup failed' }, { status: 500 });

  let preferences: { personal_data_opt_in: boolean };
  try {
    preferences = await readStaffPreference(tenantId, businessId, staffId);
  } catch (error) {
    // 读不到偏好**不能**回落成 false：库不可用时回 false，等于告诉员工
    // "你的开关是关的"，而真相是"不知道"。宁可让页面显示一条明确的失败。
    console.error(
      '[staff/me] preference read failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'could not read preferences' }, { status: 500 });
  }

  return NextResponse.json({
    staff: {
      id: staffId,
      name: staffName,
      // 类型上 position 是 string（不可空），而库里可以为空 —— 空串在 UI 里
      // 与"没填"同义（`employeeRole && ...` 不渲染），不编造一个默认岗位名。
      position: staffPosition ?? '',
      photo_url: staffPhotoUrl,
      // 本轮补：`hired_at` 此前被类型声明、被 `StaffPwa.readHiredAt` 读取，
      // 却没有任何一处透传出来 —— "入职日期"那一行永远不渲染，且不报错。
      // 与 position 取错列同类：不报错的错最难发现。
      // 没有值就是 null，不编造日期。
      hired_at: staffHiredAt,
    },
    business: {
      id: businessId,
      name: String((business as { name?: string } | null)?.name ?? ''),
    },
    role,
    preferences,
  });
}
