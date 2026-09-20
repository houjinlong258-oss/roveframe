import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { staffRequestContext } from '@/lib/workforce';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * 员工个人的隐私开关：「允许记录我的生日等个性化信息」。
 *
 * ## 为什么直接读写 settings 行，而不是走 src/lib/settings.ts
 *
 * `settings.wellbeing` 是一个 jsonb 列，由 scripts/migrate-workforce-care.sql 创建。
 * （订正：本文件初版注释写着"该列在库里已经存在" —— 那是错的，实测
 * scripts/_probe_p18_state.mts 对真实库显示它不存在，且当时没有迁移创建它。
 * 补列与订正一并落在这一轮。）
 * 它没有写进 `AppSettings` 接口（src/lib/settings.ts），因为那个文件由另一位同事负责。
 * 为了让本次改动不产生跨文件的隐性耦合，这里直接读写 settings 行。
 *
 * 直接读写有一个必须自己负责的后果：**settings 是单行 jsonb**，
 * 除了 wellbeing 还有 business / locale / ai_prefs / model_assign / delivery。
 * 因此本路由：
 *   · 只 update `wellbeing` 一列（绝不整行 upsert，那会覆盖别人的设置）；
 *   · 在应用层做"读—合并—写"，并把合并范围严格限制在
 *     `wellbeing.staff_prefs[staffId]`，其余兄弟键原样保留。
 *
 * ## 为什么按员工分片存
 *
 * 开关是**个人的**，不是门店的。若把 personal_data_opt_in 放在 wellbeing 顶层，
 * 一个员工改开关就会改掉全店 —— 那是最典型的隐私事故：有人以为自己关掉了
 * 生日记录，实际被同事的点击重新打开。分片键用会话解析出的 staff id，
 * 客户端无法指定"帮我改别人的偏好"。
 *
 * 结构：`{ staff_prefs: { [staffId]: { personal_data_opt_in: boolean } } }`
 *
 * ## 读语义只有一处实现（本轮修复）
 *
 * 这个开关有**两个**读取方：员工端启动时调的 `GET /api/staff/me`（回显开关状态）
 * 与本文件的 PATCH（读—合并—写）。两处各写一遍"怎么从 jsonb 里把这一格挖出来"，
 * 就是漂移的起点：改了其中一处，另一处会继续按旧形状解析，而症状是
 * **刷新后开关显示成关闭、服务端其实记着开启**（本轮修的正是这个 bug：
 * 在本次修复之前 `/api/staff/me` 根本不返回 preferences）。
 * 因此：jsonb 导航统一走 `staffPreferenceSlice`，读整行统一走 `loadStaffSettingsRow`，
 * 对外的读取入口统一是 `readStaffPreference`。
 */

/**
 * 只接受布尔值。字符串 'true' / 1 一律拒绝 —— 宽松解析会让"关"变成"开"。
 *
 * 这里刻意不写一个"默认值"常量：默认值（缺即关闭）由 `staffPreferenceSlice`
 * 一处给出，多了第二处定义就会漂移。
 */
function readOptIn(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 把 jsonb 读成普通对象；数组/null/标量都收敛为空对象。 */
function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

/** settings 行里本模块用得到的部分。 */
export interface StaffSettingsRow {
  id: string;
  wellbeing: unknown;
}

/**
 * 读 settings 行的形态。
 *
 * 做成可注入的参数，是为了让"缺 settings 行 / 缺 wellbeing / 缺员工那一格"
 * 这三条**必须返回关闭**的路径可被独立验证：settings 是**全店共用的单行**，
 * 测试不可能为了造场景去删它（那会破坏其他用例）。与
 * `src/lib/audit.ts` 的 `_setAuditSinkForTest` 是同一形态的测试缝。
 */
export type StaffSettingsRowLoader = (
  tenantId: string,
  businessId: string,
) => Promise<StaffSettingsRow | null>;

/**
 * 真实实现：按 (tenant_id, business_id) 取那一行 settings。
 *
 * 读失败**抛错**，不返回 null。null 的含义是"这个门店还没有 settings 行"
 * （= 开关关闭，是合法的缺省状态），而读失败是"不知道"；把两者混同，
 * `/api/staff/me` 就会在库不可用时谎报"已关闭" —— 那正是本轮要修的谎报。
 */
export async function loadStaffSettingsRow(
  tenantId: string,
  businessId: string,
): Promise<StaffSettingsRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('settings')
    .select('id, wellbeing')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw new Error(`settings read failed: ${error.message}`);
  return (data as StaffSettingsRow | null) ?? null;
}

