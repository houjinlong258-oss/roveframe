import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 商家侧「员工端开放哪些功能」的开关（老板可配）。
 *
 * ===========================================================================
 * 这里有**两条互不相干的轴**，混在一起就会出事故。改本文件之前先读完这一段。
 * ===========================================================================
 *
 *   1. **RBAC**（src/lib/rbac.ts，固定不可改）回答："这个角色**允许**做什么"。
 *      它是安全边界，缺权限一律 403。
 *   2. **商家偏好**（本文件）回答："在角色允许的范围内，这家店**愿意开放**哪些"。
 *      它是产品偏好，不是安全边界。
 *
 * 因此本文件**永远不会**把 RBAC 允许的事变成禁止 —— 它只在 RBAC 已经放行的
 * 前提下，再去掉商家明确关掉的那几个面。
 *
 * ---------------------------------------------------------------------------
 * 一、不可关闭的员工自身权利（**必须**永远可用）
 * ---------------------------------------------------------------------------
 *
 * 下面这些**不在** `STAFF_FEATURES` 里，路由里也**不得**调用本模块的判定：
 *
 *   · `/api/staff/me`        —— 我是谁、我在哪家店
 *   · `/api/staff/attendance`—— 我自己的打卡与考勤
 *   · `/api/staff/shifts`    —— 我自己的排班
 *   · `/api/staff/export`    —— 我自己的数据导出
 *   · `/api/staff/preferences` —— 我自己的隐私开关
 *
 * **为什么它们不可关闭**：这些不是"商家提供的功能"，而是**员工本人的数据权利**。
 * 员工能不能看到自己的考勤、能不能导出自己的数据、能不能关掉个性化信息记录，
 * 属于劳动法与隐私合规层面的义务（GDPR 第 15/20 条一类），不是老板的产品选项。
 * 把它做成开关，等于让商家可以一键关掉员工查看自己工资工时的通道 ——
 * 那是把合规义务降级成营销偏好。
 *
 * tests/staff-access.test.ts 用**源码级**断言守住这条：那几个路由文件里
 * 不许出现本模块的任何判定调用，并配了"确实违规"的合成反例。
 *
 * ---------------------------------------------------------------------------
 * 二、可开关的功能（真属于商家的选择）
 * ---------------------------------------------------------------------------
 *
 *   · delivery     —— 外卖派单（认领 / 推进）。不做外卖的店不该看到这个 Tab。
 *   · reservations —— 员工端确认预订。
 *   · care         —— 员工关怀转介清单。
 *
 * ---------------------------------------------------------------------------
 * 三、默认值：**这里刻意不是 fail-closed**，理由必须写清楚
 * ---------------------------------------------------------------------------
 *
 * 缺键（所有既有安装都是这样）时给 `delivery: true, reservations: true`，
 * `care: false`。两个不同的默认值，各自有理由：
 *
 *   · delivery / reservations 默认**开**：它们是门店的**日常运营动作**。
 *     本模块的读失败/缺键如果按 fail-closed 处理，一次部署（老库里没有这个键）
 *     就会让全店员工点不了"接单"、确认不了预订，而且**没有任何报错提示**——
 *     员工只会看到一片空白。这个键是产品偏好，**安全边界是 RBAC**：
 *     关掉它不会让越权发生，只会让门店停摆。所以这里借"缺即默认开"。
 *   · care 默认**关**：把雇主提供的心理健康转介项目推到员工面前，是商家要
 *     主动做的决定（涉及雇主与员工的信任关系），不是"没配置就等于开了"。
 *
 * **非法值一律回落到默认值，绝不回落成 true**：`'true'`（字符串）/ 1 / null /
 * 缺字段全部按默认处理，`care` 的任何垃圾值都只会是 false。宽松解析会让
 * "关"变成"开"，而那正是隐私开关最不能出的错（同
 * src/app/api/staff/preferences/route.ts 的 readOptIn 口径）。
 *
 * ---------------------------------------------------------------------------
 * 四、存哪里，以及为什么不是它"本该"在的那一列
 * ---------------------------------------------------------------------------
 *
 * 实测（PostgREST 只读探测 `settings?select=*`，本机 2026 执行）：
 * `settings` 表的列是 id / tenant_id / business_id / business / locale /
 * ai_prefs / model_assign / delivery / wellbeing / updated_at ——
 * **没有 `staff_access` 这一列**。而本仓库当前的 DDL 通道不可用
 * （无 DB 口令、无 SUPABASE_ACCESS_TOKEN → autoMigrate 只会返回 method=none），
 * 任务口径同时要求"不加迁移"。
 *
 * 所以这个键只能寄存在**已有的** jsonb 列里。可选的四列里：
 *   · business / locale / ai_prefs —— 被 `/api/settings` 的 PUT **整列替换**
 *     （见 src/app/api/settings/route.ts 的 patch 组装），兄弟键会被下一次
 *     "保存设置"静默抹掉；
 *   · delivery —— 被 `/api/team/delivery` 的 PATCH 整块替换（`{...normalized}`），
 *     同样会抹掉兄弟键；
 *   · wellbeing —— 目前只有 `/api/staff/preferences` 一处写入，且它是
 *     读-合并-写（`{...wellbeing, staff_prefs: {...}}`），兄弟键被显式保留。
 *
 * 因此键落在 `settings.wellbeing.staff_access`，并且本文件的写入路径严格照
 * 那个路由的做法：只合并 `staff_access` 一格，`staff_prefs` 与其他兄弟键原样带回。
 * 这是**借用**，不是语义归属 —— 挪到独立列时请一并删除这段说明。
 */

