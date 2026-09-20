import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

import { _clearAuthCaches, _seedRoleForTest } from '../src/lib/auth-guard';
import {
  readStaffPreference,
  staffPreferenceSlice,
  type StaffSettingsRow,
} from '../src/app/api/staff/preferences/route';
import { mergeVisibleCareNotes } from '../src/app/api/staff/export/route';

/**
 * 员工数据权利（Phase 18 §5.7）—— 本轮修复的两处缺口的守卫。
 *
 * ## 守的是什么
 *
 * 这两个缺口都属于"**不报错的错**"，只会以"用户看到的东西是错的"形式暴露：
 *
 *   1. `GET /api/staff/me` 不返回 `preferences`，而 `StaffMeResponse` 与
 *      `/api/staff/preferences` 的文件头都声称它返回。实测症状：员工打开隐私开关、
 *      **刷新页面后显示成关闭**（服务端其实记着开启）。接口少一个字段，
 *      构建不会响、ts-check 不会响、HTTP 也是 200。
 *   2. 隐私开关的读语义若被复制成两份（`/me` 一份、PATCH 一份），
 *      改一处忘一处就会重新长回上面那条 bug。所以这里同时对"读语义只有一处实现"
 *      做源码级断言。
 *   3. `GET /api/staff/export` 是**隐私义务**（员工有权导出自己的数据）。
 *      它的危险形态同样是静默的：从查询参数取 staff id（越权导同事）、
 *      关怀记录改用"按 tenant 全取"的第二套规则（隐私规则失效）、
 *      审计写失败后继续把数据交出去（读取不可查证）。三条都不会让页面报错。
 *
 * ## 每条断言都配负向对照
 *
 * 源码级断言最容易写成"永远成立"的空断言（正则写歪、变量名换了、
 * 剥注释剥过头）。因此每条都附一个**合成反例**：把反例喂给同一个 matcher，
 * 必须被判定为不合格。反例不触发，就说明断言写虚了。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PREFERENCES_ROUTE = 'src/app/api/staff/preferences/route.ts';
const ME_ROUTE = 'src/app/api/staff/me/route.ts';
const EXPORT_ROUTE = 'src/app/api/staff/export/route.ts';
/** 老板端关怀记录路由：**可见性规则的唯一定义处**，本文件只读它，不改它。 */
const OWNER_CARE_NOTES_ROUTE = 'src/app/api/team/care/notes/route.ts';
const STAFF_PWA = 'src/components/staff/StaffPwa.tsx';
const API_CLIENT = 'src/lib/api.ts';

/** 客户端可控的查询参数名（`.searchParams.get('x')` / `.getAll('x')`）。 */
function searchParamNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const match of src.matchAll(/searchParams\.(?:get|getAll)\(\s*'([^']+)'/g)) {
    names.add(match[1]);
  }
  return names;
}

/** 被静默吞掉的异常：`catch {}` / `catch {\n}` / `.catch(() => {})`。 */
function findSilentCatch(source: string): string[] {
  const code = stripComments(source);
  const rules: { label: string; pattern: RegExp }[] = [
    { label: 'catch {}', pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/ },
    { label: '空 catch 回调', pattern: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/ },
  ];
  return rules.filter((rule) => rule.pattern.test(code)).map((rule) => rule.label);
}

// ---------------------------------------------------------------------------
// 1) readStaffPreference：缺任何一层都是"关闭"（fail-closed）
// ---------------------------------------------------------------------------

/**
 * 用一个**不存在的行**当作"缺 settings 行"，用真实的 jsonb 形状造其余三种。
 *
 * 为什么要注入行而不是查真实库：settings 是**全店共用的单行**，测试不可能
 * 为了造"缺 wellbeing"去删别人的设置。注入点是刻意留在路由里的
 * （见 `StaffSettingsRowLoader` 的说明），与 `_setAuditSinkForTest` 同一形态。
 */
const noRow: () => Promise<StaffSettingsRow | null> = async () => null;
const rowWith = (wellbeing: unknown): (() => Promise<StaffSettingsRow | null>) =>
  async () => ({ id: 'settings-row-1', wellbeing });

