/**
 * 员工数据权利（/api/staff/me 的 preferences + /api/staff/export）—— 只读探测。
 *
 * 为什么改代码之前要先跑它：本轮要动两处**共享**读取路径
 *   1. `readStaffPreference` 从 `settings.wellbeing` 里读 —— 若列不存在，
 *      每个员工看到的开关都会变成"读取失败"，而那不是我们想引入的状态。
 *   2. `/api/staff/export` 要一次 select 出 staff 的 11 个档案列 —— 
 *      其中任何一列不存在，PostgREST 会整条查询报错（不是只少一列）。
 * 所以"列存在"必须是**实测**结论，不能靠迁移文件推断。
 *
 * 全部只读，零写入。每个探测都带阴性对照，证明探针**能失败**（本项目规矩：
 * 没有负向对照的"0 命中"可能只是探针写歪了）。
 *
 * 用法：npx tsx scripts/_probe_staff_data_rights.mts
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

interface Query extends PromiseLike<Res> {
  eq(column: string, value: unknown): Query;
  limit(n: number): Query;
  order(column: string, opts: { ascending: boolean }): Query;
}

const client = getSupabaseClient() as { from(table: string): { select(columns: string): Query } };

const ANCHOR_TENANT = '00000000-0000-0000-0000-000000000000';
const ANCHOR_BUSINESS = '00000000-0000-0000-0000-000000000001';

/** 导出接口需要的 staff 档案列（逐字对应 /api/staff/export 的 staff 块）。 */
const STAFF_EXPORT_COLUMNS = [
  'id', 'name', 'position', 'photo_url', 'phone', 'email',
  'employment_type', 'hired_at', 'birthday', 'status', 'role',
] as const;

function line(s = ''): void { console.log(s); }

async function main(): Promise<number> {
  line('='.repeat(88));
  line('staff data rights 取证（只读，零写入）');
  line('='.repeat(88));
  line('');

  // ---- 0. 阴性对照：证明"列投影探针"能失败 ------------------------------
  line('[0] 探针有效性（阴性对照）');
  const badTable = await client.from('zzz_definitely_not_a_table_9f3a').select('id').limit(1);
  line(`    不存在的表           -> ${badTable.error ? `ERROR(${badTable.error.message.slice(0, 48)})` : `${(badTable.data ?? []).length} 行`}`);
  const badColumn = await client.from('staff').select('id, zzz_not_a_column_9f3a').limit(1);
  line(`    不存在的列           -> ${badColumn.error ? `ERROR(${badColumn.error.message.slice(0, 48)})` : `${(badColumn.data ?? []).length} 行`}`);
  const probeCanFail = Boolean(badTable.error) && Boolean(badColumn.error);
  line(`    探针可失败: ${probeCanFail ? '是' : '否 —— 以下结论一律作废'}`);
  line('');

  // ---- 1. staff 档案列 ---------------------------------------------------
  line('[1] staff 档案列（/api/staff/export 的 staff 块需要它们同时存在）');
  const staffRes = await client.from('staff').select(STAFF_EXPORT_COLUMNS.join(', ')).limit(3);
  if (staffRes.error) {
    line(`    ERROR: ${staffRes.error.message}`);
    line('    => 导出接口不能按这份列清单取数（先补迁移，再改路由）');
  } else {
    line(`    OK，返回 ${(staffRes.data ?? []).length} 行`);
    for (const raw of staffRes.data ?? []) {
      const row = raw as Row;
      line(`      id=${String(row.id).slice(0, 8)}… position=${JSON.stringify(row.position)} role=${JSON.stringify(row.role)} status=${JSON.stringify(row.status)}`);
    }
  }
  line('');

  // ---- 2. settings.wellbeing --------------------------------------------
  line('[2] settings 行与 wellbeing 列（readStaffPreference 的唯一数据源）');
  const settingsRes = await client.from('settings').select('id, wellbeing').eq('tenant_id', ANCHOR_TENANT).eq('business_id', ANCHOR_BUSINESS).limit(1);
  if (settingsRes.error) {
    line(`    ERROR: ${settingsRes.error.message}`);
  } else if ((settingsRes.data ?? []).length === 0) {
    line('    没有 settings 行 —— 这正是 readStaffPreference 必须返回 false 的那条路径');
  } else {
    const row = (settingsRes.data ?? [])[0] as Row;
    const wellbeing = row.wellbeing;
    const record = wellbeing && typeof wellbeing === 'object' && !Array.isArray(wellbeing)
      ? wellbeing as Record<string, unknown>
      : {};
    line(`    行 id=${String(row.id).slice(0, 8)}…  wellbeing 类型=${wellbeing === null ? 'null' : Array.isArray(wellbeing) ? 'array' : typeof wellbeing}`);
    line(`    wellbeing 顶层键: ${JSON.stringify(Object.keys(record))}`);
    line(`    staff_prefs 类型: ${record.staff_prefs === undefined ? 'undefined（未创建）' : typeof record.staff_prefs}`);
    if (record.staff_prefs && typeof record.staff_prefs === 'object') {
      const prefs = record.staff_prefs as Record<string, unknown>;
      line(`    staff_prefs 中的员工数: ${Object.keys(prefs).length}`);
      for (const [staffId, value] of Object.entries(prefs)) {
        line(`      ${staffId.slice(0, 8)}… -> ${JSON.stringify(value)}`);
      }
    }
  }
  line('');

  // ---- 3. 可能调用导出的账号（user_id 已关联的员工档案） -------------------
  line('[3] 本店已关联登录账号的员工档案（能真正走到导出接口的人）');
  const linkedRes = await client
    .from('staff')
    .select('id, name, user_id, is_active, status')
    .eq('tenant_id', ANCHOR_TENANT)
    .eq('business_id', ANCHOR_BUSINESS)
    .order('created_at', { ascending: false })
    .limit(20);
  if (linkedRes.error) {
    line(`    ERROR: ${linkedRes.error.message}`);
  } else {
    const rows = (linkedRes.data ?? []) as Row[];
    const linked = rows.filter((row) => typeof row.user_id === 'string' && row.user_id !== '');
    line(`    本次取 ${rows.length} 行，其中已关联账号 ${linked.length} 行`);
    for (const row of linked) {
      line(`      ${String(row.id).slice(0, 8)}… ${String(row.name)} active=${JSON.stringify(row.is_active)} status=${JSON.stringify(row.status)}`);
    }
    if (linked.length === 0) {
      line('    => 库里没有"已关联账号"的员工：导出接口的 HTTP 路径无法用真实会话端到端验证');
    }
  }
  line('');

  // ---- 4. 考勤 / 排班 / 关怀记录的自查行数 --------------------------------
  line('[4] attendance / shifts / care_notes 的行数（导出块的三个数据源）');
  for (const table of ['staff_attendance', 'staff_shifts', 'staff_care_notes']) {
    const counted = await client.from(table).select('id').eq('tenant_id', ANCHOR_TENANT).eq('business_id', ANCHOR_BUSINESS).limit(200);
    line(`    ${table.padEnd(20)} -> ${counted.error ? `ERROR(${counted.error.message.slice(0, 40)})` : `${(counted.data ?? []).length} 行（上限 200）`}`);
  }
  line('');

  line('='.repeat(88));
  return 0;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