/** 可开关的功能。顺序即 UI 顺序。 */
export const STAFF_FEATURES = ['delivery', 'reservations', 'care'] as const;

export type StaffFeature = (typeof STAFF_FEATURES)[number];

export type StaffAccess = Record<StaffFeature, boolean>;

/**
 * 缺键 / 非法值时的落点。
 * 见文件头第三节：运营必需项默认开，关怀默认关。
 */
export const DEFAULT_STAFF_ACCESS: StaffAccess = {
  delivery: true,
  reservations: true,
  care: false,
};

/**
 * 永远可用、**不参与**开关判定的员工端接口。
 * 这份清单是给测试与老板端 UI 看的"说明"，不是运行时判定表 ——
 * 运行时的保证来自"那几个路由里根本不调用本模块"。
 */
export const ALWAYS_AVAILABLE_STAFF_ENDPOINTS: readonly string[] = [
  '/api/staff/me',
  '/api/staff/attendance',
  '/api/staff/shifts',
  '/api/staff/export',
  '/api/staff/preferences',
];

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

/** 只认 boolean。字符串 'true' / 1 / null 一律返回 null（= 没给值）。 */
function readFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 把 jsonb 里挖出来的任意东西收敛成一份完整的 `StaffAccess`。
 *
 * 永远返回**三个键齐全**的对象：缺的键取默认值，非法值取默认值。
 * 调用方因此不需要再写 `?? true` 之类的兜底 —— 那种散落各处的兜底
 * 就是"某处默认开、某处默认关"漂移的来源。
 */
export function normalizeStaffAccess(raw: unknown): StaffAccess {
  const record = asRecord(raw);
  const result = { ...DEFAULT_STAFF_ACCESS };
  for (const feature of STAFF_FEATURES) {
    const flag = readFlag(record[feature]);
    if (flag !== null) result[feature] = flag;
  }
  return result;
}

/** settings 行里本模块用得到的部分。 */
export interface StaffAccessSettingsRow {
  id: string;
  wellbeing: unknown;
}

/**
 * 读 settings 行的形态。
 *
 * 做成可注入的参数（与 src/app/api/staff/preferences/route.ts 的
 * `StaffSettingsRowLoader` 同一形态），是为了让"缺 settings 行 / 缺
 * wellbeing / 缺 staff_access 这一格 / 值是垃圾"这四条**必须回落到默认值**的
 * 路径可以被独立验证：settings 是全店共用的单行，测试不可能为了造场景去删它。
 */
export type StaffAccessRowLoader = (
  tenantId: string,
  businessId: string,
) => Promise<StaffAccessSettingsRow | null>;

/**
 * 真实实现：按 (tenant_id, business_id) 取那一行 settings。
 *
 * 读失败**抛错**，不返回 null。null 的含义是"这个门店还没有 settings 行"
 * （= 用默认值，是合法的缺省状态），而读失败是"不知道"；把两者混同，
 * 判定就会在库不可用时谎报"商家关掉了外卖"。
 */
export async function loadStaffAccessRow(
  tenantId: string,
  businessId: string,
): Promise<StaffAccessSettingsRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('settings')
    .select('id, wellbeing')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw new Error(`settings read failed: ${error.message}`);
  return (data as StaffAccessSettingsRow | null) ?? null;
}

/** 从 wellbeing 里挖出 `staff_access` 那一格。读语义的唯一实现。 */
export function staffAccessSlice(wellbeing: unknown): {
  wellbeing: Record<string, unknown>;
  staffAccess: StaffAccess;
} {
  const wellbeingRecord = asRecord(wellbeing);
  return {
    wellbeing: wellbeingRecord,
    staffAccess: normalizeStaffAccess(wellbeingRecord.staff_access),
  };
}

/**
 * 读某门店的功能开关。**唯一读取入口**。
 *
 * 第四个参数只在测试里传（见 `StaffAccessRowLoader`），生产调用方一律不传。
 */
export async function readStaffAccess(
  tenantId: string,
  businessId: string,
  loadRow: StaffAccessRowLoader = loadStaffAccessRow,
): Promise<StaffAccess> {
  const row = await loadRow(tenantId, businessId);
  return staffAccessSlice(row?.wellbeing).staffAccess;
}