const STAFF_ID = 'staff-aaaaaaaa-1111-2222-3333-444444444444';

async function readWith(wellbeing: unknown): Promise<boolean> {
  const result = await readStaffPreference('t-1', 'b-1', STAFF_ID, rowWith(wellbeing));
  return result.personal_data_opt_in;
}

describe('readStaffPreference: 缺即关闭（隐私默认）', () => {
  test('缺 settings 行 → false', async () => {
    const result = await readStaffPreference('t-1', 'b-1', STAFF_ID, noRow);
    assert.deepEqual(result, { personal_data_opt_in: false });
  });

  test('缺 wellbeing（null / 未定义）→ false', async () => {
    assert.equal(await readWith(null), false);
    assert.equal(await readWith(undefined), false);
  });

  test('wellbeing 不是对象（数组 / 字符串 / 数字）→ false，而不是崩', async () => {
    for (const bad of [[], ['x'], 'wellbeing', 0, true]) {
      assert.equal(await readWith(bad), false, `wellbeing=${JSON.stringify(bad)} 必须落回关闭`);
    }
  });

  test('缺 staff_prefs → false', async () => {
    assert.equal(await readWith({}), false);
    assert.equal(await readWith({ other_key: { personal_data_opt_in: true } }), false);
  });

  test('缺这个员工那一格 → false（别人开了不等于我开了）', async () => {
    assert.equal(await readWith({ staff_prefs: {} }), false);
    assert.equal(await readWith({ staff_prefs: { 'another-staff': { personal_data_opt_in: true } } }), false);
  });

  test('这一格存在但没有该字段 → false', async () => {
    assert.equal(await readWith({ staff_prefs: { [STAFF_ID]: {} } }), false);
    assert.equal(await readWith({ staff_prefs: { [STAFF_ID]: { nickname: 'x' } } }), false);
  });

  test('显式 false → false（这一条是阳性对照之外的基线：不能把 false 读成 true）', async () => {
    assert.equal(await readWith({ staff_prefs: { [STAFF_ID]: { personal_data_opt_in: false } } }), false);
  });

  test('只有**显式 true** → true', async () => {
    const result = await readStaffPreference(
      't-1', 'b-1', STAFF_ID,
      rowWith({ staff_prefs: { [STAFF_ID]: { personal_data_opt_in: true } } }),
    );
    assert.deepEqual(result, { personal_data_opt_in: true });
  });

  test('非布尔的"真值"一律不认：\'true\' / 1 / \'1\' / {} / [] → false', async () => {
    for (const fake of ['true', 'TRUE', 1, 0, {}, [], 'yes']) {
      assert.equal(
        await readWith({ staff_prefs: { [STAFF_ID]: { personal_data_opt_in: fake } } }),
        false,
        `personal_data_opt_in=${JSON.stringify(fake)} 被当成了开启 —— 宽松解析会让"关"变成"开"`,
      );
    }
  });

  test('兄弟键不被读语义破坏（写入路径要靠它保留别人的偏好）', () => {
    const slice = staffPreferenceSlice(
      {
        locale: { timezone: 'Asia/Shanghai' },
        staff_prefs: {
          'staff-b': { personal_data_opt_in: true },
          [STAFF_ID]: { personal_data_opt_in: true, nickname: '小李' },
        },
      },
      STAFF_ID,
    );
    assert.equal(slice.personal_data_opt_in, true);
    // wellbeing 的其他键与别人的偏好都必须在切片里原样带着
    assert.deepEqual(slice.wellbeing.locale, { timezone: 'Asia/Shanghai' });
    assert.deepEqual(slice.staffPrefs['staff-b'], { personal_data_opt_in: true });
    // 自己那一格里原有的字段不能被丢掉（PATCH 要 `...ownPrefs` 合并回去）
    assert.equal(slice.ownPrefs.nickname, '小李');
  });

  test('负向对照：读取器真的会去读注入的行（否则上面全是"恒 false"的空断言）', async () => {
    // 同一个读取器，喂 true 的行必须给出 true —— 证明它不是无条件回 false。
    assert.equal(await readWith({ staff_prefs: { [STAFF_ID]: { personal_data_opt_in: true } } }), true);
    // 再把 staff id 换成"另一个人"，同一份 wellbeing 必须变回 false
    // —— 证明它按 staffId 分片，而不是看"有没有人开过"。
    const other = await readStaffPreference(
      't-1', 'b-1', 'staff-bbbbbbbb-9999-0000-1111-222222222222',
      rowWith({ staff_prefs: { [STAFF_ID]: { personal_data_opt_in: true } } }),
    );
    assert.equal(other.personal_data_opt_in, false);
  });

  test('库读失败必须抛错，不得回落成 false（"不知道"不等于"关闭"）', async () => {
    const failing = async (): Promise<StaffSettingsRow | null> => {
      throw new Error('settings read failed: connection reset');
    };
    await assert.rejects(
      () => readStaffPreference('t-1', 'b-1', STAFF_ID, failing),
      /settings read failed/,
      '库读失败被吞成了 false —— 那正是本轮要修的谎报',
    );
    // 负向对照：正常行不抛（证明上面的 rejects 不是"恒抛"）
    await assert.doesNotReject(() => readStaffPreference('t-1', 'b-1', STAFF_ID, noRow));
  });
});

