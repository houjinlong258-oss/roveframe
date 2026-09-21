import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import {
  ALWAYS_AVAILABLE_STAFF_ENDPOINTS,
  STAFF_FEATURES,
  readStaffAccess,
  writeStaffAccess,
} from '@/lib/staff-access';

/**
 * 老板侧的「员工端开放哪些功能」开关（读写）。
 *
 * ## 与员工端严格分开
 *
 *   /api/team/staff-access  —— 老板/店长读写**本店**的功能开关（workforce:manage）
 *   /api/staff/*            —— 员工端**消费**这些开关（被关掉时拿 403 feature_disabled）
 * 员工端没有任何写入口，也读不到"别家店开了什么"：写权限在权限矩阵里
 * （src/lib/rbac.ts 的 workforce:manage），本文件只负责把它接到 settings 那一格上。
 *
 * ## 读接口也要求 workforce:manage
 *
 * 开关本身不是敏感数据，但它描述的是"这家店怎么管人"。用与写接口**同一个**权限，
 * 是为了避免出现"能看不能改"的中间态 —— 那种中间态只会让人以为自己的修改没生效。
 *
 * ## 租户与门店只从会话解析
 *
 * 与 /api/team/route.ts 同一口径：`requireBusinessContext(await getTenantContext(request))`，
 * 客户端传来的任何 tenant/business 字段都不参与判定。
 */
export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'workforce:manage');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  let access;
  try {
    access = await readStaffAccess(context.tenantId, context.businessId);
  } catch (error) {
    console.error(
      '[team/staff-access] settings read failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'could not read the staff access settings' }, { status: 500 });
  }

  return NextResponse.json({
    // 三个键齐全（缺键已由 normalizeStaffAccess 补成默认值），UI 不需要再兜底。
    staff_access: access,
    features: [...STAFF_FEATURES],
    // 明确告诉 UI 哪些接口**不受**这些开关影响：老板界面上要写一行说明，
    // 否则老板会以为关掉开关就能连员工的考勤与数据导出一起关掉。
    always_available: [...ALWAYS_AVAILABLE_STAFF_ENDPOINTS],
  });
}

async function updateStaffAccess(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // 未知键 / 非布尔值一律 400，不做宽松解析：一次静默的 `care: 'false'`
  // （字符串）在宽松解析下会变成"开"，而这是隐私面的开关。
  const result = await writeStaffAccess(context.tenantId, context.businessId, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, staff_access: result.access });
}

export const PATCH = protectBusinessMutation(
  { permission: 'workforce:manage', action: 'staff.access.update', entity: 'settings' },
  updateStaffAccess,
);