/** 单个功能的判定。route 里若只判一个功能，用它比读整份更直白。 */
export async function isStaffFeatureEnabled(
  tenantId: string,
  businessId: string,
  feature: StaffFeature,
  loadRow: StaffAccessRowLoader = loadStaffAccessRow,
): Promise<boolean> {
  const access = await readStaffAccess(tenantId, businessId, loadRow);
  return access[feature];
}

/**
 * 关掉某个功能时的**唯一**响应形态。
 *
 * 为什么是 403 + `code` 而不是 404、也不是"200 + 空列表"：
 *   · 404 会让员工端把"商家关掉了外卖"显示成"这单不存在"，去刷新一个
 *     永远不会出现的列表；
 *   · 空列表更糟 —— 员工无法区分"今天没有单"与"这个功能被关了"，
 *     会一直等下去；
 *   · 只有明确的 403 + `feature_disabled` 才能让 UI 说出人话
 *     （"这家店没有开启外卖派单"）。这正是"没有静默降级"那条纪律。
 */
export function featureDisabledResponse(feature: StaffFeature): NextResponse {
  return NextResponse.json(
    {
      error: 'this feature is turned off for this store',
      code: 'feature_disabled',
      feature,
    },
    { status: 403 },
  );
}

/**
 * 路由用的判定入口：返回 null = 放行；返回 Response = 直接 `return` 出去。
 *
 * 用法：
 *   const gate = await requireStaffFeature(tenantId, businessId, 'delivery');
 *   if (gate) return gate;
 *
 * 读失败返回 **500 + feature_check_failed**，既不猜"开着"也不猜"关着"：
 * 猜开着会违反商家的设置，猜关着会让门店在库抖动时停摆，而两者都不留痕迹。
 * 500 是唯一能让这条故障可见的答案。
 */
export async function requireStaffFeature(
  tenantId: string,
  businessId: string,
  feature: StaffFeature,
): Promise<NextResponse | null> {
  let access: StaffAccess;
  try {
    access = await readStaffAccess(tenantId, businessId);
  } catch (error) {
    console.error(
      '[staff-access] settings read failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: 'could not read the store feature settings', code: 'feature_check_failed' },
      { status: 500 },
    );
  }
  if (access[feature]) return null;
  return featureDisabledResponse(feature);
}

export type WriteStaffAccessResult =
  | { ok: true; access: StaffAccess }
  | { ok: false; error: string };

/**
 * 老板端保存开关。只合并 `staff_access` 一格。
 *
 * `patch` 里只允许出现 `STAFF_FEATURES` 里的键且必须是 boolean —— 校验放在这里
 * 而不是只放路由里，是因为将来第二个写入口（比如老板端 PWA）不该有机会绕过它。
 * 未出现的键**保持当前值**（PATCH 语义），不回落默认值：默认值只在"从来没配过"时生效，
 * 一旦商家显式配过，改一个开关不该把另一个悄悄重置。
 */
export async function writeStaffAccess(
  tenantId: string,
  businessId: string,
  patch: Record<string, unknown>,
): Promise<WriteStaffAccessResult> {
  const next: Partial<StaffAccess> = {};
  for (const key of Object.keys(patch)) {
    if (!(STAFF_FEATURES as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown feature: ${key}` };
    }
    const flag = readFlag(patch[key]);
    if (flag === null) return { ok: false, error: `${key} must be a boolean` };
    next[key as StaffFeature] = flag;
  }
  if (Object.keys(next).length === 0) {
    return { ok: false, error: 'nothing to update' };
  }

  const client = getSupabaseClient();
  const row = await loadStaffAccessRow(tenantId, businessId);
  const { wellbeing } = staffAccessSlice(row?.wellbeing);

  // 只替换 staff_access 这一格：staff_prefs（其他员工的隐私开关）与 wellbeing 的
  // 其他配置项必须原样带回，否则"老板保存开关"会顺手抹掉员工的隐私设置 ——
  // 那是最不该由这个接口造成的副作用。
  const nextWellbeing = {
    ...wellbeing,
    staff_access: { ...normalizeStaffAccess(wellbeing.staff_access), ...next },
  };

  if (row?.id) {
    const { error } = await client
      .from('settings')
      .update({ wellbeing: nextWellbeing, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      // 双条件不是冗余：settings 的唯一键是 (tenant_id, business_id)，
      // 带上它们可以保证这条 update 绝不可能写到别的门店那一行。
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId);
    if (error) return { ok: false, error: `settings update failed: ${error.message}` };
  } else {
    // 门店还没有 settings 行：插入而不是静默成功。
    // 静默成功会让老板以为开关保存了，下次打开又回到默认值。
    const { error } = await client
      .from('settings')
      .insert({ tenant_id: tenantId, business_id: businessId, wellbeing: nextWellbeing });
    if (error) return { ok: false, error: `settings insert failed: ${error.message}` };
  }

  return { ok: true, access: normalizeStaffAccess(nextWellbeing.staff_access) };
}