// ---------------------------------------------------------------------------
// 2) 读语义只有一处实现：/me 与 PATCH 共用它
// ---------------------------------------------------------------------------

describe('staff preferences: 读语义只有一处实现', () => {
  const prefs = stripComments(read(PREFERENCES_ROUTE));
  const me = stripComments(read(ME_ROUTE));

  test('/api/staff/me 返回 preferences，且走 readStaffPreference', () => {
    assert.match(
      me,
      /import \{ readStaffPreference \} from '@\/app\/api\/staff\/preferences\/route';/,
      'me 路由没有复用读语义的唯一实现',
    );
    assert.match(me, /preferences = await readStaffPreference\(tenantId, businessId, staffId\)/);
    // 多行正则：`preferences,` 是响应体里的一行（`$` 必须按行锚定）
    assert.match(me, /^\s*preferences,$/m, 'me 的响应体里没有 preferences');
  });

  test('/api/staff/me 不自己再解析一遍 jsonb', () => {
    assert.doesNotMatch(me, /staff_prefs/, 'me 路由里出现了 staff_prefs —— 读语义被复制了第二份');
    assert.doesNotMatch(me, /\.from\('settings'\)/, 'me 路由自己读 settings 行了');
  });

  test('PATCH 也走同一个切片函数（写入时"保留哪些键"与读取时"从哪取值"同源）', () => {
    assert.match(
      prefs,
      /const \{ wellbeing, staffPrefs, ownPrefs \} = staffPreferenceSlice\(row\?\.wellbeing, staffId\);/,
    );
    assert.match(
      prefs,
      /personal_data_opt_in: staffPreferenceSlice\(row\?\.wellbeing, staffId\)\.personal_data_opt_in/,
      'readStaffPreference 没有委托给切片函数 —— 它自己又解析了一遍',
    );
    // 唯一实现必须被导出（否则无法被 /me 与测试复用）
    assert.match(prefs, /export function staffPreferenceSlice\(wellbeing: unknown, staffId: string\)/);
    assert.match(prefs, /export async function readStaffPreference\(/);
  });

  test('负向对照：一份"自己解析 jsonb"的 me 实现会被上面两条抓住', () => {
    const broken = `
      const { data } = await getSupabaseClient().from('settings').select('wellbeing').maybeSingle();
      const optedIn = data?.wellbeing?.staff_prefs?.[staffId]?.personal_data_opt_in === true;
    `;
    assert.match(broken, /staff_prefs/, '负向对照失效：复制出来的解析没被认出来');
    assert.match(broken, /\.from\('settings'\)/);
    assert.doesNotMatch(broken, /readStaffPreference/);
  });
});

// ---------------------------------------------------------------------------
// 3) 导出路由：staff id 只来自会话
// ---------------------------------------------------------------------------

describe('staff export: 只能导出自己（staff id 只来自会话）', () => {
  const route = stripComments(read(EXPORT_ROUTE));

  test('整个文件不读任何查询参数', () => {
    const names = searchParamNames(route);
    assert.equal(names.has('staff_id'), false, '导出接口读了 ?staff_id= —— 任何人都能导同事的档案与考勤');
    assert.equal(names.size, 0, `导出接口读了查询参数：${[...names].join(', ')}（本路由不该有任何入参）`);
  });

  test('员工档案 id 来自 staffRequestContext，租户/门店同样来自会话', () => {
    assert.match(route, /staffRequestContext\(request\)/);
    assert.match(route, /resolved\.ctx/);
    // 三张表都必须同时按会话解析出的 tenant + business + staff 过滤
    assert.equal(
      (route.match(/\.eq\('staff_id', staffId\)/g) ?? []).length,
      2,
      '考勤与排班都必须按会话 staff id 过滤（各一处）',
    );
    for (const filter of [/\.eq\('tenant_id', tenantId\)/, /\.eq\('business_id', businessId\)/]) {
      assert.match(route, filter);
    }
  });

  test('响应是附件：Content-Disposition 带 staffId，Content-Type 是 JSON', () => {
    assert.match(
      route,
      /'Content-Disposition': `attachment; filename="roveframe-staff-export-\$\{staffId\}\.json"`/,
    );
    assert.match(route, /'Content-Type': 'application\/json'/);
  });

  test('响应体是约定的五个块', () => {
    for (const key of ['exported_at:', 'staff: {', 'attendance,', 'shifts,', 'care_notes: careNotes,']) {
      assert.ok(route.includes(key), `导出响应缺少 ${key}`);
    }
    for (const field of ['id:', 'name:', 'position:', 'photo_url:', 'phone:', 'email:', 'employment_type:', 'hired_at:', 'birthday:', 'status:']) {
      assert.ok(route.includes(field), `staff 块缺少字段 ${field}`);
    }
  });

  test('负向对照：从查询参数取 staff id 的实现会被同一组检查抓住', () => {
    const broken = `
      const staffId = request.nextUrl.searchParams.get('staff_id') ?? resolved.ctx.staffId;
      const rows = await client.from('staff_attendance').select('*').eq('staff_id', staffId);
    `;
    assert.equal(
      searchParamNames(broken).has('staff_id'),
      true,
      '负向对照失效：客户端 staff_id 没被认出来',
    );
    assert.equal(searchParamNames(broken).size === 0, false);
    // 同一段反例里也没有"只按会话过滤"的形态
    assert.equal((broken.match(/\.eq\('tenant_id', tenantId\)/g) ?? []).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4) 关怀记录：可见性规则与老板端**逐条一致**
// ---------------------------------------------------------------------------

/**
 * 可见性规则的标识符清单。
 *
 * 这份清单**不是**照抄文档写出来的：下面有一条测试把它拿去在老板端路由
 * （`src/app/api/team/care/notes/route.ts`，规则的唯一定义处）上核对，
 * 全部命中才算"这就是老板端那套规则"。老板端改规则时那条测试会红，
 * 逼着这里同步 —— 这是"两处规则不许漂移"的可执行形式。
 */
const CARE_VISIBILITY_IDENTIFIERS = [
  'author_user_id',
  'subjectStaffIdsForUser',
  'isStaffVisibleToUser',
  "user_id",
  "staff_care_notes",
  '.in(\'staff_id\', subjects.staffIds)',
] as const;

function findMissingVisibilityIdentifiers(source: string): string[] {
  const code = stripComments(source);
  return CARE_VISIBILITY_IDENTIFIERS.filter((token) => !code.includes(token));
}

describe('staff export: 关怀记录用老板端那套可见性规则', () => {
  test('阳性对照：这份清单确实描述的是老板端路由的规则', () => {
    assert.deepEqual(
      findMissingVisibilityIdentifiers(read(OWNER_CARE_NOTES_ROUTE)),
      [],
      '清单与老板端路由已经对不上 —— 先更新清单，再断言导出路由',
    );
  });

  test('导出路由包含同一组标识符', () => {
    assert.deepEqual(
      findMissingVisibilityIdentifiers(read(EXPORT_ROUTE)),
      [],
      '导出路由没有照着老板端那套可见性规则筛关怀记录',
    );
  });

  test('两个分支分开取再按 id 去重（不拼 or 字符串，避免静默多返回）', () => {
    const route = stripComments(read(EXPORT_ROUTE));
    assert.match(route, /\.eq\('author_user_id', userId\)/, '缺少"我写的"这一分支');
    assert.match(route, /\.in\('staff_id', subjects\.staffIds\)/, '缺少"写我的"这一分支');
    assert.match(route, /mergeVisibleCareNotes\(/, '两条分支的并集没有走合并（去重/排序）函数');
    assert.doesNotMatch(route, /\.or\(/, '用了 PostgREST 的 or(...) 拼接 —— 写错的表现是静默多返回');
  });

  test('导出的关怀记录不带 author_user_id（那是别人的标识符）', () => {
    const route = stripComments(read(EXPORT_ROUTE));
    const selectClause = route.slice(route.indexOf('const noteColumns'));
    assert.match(selectClause, /'id, staff_id, author_user_id, kind, content, visibility, created_at'/);
    // 取出来用于过滤，但**不得**进入返回体
    const responseBlock = route.slice(route.indexOf('care_notes: careNotes'));
    assert.ok(responseBlock.length > 0);
    assert.doesNotMatch(
      route.slice(route.indexOf('const careNotes ='), route.indexOf('const attendance =')),
      /author_user_id/,
      'careNotes 的映射里出现了 author_user_id —— 会把别人的账号 id 交给导出者',
    );
  });

  test('负向对照：按 tenant 全取的第二套规则会被同一组检查拒绝', () => {
    const broken = `
      const { data } = await client.from('staff_care_notes')
        .select('id, content').eq('tenant_id', tenantId);
    `;
    const missing = findMissingVisibilityIdentifiers(broken);
    assert.ok(missing.includes('author_user_id'), '负向对照失效：全取规则没被认出来');
    assert.ok(missing.includes('subjectStaffIdsForUser'));
    assert.ok(missing.includes('isStaffVisibleToUser'));
  });
});

// ---------------------------------------------------------------------------
// 4b) 合并分支：去重 / 倒序 / 丢掉 author_user_id（执行验证，不是正则）
// ---------------------------------------------------------------------------

/** 造一条关怀记录行（形状与 staff_care_notes 的 select 一致）。 */
function noteRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'note-1',
    staff_id: 'staff-me',
    author_user_id: 'user-me',
    kind: 'one_on_one',
    content: '内容',
    visibility: 'private',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('staff export: mergeVisibleCareNotes（真实执行）', () => {
  test('两个分支重叠时按 id 去重（同一条只出现一次）', () => {
    // 两个分支来自**两次不同的查询**，因此是内容相同但对象不同的两行 ——
    // 这正是真实库的样子（不是同一个引用被传两次）。
    const merged = mergeVisibleCareNotes([
      [noteRow({ id: 'note-1', content: '作者分支' })],
      [noteRow({ id: 'note-1', content: '当事人分支' })],
    ]);
    assert.equal(merged.length, 1, '重叠的行没有被去重 —— 员工会以为同一条谈话记录了两次');
    assert.equal(merged[0].id, 'note-1');

    // 负向对照：id 不同的两行必须都留下（证明它不是把所有行都压成一条）
    const twoDistinct = mergeVisibleCareNotes([
      [noteRow({ id: 'note-1' })],
      [noteRow({ id: 'note-2' })],
    ]);
    assert.deepEqual(twoDistinct.map((n) => n.id).sort(), ['note-1', 'note-2']);
  });

  test('按 created_at 倒序（与老板端列表顺序一致）', () => {
    const merged = mergeVisibleCareNotes([[
      noteRow({ id: 'old', created_at: '2025-01-01T00:00:00.000Z' }),
      noteRow({ id: 'new', created_at: '2026-06-01T00:00:00.000Z' }),
      noteRow({ id: 'mid', created_at: '2026-01-01T00:00:00.000Z' }),
    ]]);
    assert.deepEqual(merged.map((n) => n.id), ['new', 'mid', 'old']);
    // 负向对照：顺序断言必须真的会红（正序的实现不满足它）
    assert.notDeepEqual([...merged].reverse().map((n) => n.id), ['new', 'mid', 'old']);
  });

  test('结果里没有 author_user_id（别人的账号 id 不进导出）', () => {
    const merged = mergeVisibleCareNotes([[noteRow({ author_user_id: 'someone-else' })]]);
    assert.equal('author_user_id' in merged[0], false, '导出的关怀记录带上了作者账号 id');
    // 同一份输入里的原始行**确实**有该字段 —— 证明上面的断言不是"输入本来就没有"
    assert.equal('author_user_id' in noteRow({ author_user_id: 'someone-else' }), true);
  });

  test('缺字段的行被收敛成合法值，而不是 undefined 漏进 JSON', () => {
    const merged = mergeVisibleCareNotes([[
      { id: 'bare', staff_id: 'staff-me', created_at: null },
    ]]);
    assert.deepEqual(merged[0], {
      id: 'bare',
      staff_id: 'staff-me',
      kind: 'one_on_one',
      content: '',
      visibility: 'private',
      created_at: null,
    });
  });

  test('空分支 / null 分支不制造行（没有关怀记录就是空数组）', () => {
    assert.deepEqual(mergeVisibleCareNotes([]), []);
    assert.deepEqual(mergeVisibleCareNotes([null]), []);
    assert.deepEqual(mergeVisibleCareNotes([null, []]), []);
    // 负向对照：有行时不能也返回空
    assert.equal(mergeVisibleCareNotes([[noteRow({})]]).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5) 审计：每一次导出都必须留痕，留不下就不导出
// ---------------------------------------------------------------------------

describe('staff export: 强制审计', () => {
  const route = stripComments(read(EXPORT_ROUTE));
  const ownerRoute = stripComments(read(OWNER_CARE_NOTES_ROUTE));

  test('用的是老板端关怀记录读取所用的同一个函数（writeRequiredAudit）', () => {
    assert.match(route, /import \{ writeRequiredAudit \} from '@\/lib\/audit';/);
    assert.match(route, /await writeRequiredAudit\(\{/);
    // 交叉核对：老板端那份也是 required，不是 best-effort
    assert.match(ownerRoute, /import \{ writeRequiredAudit \} from '@\/lib\/audit';/);
    assert.doesNotMatch(route, /\bwriteAudit\(/, 'best-effort 的 writeAudit 允许"读到了但没留痕"');
  });

  test('审计写失败 → 503，且在此之前不把数据交出去', () => {
    assert.match(route, /action: 'staff\.export'/);
    assert.match(route, /entity: 'staff'/);
    assert.match(route, /entityId: staffId/);
    assert.match(route, /\{ error: 'security audit unavailable' \}, \{ status: 503 \}/);

    const auditAt = route.indexOf('await writeRequiredAudit(');
    const responseAt = route.indexOf('return NextResponse.json(body, {');
    assert.ok(auditAt > 0 && responseAt > auditAt, '审计必须排在返回响应体之前');
  });

  test('审计只记条数，不记内容', () => {
    const auditBlock = route.slice(route.indexOf('await writeRequiredAudit('), route.indexOf('const body = {'));
    assert.match(auditBlock, /attendance_rows: attendance\.length/);
    assert.match(auditBlock, /care_note_rows: careNotes\.length/);
    assert.doesNotMatch(auditBlock, /content/, '审计里出现了关怀记录正文 —— 审计表是更宽的可见面');
  });

  test('没有任何静默 catch（失败一律显式返回）', () => {
    assert.deepEqual(findSilentCatch(read(EXPORT_ROUTE)), [], '导出路由里有被吞掉的异常');
    assert.deepEqual(findSilentCatch(read(PREFERENCES_ROUTE)), []);
    assert.deepEqual(findSilentCatch(read(ME_ROUTE)), []);
  });

  test('负向对照：合成反例会被静默 catch 检查与审计断言同时拒绝', () => {
    const broken = `
      try { await writeAudit({ action: 'staff.export' }); } catch {}
      return NextResponse.json(body);
    `;
    assert.ok(findSilentCatch(broken).includes('catch {}'), '负向对照失效：空 catch 没被认出来');
    assert.doesNotMatch(broken, /status: 503/);
    assert.doesNotMatch(broken, /writeRequiredAudit\(/);
    // 阳性对照：把 catch 改成显式返回后，同一条断言必须放行
    assert.doesNotMatch(
      "try { await writeRequiredAudit({ action: 'staff.export' }); } catch (e) { return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 }); }",
      /catch\s*\{\s*\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6) 客户端：api 方法与 PWA 里的导出入口
// ---------------------------------------------------------------------------

describe('staff export: 客户端链路', () => {
  const api = stripComments(read(API_CLIENT));
  const pwa = stripComments(read(STAFF_PWA));

  test('staffApi.exportStaffData() 存在，且不接受任何参数', () => {
    // 空参数表是有意的：服务端只导出会话本人，多一个 staffId 参数就是
    // 向调用方许诺一个它做不到的能力。
    assert.match(api, /async exportStaffData\(\): Promise<StaffDataExport> \{/);
    assert.match(api, /return request<StaffDataExport>\('\/api\/staff\/export'\);/);
    assert.doesNotMatch(api, /\/api\/staff\/export\?/, '导出 URL 上挂了查询参数');

    // 负向对照：带参数的签名必须被同一个"空参数表"正则拒绝
    const broken = 'async exportStaffData(staffId: string): Promise<StaffDataExport> {';
    assert.doesNotMatch(broken, /async exportStaffData\(\): Promise<StaffDataExport> \{/);
  });

  test('PWA 在"我的"页里有导出卡片，且走真实客户端与 Blob 下载', () => {
    assert.match(pwa, /staffApi\.exportStaffData\(\)/);
    assert.match(pwa, /URL\.createObjectURL\(new Blob\(/);
    assert.match(pwa, /anchor\.download = `roveframe-staff-export-\$\{staffMe\?\.staff\.id \?\? 'me'\}\.json`/);
    assert.match(pwa, /t\.staff\.export_my_data/, '没有复用已有的 i18n 键 export_my_data');
    assert.match(pwa, /id="staff-export-data-btn"/);
  });

  test('导出失败会显示出来（不写 catch {}）', () => {
    assert.match(pwa, /setExportError\(describeError\(err, '导出失败'\)\)/);
    assert.match(pwa, /\{exportError && \(/);
    assert.deepEqual(findSilentCatch(read(STAFF_PWA)), [], 'StaffPwa 里出现了被吞掉的异常');
  });

  test('卡片挂在 "me" 这个 tab 里（端口工人留下的缺口处）', () => {
    const meTabAt = pwa.indexOf("tab === 'me'");
    const cardAt = pwa.indexOf('staff-export-data-btn');
    assert.ok(meTabAt > 0, '找不到 me tab');
    assert.ok(cardAt > 0, '找不到导出按钮');
    assert.ok(cardAt > meTabAt, '导出卡片不在 me tab 内');

    // 负向对照：把卡片放到 me tab 之前的合成源码必须被同一条断言判为不合格
    const broken = `{/* staff-export-data-btn */}\n{tab === 'me' && (<div />)}`;
    assert.equal(
      broken.indexOf('staff-export-data-btn') > broken.indexOf("tab === 'me'"),
      false,
      '负向对照失效：位置断言写虚了',
    );
  });

  test('/api/staff/me 返回的 position / photo_url 在 UI 上真的被读', () => {
    // readEmployeeRole 曾经只读恒为 null 的 employee_role
    assert.match(pwa, /typeof staff\.position === 'string' && staff\.position/);
  });
});

// ---------------------------------------------------------------------------
// 7) 行为证据：**真实调用 handler**，不是源码正则
// ---------------------------------------------------------------------------
//
// 上面 6 节全是源码级断言，它们能防"实现形态漂移"，但不能证明这条路由
// 真的会拒绝人。这一节用本地签发的真 JWT 走真实鉴权链（与
// tests/subscription-entitlements.test.ts 同一套夹具），断言两道门禁各自的
// 状态码 —— 而且断言**响应体里没有任何数据块**：
// 一个"状态码对了但顺带回了数据"的实现，比状态码错更危险。

const ANCHOR_TENANT = '00000000-0000-0000-0000-000000000000';
const ANCHOR_BUSINESS = '00000000-0000-0000-0000-000000000001';
const JWT_SECRET = 'staff-data-rights-test-secret';

/** 本地签发 HS256 JWT（与 subscription-entitlements.test.ts 同一写法）。 */
function makeJwt(userId: string, tenantId: string, businessId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@test.invalid`,
    app_metadata: { tenant_id: tenantId, business_id: businessId },
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** 导出响应体里**只有**这些键才是合法的数据块。 */
const EXPORT_DATA_KEYS = ['exported_at', 'staff', 'attendance', 'shifts', 'care_notes'] as const;

function assertNoExportData(body: Record<string, unknown>, label: string): void {
  for (const key of EXPORT_DATA_KEYS) {
    assert.equal(key in body, false, `${label} 的响应体里出现了 ${key} —— 门禁没拦住数据`);
  }
}

describe('GET /api/staff/export：真实调用 handler 的门禁（行为证据）', () => {
  before(() => {
    process.env.COZE_SUPABASE_JWT_SECRET = JWT_SECRET;
    _clearAuthCaches();
  });

  after(() => {
    delete process.env.COZE_SUPABASE_JWT_SECRET;
    _clearAuthCaches();
  });

  test('没有凭据 → 401，且响应体里没有任何数据块', async () => {
    const { GET } = await import('../src/app/api/staff/export/route');
    const response = await GET(new NextRequest('http://localhost/api/staff/export'));
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'unauthorized' });
    assertNoExportData(body, '未鉴权');

    // 负向对照：上面那条"没有数据块"的检查必须真的会红
    assert.throws(
      () => assertNoExportData({ exported_at: 'x', staff: {} }, '合成反例'),
      /门禁没拦住数据/,
    );
  });

  test('有凭据但账号未关联员工档案 → 409 staff_not_linked（不是"空导出"）', async () => {
    const userId = 'export-gate-probe-no-staff';
    _seedRoleForTest(userId, 'owner');
    const { GET } = await import('../src/app/api/staff/export/route');
    const response = await GET(new NextRequest('http://localhost/api/staff/export', {
      headers: { authorization: `Bearer ${makeJwt(userId, ANCHOR_TENANT, ANCHOR_BUSINESS)}` },
    }));
    // owner 的权限是 ['*']，连它都过不去 —— 说明拦住它的是"员工档案"这道门，
    // 而不是权限矩阵（实测：真实库里没有任何 staff 行，这正是当前的真实状态）。
    assert.equal(
      response.status,
      409,
      `期望 409（账号未关联员工档案），实得 ${response.status}`,
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'staff_not_linked');
    assertNoExportData(body, '未关联档案');
  });

  test('有凭据、有员工档案这道门之外，还要求会话解析出的 staff id 属于本人', async () => {
    // 这条是源码级断言的**行为侧对照**：证明"staff id 来自会话"不是一句注释。
    const route = stripComments(read(EXPORT_ROUTE));
    assert.match(route, /const \{ tenantId, businessId, userId, staffId, staffName/);
    assert.match(route, /if \(!isStaffVisibleToUser\(subjects\.staffIds, staffId\)\)/);
    assert.match(route, /code: 'staff_not_found'/, '档案在解析之后消失时必须 409，而不是回一份空档案');
  });
});