/** 一个员工自己的偏好切片。 */
export interface StaffPreferenceSlice {
  /** wellbeing 整棵对象 —— 写入路径要原样带回兄弟键。 */
  wellbeing: Record<string, unknown>;
  /** wellbeing.staff_prefs —— 同上（其他员工的偏好不能被我这一笔写丢）。 */
  staffPrefs: Record<string, unknown>;
  /** staff_prefs[staffId]：这一格不存在就是 {}，不是 undefined。 */
  ownPrefs: Record<string, unknown>;
  /** 是否**显式**开启。 */
  personal_data_opt_in: boolean;
}

/**
 * `settings.wellbeing` → 某个员工自己的偏好切片。**读语义的唯一实现**。
 *
 * 缺任何一层都是关闭：这是隐私默认（Frontend Spec §5.7「默认关闭，由员工本人开启」），
 * 所以这里 fail-closed —— 读不到就是"没同意"，绝不是"大概同意了吧"。
 */
export function staffPreferenceSlice(wellbeing: unknown, staffId: string): StaffPreferenceSlice {
  const wellbeingRecord = asRecord(wellbeing);
  const staffPrefs = asRecord(wellbeingRecord.staff_prefs);
  const ownPrefs = asRecord(staffPrefs[staffId]);
  return {
    wellbeing: wellbeingRecord,
    staffPrefs,
    ownPrefs,
    // readOptIn 只认 boolean：'true' / 1 / null / undefined 全部落回 false。
    personal_data_opt_in: readOptIn(ownPrefs.personal_data_opt_in) === true,
  };
}

/**
 * 读取某个员工本人的隐私开关。`GET /api/staff/me` 用它回显开关状态。
 *
 * 缺 settings 行 / 缺 wellbeing / 缺 staff_prefs 里那一格 → `{ personal_data_opt_in: false }`。
 * 但**库读失败会抛错**，调用方必须把它变成 500：那不是"缺"，是"不知道"，
 * 回落成 false 就是这条 bug 最初的样子（服务端记着开启、客户端显示关闭）。
 *
 * 第四个参数只在测试里传（见 `StaffSettingsRowLoader`），生产调用方一律不传。
 */
export async function readStaffPreference(
  tenantId: string,
  businessId: string,
  staffId: string,
  loadRow: StaffSettingsRowLoader = loadStaffSettingsRow,
): Promise<{ personal_data_opt_in: boolean }> {
  const row = await loadRow(tenantId, businessId);
  return {
    personal_data_opt_in: staffPreferenceSlice(row?.wellbeing, staffId).personal_data_opt_in,
  };
}

async function preferencesHandler(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;
  const { tenantId, businessId, staffId } = resolved.ctx;

  let body: { personal_data_opt_in?: unknown };
  try {
    body = (await request.json()) as { personal_data_opt_in?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const optIn = readOptIn(body.personal_data_opt_in);
  if (optIn === null) {
    return NextResponse.json(
      { error: 'personal_data_opt_in must be a boolean', code: 'invalid_body' },
      { status: 400 },
    );
  }

  const client = getSupabaseClient();

  let row: StaffSettingsRow | null;
  try {
    row = await loadStaffSettingsRow(tenantId, businessId);
  } catch (error) {
    console.error(
      '[staff/preferences] settings read failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'could not read preferences' }, { status: 500 });
  }

  // 与 /api/staff/me 共用同一份读语义：写入时"要保留哪些兄弟键"的判断，
  // 与读取时"从哪一层取值"的判断，必须出自同一处（见文件头）。
  const { wellbeing, staffPrefs, ownPrefs } = staffPreferenceSlice(row?.wellbeing, staffId);

  // 只替换自己那一格，兄弟键（含其他员工的偏好、wellbeing 的其他配置项）原样带回。
  const nextWellbeing = {
    ...wellbeing,
    staff_prefs: {
      ...staffPrefs,
      [staffId]: { ...ownPrefs, personal_data_opt_in: optIn },
    },
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
    if (error) {
      console.error('[staff/preferences] settings update failed:', error.message);
      return NextResponse.json({ error: 'could not save preferences' }, { status: 500 });
    }
  } else {
    // 门店还没有 settings 行：插入而不是静默成功。
    // 静默成功会让员工以为开关已保存，下次登录又回到默认值。
    const { error } = await client
      .from('settings')
      .insert({ tenant_id: tenantId, business_id: businessId, wellbeing: nextWellbeing });
    if (error) {
      console.error('[staff/preferences] settings insert failed:', error.message);
      return NextResponse.json({ error: 'could not save preferences' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, preferences: { personal_data_opt_in: optIn } });
}

export const PATCH = protectBusinessMutation(
  { permission: 'workforce:self', action: 'workforce.preferences', entity: 'settings' },
  preferencesHandler,
);
