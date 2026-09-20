import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 —— 员工端四个接口（shifts / attendance / reservations / care-resources /
 * preferences）的守卫。所有断言都是**源码级**的，理由与 delivery-backend 相同：
 *
 * 这一层要守的不是"某次行为"，而是"实现形态"。竞态（同一员工并发双击打卡）、
 * 越权（客户端传 staff_id 看别人排班）、隐私规则（关怀资源不得变成问卷）
 * 这三类缺陷在单进程行为测试里几乎必然通过 —— 那样的测试给不出任何保证。
 *
 * 每条守卫都配一个**负向对照**：一段"确实违规"的合成代码，用来证明
 * 这条正则/这组逻辑真的会拒绝它。没有负向对照的守卫无法区分
 * "代码是对的"与"正则写错了永远不匹配"。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ATTENDANCE_ROUTE = 'src/app/api/staff/attendance/route.ts';
const SHIFTS_ROUTE = 'src/app/api/staff/shifts/route.ts';
const CONFIRM_ROUTE = 'src/app/api/staff/reservations/[id]/confirm/route.ts';
const CARE_ROUTE = 'src/app/api/staff/care-resources/route.ts';
const PREFERENCES_ROUTE = 'src/app/api/staff/preferences/route.ts';
const MIGRATION = 'scripts/migrate-workforce.sql';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 取出一个**顶层**声明的源码块：从 `[export] [async] function NAME` 或
 * `[export] const NAME` 起到下一个顶层声明为止。
 *
 * 用于把"这个 handler 到底读了什么"限制在单个 handler 内部断言 ——
 * 对整个文件断言会被同文件里的其他 handler 干扰。
 * 注意 handler 常常是**不导出**的局部函数（export const POST = guard(policy, handler)），
 * 所以这里不要求 export 前缀。
 */
function declaredBlock(src: string, name: string): string {
  const match = new RegExp(
    `^(?:export )?(?:async )?(?:function|const) ${name}\\b`,
    'm',
  ).exec(src);
  assert.ok(match, `未找到顶层声明 ${name}`);
  const start = match.index;
  const next = new RegExp(`\\n(?:export |async function |function |const )`).exec(src.slice(start + 1));
  return next ? src.slice(start, start + 1 + next.index) : src.slice(start);
}

/** 客户端可控的查询参数名（`.searchParams.get('x')` / `.searchParams.getAll('x')`）。 */
function searchParamNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const match of src.matchAll(/searchParams\.(?:get|getAll)\(\s*'([^']+)'/g)) {
    names.add(match[1]);
  }
  return names;
}

/** 是否出现 `obj.field` 形式的属性读取（用于禁用字段名，如 body.direction）。 */
function readsProperty(src: string, field: string): boolean {
  return new RegExp(`\\.${field}\\b`).test(src);
}

/**
 * 取"真正干活的那个函数"。
 *
 * 员工端写接口统一写成 `export const POST = protectBusinessMutation(policy, handler)`，
 * 因此 `POST` 本身只有三行（策略 + 函数引用），业务逻辑在 handler 里。
 * 断言只看 POST 会得到一条**永远通过**的空断言 —— 这正是本项目
 * "结论必须有负向证据"那条纪律要防的东西（本次实测：第一版就是这样，
 * 负向对照把 `.is('clock_out_at', null)` 断言打红了）。
 *
 * 规则：POST 是 `protect*Mutation(..., <标识符>)` 形式时返回该标识符的函数体，
 * 否则返回 POST 自身的函数体。
 */
function executableBlock(src: string, name: string): string {
  const wrapper = declaredBlock(src, name);
  const delegated = /protect(?:Business|Tenant)Mutation\([\s\S]*?,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/.exec(wrapper);
  if (!delegated) return wrapper;
  const handler = delegated[1];
  if (handler === name) return wrapper;
  return declaredBlock(src, handler);
}

// ---------------------------------------------------------------------------
// 1) 打卡：方向由服务端判定，客户端无法指定
// ---------------------------------------------------------------------------

describe('staff attendance: direction is decided by the server', () => {
  const route = stripComments(read(ATTENDANCE_ROUTE));
  // 真正干活的是 attendanceHandler；POST 只是中央守卫的包装。
  // executableBlock 会跟着这层引用走下去，否则下面全是空断言。
  const post = executableBlock(route, 'POST');

  test('断言确实落在 handler 内部，而不是空的导出包装上', () => {
    assert.match(post, /attendanceHandler|async function/, '没有取到真正的 handler');
    assert.ok(post.length > 500, `handler 源码过短（${post.length} 字符），断言可能落空了`);
  });

  /**
   * 只要 handler 能读到请求体，就存在"客户端说签退就签退"的可能。
   * 因此这条断言比"不含 body.direction"更强：**整个 handler 不读请求体**。
   */
  test('POST handler 完全不读请求体（既无 request.json() 也无 query 参数）', () => {
    assert.doesNotMatch(post, /\.json\(\)/, '打卡 handler 读请求体了 —— 方向必须由服务端判定');
    assert.doesNotMatch(post, /searchParams/, '打卡 handler 读查询参数了 —— 它不该接受任何入参');
  });

  test('整个文件里不存在任何 direction 字段读取', () => {
    assert.equal(readsProperty(post, 'direction'), false, 'handler 读了 .direction');
    // 对整个文件也断言一次：将来有人把方向解析提到包装层同样会被抓住。
    assert.equal(readsProperty(route, 'direction'), false, '路由里出现了 .direction');
    assert.doesNotMatch(route, /\bdirection\b/, '路由里出现了 direction 标识符');
  });

  test('负向对照：一段"客户端传方向"的实现会被上面两条断言拒绝', () => {
    const broken = `export async function POST(request: NextRequest) {
      const body = await request.json();
      if (body.direction === 'out') { /* … */ }
      const forced = request.direction;
      return NextResponse.json({ ok: true });
    }`;
    assert.equal(
      /\.json\(\)/.test(broken),
      true,
      '负向对照失效：连真的读请求体都没被认出来',
    );
    assert.equal(
      readsProperty(broken, 'direction'),
      true,
      '负向对照失效：.direction 读取没被认出来',
    );
  });

  test('方向由"是否存在未签退记录"决定', () => {
    // 在 handler 内部断言：GET 列表里也有 clock_out_at 的用法，只看整个文件会分不清。
    assert.match(post, /\.is\('clock_out_at', null\)/, '未按 clock_out_at is null 判定当前状态');
    assert.match(post, /action: 'clock_in'/);
    assert.match(post, /action: 'clock_out'/);
  });
});

// ---------------------------------------------------------------------------
// 2) 并发双击：靠数据库的部分唯一索引 + 23505 → 409
// ---------------------------------------------------------------------------

describe('staff attendance: double-tap safety', () => {
  const route = stripComments(read(ATTENDANCE_ROUTE));
  const sql = read(MIGRATION);

  test('迁移创建部分唯一索引：只约束 clock_out_at is null 的行', () => {
    assert.match(
      sql,
      /create unique index if not exists staff_attendance_open_key\s+on public\.staff_attendance \(staff_id\) where clock_out_at is null;/,
      '这条索引是"重复打卡不会产生两条开放记录"的唯一保证',
    );
  });

  test('负向对照：一条普通的（非部分）唯一索引不满足上面的断言', () => {
    const broken =
      'create unique index if not exists staff_attendance_open_key on public.staff_attendance (staff_id);';
    assert.equal(
      /create unique index if not exists staff_attendance_open_key\s+on public\.staff_attendance \(staff_id\) where clock_out_at is null;/.test(broken),
      false,
      '非部分索引不该被放行 —— 它会让同一天的第二段班次直接插不进去',
    );
  });

  test('23505 被翻译成 409 already_open，不重试也不吞掉', () => {
    assert.match(route, /code \?= '23505'|code === '23505'/, '没有识别唯一键冲突');
    assert.match(route, /code: 'already_open'/);
    assert.match(route, /\{ status: 409 \}/);
    // 冲突分支里不得出现重试：重试会把并发写放大成循环。
    const conflictBranch = route.slice(route.indexOf("code: 'already_open'"));
    assert.doesNotMatch(conflictBranch.slice(0, 200), /retry|setTimeout|\bawait client/);
  });

  test('签退不会写出负时长记录，但也不把卡住的记录留在"未签退"', () => {
    // 时钟回拨时仍然关闭记录（.is('clock_out_at', null) 的 UPDATE 照常执行），
    // 时长如实算出来，不静默夹成 0。
    const closeBlock = route.slice(route.indexOf('.update({ clock_out_at:'));
    assert.match(closeBlock, /\.is\('clock_out_at', null\)/, '签退没带 clock_out_at is null 条件');
    assert.match(route, /worked_minutes: worked/);
    assert.doesNotMatch(route, /Math\.max\(0, worked\)/, '把负时长静默夹成 0 会掩盖时钟异常');
  });

  test('两个写接口都经中央守卫，且权限与审计 action 明确', () => {
    assert.match(
      route,
      /export const POST = protectBusinessMutation\(\s*\{\s*permission: 'workforce:self', action: 'attendance\.clock', entity: 'staff_attendance' \},/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3) 排班与考勤：只返回本人，绝不接受客户端 staff_id
// ---------------------------------------------------------------------------

describe('staff self-scoped reads reject client-supplied staff_id', () => {
  for (const rel of [SHIFTS_ROUTE, ATTENDANCE_ROUTE]) {
    test(`${rel} 不接受客户端 staff_id`, () => {
      const src = stripComments(read(rel));
      assert.equal(
        searchParamNames(src).has('staff_id'),
        false,
        '接口读了 ?staff_id= —— 任何人都能看同事的排班/考勤',
      );
      // 必须用会话解析出的 staffId 过滤
      assert.match(src, /staffRequestContext\(request\)/);
      assert.match(src, /\.eq\('staff_id', staffId\)/, '没有按会话里的 staff id 过滤');
    });
  }

  test('负向对照：?staff_id= 的读取会被同一条检查抓出来', () => {
    const broken =
      "const staffId = request.nextUrl.searchParams.get('staff_id') ?? resolved.ctx.staffId;";
    assert.equal(
      searchParamNames(broken).has('staff_id'),
      true,
      '负向对照失效：客户端 staff_id 没被认出来',
    );
  });

  test('排班按业务时区切日，且时间窗有上限', () => {
    const src = stripComments(read(SHIFTS_ROUTE));
    for (const helper of ['businessDayRange', 'localDateInTimeZone', 'resolveBusinessTimeZone']) {
      assert.ok(src.includes(helper), `没有使用 src/lib/time.ts 的 ${helper}`);
    }
    assert.match(src, /MAX_WINDOW_DAYS/, '时间窗没有上限，to=2999-12-31 会拉出全表');
  });
});

// ---------------------------------------------------------------------------
// 4) 预约确认：状态机在服务端，非法跃迁是 409
// ---------------------------------------------------------------------------

describe('staff reservation confirm: server-side state machine', () => {
  const src = stripComments(read(CONFIRM_ROUTE));

  test('非法跃迁返回 409 invalid_transition（不是 400，也不是静默成功）', () => {
    assert.match(
      src,
      /\{ error: `cannot change a \$\{from\} reservation to \$\{target\}`, code: 'invalid_transition' \},\s*\{ status: 409 \}/,
    );
  });

  test('并发导致的更新失败同样是 409 invalid_transition', () => {
    assert.match(src, /code: 'invalid_transition'[\s\S]{0,200}\{ status: 409 \}|length !== 1[\s\S]{0,300}code: 'invalid_transition'/);
  });

  test('负向对照：一个"照单全收"的实现不满足 409 断言', () => {
    const broken = `export async function POST() {
      return NextResponse.json({ ok: true });
    }`;
    assert.equal(
      /code: 'invalid_transition'[\s\S]*?\{ status: 409 \}/.test(broken),
      false,
      '负向对照失效：没有状态机的实现被放行了',
    );
  });

  test('状态机只允许 pending→confirmed|cancelled 与 confirmed→arrived|cancelled', () => {
    const pending = /pending: \['confirmed', 'cancelled'\]/.test(src);
    const confirmed = /confirmed: \['arrived', 'cancelled'\]/.test(src);
    assert.ok(pending, 'pending 的允许跃迁不是 confirmed|cancelled');
    assert.ok(confirmed, 'confirmed 的允许跃迁不是 arrived|cancelled');
    // 负向对照：pending 不得直接跳到 arrived（跳过了"已确认"这一步）
    assert.equal(
      /pending: \[[^\]]*'arrived'/.test(src),
      false,
      'pending 能直接跳到 arrived —— 前台会把没确认过的预订当成已到店',
    );
  });

  test('更新同时限定 tenant 与 business，并保留 from 状态', () => {
    assert.match(src, /\.eq\('tenant_id', tenantId\)/);
    assert.match(src, /\.eq\('business_id', businessId\)/);
    assert.match(src, /\.eq\('status', from\)/, 'UPDATE 没带 from —— 并发下会覆盖别人的推进结果');
    assert.match(
      src,
      /permission: 'reservations:confirm', action: 'reservations\.confirm', entity: 'reservations'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5) 关怀资源：只做转介，不得变成测评/问卷/打分
//
// 这条守卫对应 Phase 18 Frontend Spec §5.7 的硬规则。它检查的是**字段名**，
// 因为一旦出现评分或问卷字段，合规性质就变了 —— 那不再是转介目录。
// ---------------------------------------------------------------------------

describe('care resources: referral only, no assessment surface', () => {
  const raw = read(CARE_ROUTE);
  const src = stripComments(raw);

  /** 禁止出现的字段/标识符。大小写不敏感，按单词边界匹配，避免误伤英文散文。 */
  const FORBIDDEN = ['score', 'assessment', 'questionnaire'] as const;

  for (const field of FORBIDDEN) {
    test(`没有 ${field} 字段`, () => {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${field}\\b`, 'i'),
        `${CARE_ROUTE} 里出现了 ${field} —— 关怀资源接口只做转介`,
      );
    });
  }

  test('负向对照：带评分/问卷字段的实现会被同一组正则拒绝', () => {
    const broken = `
      interface CareResource { title: string; score: number; questionnaire: string[] }
      const assessment = computeAssessment(responses);
    `;
    const hits = FORBIDDEN.filter((field) => new RegExp(`\\b${field}\\b`, 'i').test(broken));
    assert.deepEqual(
      [...hits],
      [...FORBIDDEN],
      '负向对照失效：违规字段没被全部认出来',
    );
  });

  test('接口不接收任何数据：无请求体、无查询参数、无数据库读写', () => {
    assert.doesNotMatch(src, /\.json\(\)/, '关怀资源接口读请求体了');
    assert.doesNotMatch(src, /searchParams/, '关怀资源接口读查询参数了');
    assert.doesNotMatch(src, /getSupabaseClient/, '关怀资源接口碰数据库了 —— 它应该是静态清单');
  });

  test('清单是 4-6 条，且每条都有 title / description / url / region', () => {
    const entries = [...src.matchAll(/^\s{4}title: /gm)];
    assert.ok(
      entries.length >= 4 && entries.length <= 6,
      `清单应有 4-6 条，实际 ${entries.length} 条`,
    );
    for (const key of ['description:', 'url:', 'region:']) {
      assert.equal(
        [...src.matchAll(new RegExp(`^\\s{4}${key}`, 'gm'))].length,
        entries.length,
        `有条目缺少 ${key}`,
      );
    }
  });

  test('只有 URL 是必填的：号码可选，核验不到就不写', () => {
    // phone 的行数可以少于条目数（不确定的号码宁可不给）。
    const phones = [...src.matchAll(/^\s{4}phone: /gm)].length;
    assert.ok(phones > 0, '一条号码都没有，清单就没用了');
    const urls = [...src.matchAll(/^\s{4}url: /gm)].length;
    assert.ok(phones <= urls, '号码数不可能多于条目数');
  });

  test('只用登录 + 员工档案，不要求尚未分配给任何角色的 workforce:care', () => {
    assert.match(src, /staffRequestContext\(request\)/);
    assert.doesNotMatch(src, /workforce:care/);
  });
});

// ---------------------------------------------------------------------------
// 6) 隐私偏好：按员工分片存进 settings.wellbeing
// ---------------------------------------------------------------------------

describe('staff preferences: per-staff slice of settings.wellbeing', () => {
  const src = stripComments(read(PREFERENCES_ROUTE));

  test('分片键是会话里的 staffId，客户端无法指定别人的偏好', () => {
    assert.match(src, /\[staffId\]: \{ \.\.\.ownPrefs, personal_data_opt_in: optIn \}/);
    assert.equal(
      searchParamNames(src).has('staff_id'),
      false,
      '偏好接口从查询参数读 staff_id 了',
    );
    // 请求体只允许这一个布尔字段，不得出现可指定的 staff id
    assert.equal(readsProperty(src, 'staff_id'), false);
  });

  test('非布尔值一律 400 —— 宽松解析会让"关"变成"开"', () => {
    assert.match(src, /typeof value === 'boolean' \? value : null/);
    assert.match(src, /personal_data_opt_in must be a boolean/);
    assert.match(src, /code: 'invalid_body'/);
  });

  test('默认关闭：不传 / 传非布尔值一律拿不到"已开启"', () => {
    // 路由里 readOptIn 只认 boolean。`undefined`（请求体没这个字段）走不通，
    // 因此默认值就是"关闭"，且不存在第二处默认值定义可以漂移。
    assert.match(src, /const optIn = readOptIn\(body\.personal_data_opt_in\);/);
    assert.match(src, /if \(optIn === null\) \{/);
    // 负向对照：改写成"缺省即 true"的实现不满足上面这条断言
    const broken = 'const optIn = body.personal_data_opt_in ?? true;';
    assert.equal(
      /const optIn = readOptIn\(body\.personal_data_opt_in\);/.test(broken),
      false,
      '负向对照失效：缺省即开启的实现被放行了',
    );
  });

  test('只更新 wellbeing 一列，不整行 upsert（否则会覆盖别人的设置）', () => {
    assert.match(src, /\.update\(\{ wellbeing: nextWellbeing/);
    assert.doesNotMatch(src, /\.upsert\(/, '整行 upsert 会用空对象覆盖 business/locale/model_assign');
  });

  test('未找到 settings 行时插入而不是静默成功', () => {
    assert.match(src, /\.insert\(\{ tenant_id: tenantId, business_id: businessId, wellbeing: nextWellbeing \}\)/);
  });

  test('走中央守卫，权限与审计 action 明确', () => {
    assert.match(
      src,
      /export const PATCH = protectBusinessMutation\(\s*\{\s*permission: 'workforce:self', action: 'workforce\.preferences', entity: 'settings' \},/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7) 迁移文件本身
//
// 注意：`scripts/migrate-workforce.sql` **不在** src/lib/migration.ts 的
// MIGRATION_FILE_LIST 里 —— 那个文件本次不允许改动。因此这里刻意不写
// "它必须在自动迁移清单里"的断言（会红），而是明确记录这个缺口，
// 由部署前手工应用或后续集中接入迁移链。
// ---------------------------------------------------------------------------

describe('workforce migration', () => {
  test('文件存在且两张表都建了', () => {
    assert.ok(existsSync(join(ROOT, MIGRATION)), `${MIGRATION} 不存在`);
    const sql = read(MIGRATION);
    assert.match(sql, /create table if not exists public\.staff_shifts/);
    assert.match(sql, /create table if not exists public\.staff_attendance/);
  });

  test('列定义与接口读写一致', () => {
    const sql = read(MIGRATION);
    for (const column of [
      'starts_at timestamptz not null',
      'ends_at timestamptz not null',
      'role varchar(60)',
      'note varchar(240)',
      'clock_in_at timestamptz not null default now()',
      'clock_out_at timestamptz',
      "clock_in_source varchar(20) not null default 'staff_pwa'",
    ]) {
      assert.ok(sql.includes(column), `迁移里缺少列定义：${column}`);
    }
    assert.match(
      sql,
      /create index if not exists staff_shifts_window_idx\s+on public\.staff_shifts \(tenant_id, business_id, starts_at\)/,
    );
    assert.match(
      sql,
      /create index if not exists staff_attendance_staff_time_idx\s+on public\.staff_attendance \(tenant_id, business_id, staff_id, clock_in_at desc\)/,
    );
  });

  test('幂等：全部是 if not exists', () => {
    const sql = stripComments(read(MIGRATION));
    const creates = [...sql.matchAll(/create (?:table|unique index|index) (?!if not exists)/g)];
    assert.deepEqual(creates, [], '存在非幂等的 create 语句，重复执行会失败');
  });
});
