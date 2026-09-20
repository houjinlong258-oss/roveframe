import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSignals, DEFAULT_THRESHOLDS, type SignalInput } from '../src/lib/workforce-signals';
import { hasPermission } from '../src/lib/rbac';

/**
 * Phase 18 —— 老板端「员工 / 考勤 / 关怀」后端的守卫。
 *
 * ## 守的是什么
 *
 * 这一层的失败模式几乎全是**静默**的，而且其中一条比其它都严重：
 *
 *   1. **关怀记录的可见性规则被削弱。** 规则是"只有作者与当事人能读"，
 *      而 owner 的权限是 `['*']` —— 权限矩阵**无法**表达这条规则，
 *      它只能活在查询里。一旦有人"顺手"把查询简化成 `tenant_id + business_id`
 *      （那看起来与其它所有路由一致，code review 很容易放过），
 *      owner 就能读到全店的私密记录，而**没有任何错误、没有任何日志**。
 *      员工会先停止说真话，然后这个模块就死了。所以下面第 4 组是负向对照：
 *      一个只按 tenant/business 过滤的实现**必须**被判为不合规。
 *   2. 信号边界写错（5 天 vs 6 天、48h vs 48h+1min）→ 每天多出/漏掉待办。
 *      多出来的噪音会让老板不再看这个页面，漏掉的则让关怀从未发生。
 *   3. `signal_key` 的唯一索引丢了 → "每日计算"变成"每天各插一条"，
 *      同一个人同一件事堆成几十条。
 *   4. 补卡漏掉 reason 校验 → 工时证据被无声修改。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const STAFF_ID = 'staff-1';
const TODAY = '2026-09-10';
/** 2026-09-07 是周一 → 2026-W37；2026-09-06 是周日 → 2026-W36。 */
const WEEK_37_MONDAY = '2026-09-07';

function baseInput(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    staffId: STAFF_ID,
    staffName: '张三',
    birthday: null,
    hiredAt: null,
    shifts: [],
    attendance: [],
    today: TODAY,
    ...overrides,
  };
}

/** 造一条已完成的打卡记录（起 + 小时数）。 */
function punch(startIso: string, hours: number): { clock_in_at: string; clock_out_at: string } {
  const from = Date.parse(startIso);
  return {
    clock_in_at: new Date(from).toISOString(),
    clock_out_at: new Date(from + hours * 3_600_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1) computeSignals：六种信号都触发，且 signalKey 精确
// ---------------------------------------------------------------------------

describe('workforce signals: six kinds fire with exact signal keys', () => {
  const input = baseInput({
    // 1998-09-15 → 距离 2026-09-10 还有 5 天（在 7 天窗口内）
    birthday: '1998-09-15',
    // 2023-09-10 → 今天正好满 3 年（在 [1,3,5] 里）
    hiredAt: '2023-09-10',
    shifts: [
      // 2026-09-08 排了班，但那天没有任何打卡 → missing_punch
      { starts_at: '2026-09-08T09:00:00.000Z', ends_at: '2026-09-08T17:00:00.000Z' },
    ],
    attendance: [
      // 2026-09-01 ~ 09-06 连续 6 天 → rest（这一段全部落在 W36）
      punch('2026-09-01T09:00:00.000Z', 8),
      punch('2026-09-02T09:00:00.000Z', 8),
      // W36 合计 50.5 小时 —— 它不是"本周"，因此不产生 overtime（跨周不累计）
      punch('2026-09-03T09:00:00.000Z', 8),
      punch('2026-09-04T09:00:00.000Z', 10.5),
      punch('2026-09-05T09:00:00.000Z', 8),
      punch('2026-09-06T09:00:00.000Z', 8),
      // W37（09-07 起）：合计 10.5 + 10 + 10 + 12 + 12 = 54.5 小时 → overtime；
      // 09-07 是 10.5 小时 → long_shift；09-08 刻意没有打卡 → missing_punch
      punch('2026-09-07T08:00:00.000Z', 10.5),
      punch('2026-09-09T08:00:00.000Z', 10),
      punch('2026-09-10T08:00:00.000Z', 10),
      punch('2026-09-11T08:00:00.000Z', 12),
      punch('2026-09-12T08:00:00.000Z', 12),
    ],
  });

  const signals = computeSignals(input);

  test('六种 kind 全部出现', () => {
    const kinds = new Set(signals.map((signal) => signal.kind));
    assert.deepEqual(
      [...kinds].sort(),
      ['anniversary', 'birthday', 'long_shift', 'missing_punch', 'overtime', 'rest'],
    );
  });

  test('signalKey 精确（这是数据库唯一索引的去重键，不能漂移）', () => {
    const byKind = new Map(signals.map((signal) => [signal.kind, signal]));
    assert.equal(byKind.get('birthday')?.signalKey, `birthday:${STAFF_ID}:2026`);
    assert.equal(byKind.get('anniversary')?.signalKey, `anniversary:${STAFF_ID}:2026`);
    // 连续上班段是 09-01 ~ 09-07（09-08 没有打卡，段在那里断开）→ 跨 W36 与 W37，
    // 按周分桶各一条。这里逐个断言而不是只看第一条：漏掉任一周都是漏提醒。
    const restKeys = signals
      .filter((signal) => signal.kind === 'rest')
      .map((signal) => signal.signalKey)
      .sort();
    assert.deepEqual(restKeys, [`rest:${STAFF_ID}:2026-W36`, `rest:${STAFF_ID}:2026-W37`]);
    // 今天是 2026-09-10 → 2026-W37
    assert.equal(byKind.get('overtime')?.signalKey, `overtime:${STAFF_ID}:2026-W37`);
    // long_shift 有 4 条，逐个断言完整键集合（只断言一条会漏掉"两条同键被吞"的缺陷）
    assert.deepEqual(
      signals.filter((signal) => signal.kind === 'long_shift')
        .map((signal) => signal.signalKey)
        .sort(),
      [
        `long_shift:${STAFF_ID}:2026-09-04T09:00:00.000Z`,
        `long_shift:${STAFF_ID}:2026-09-07T08:00:00.000Z`,
        `long_shift:${STAFF_ID}:2026-09-11T08:00:00.000Z`,
        `long_shift:${STAFF_ID}:2026-09-12T08:00:00.000Z`,
      ].sort(),
    );
    assert.equal(byKind.get('missing_punch')?.signalKey, `missing_punch:${STAFF_ID}:2026-09-08`);
  });

  test('long_shift 只报超过阈值的那一次（10.5h / 12h 报，10h 恰好在线上不报）', () => {
    const longShifts = signals.filter((signal) => signal.kind === 'long_shift');
    // 09-04(10.5h) + 09-07(10.5h) + 09-11(12h) + 09-12(12h) = 4 条；10h 的两天不报
    assert.equal(longShifts.length, 4);
    // 每条长班次必须有不同的 key，否则会被唯一索引吞掉
    assert.equal(new Set(longShifts.map((signal) => signal.signalKey)).size, 4);
  });

  test('overtime 的措辞明确声明不用于薪资计算（硬规则的可查证据）', () => {
    const overtime = signals.find((signal) => signal.kind === 'overtime');
    assert.ok(overtime);
    assert.match(overtime.detail, /不用于薪资计算/);
  });

  test('missing_punch 的措辞是"请确认"，不是"缺勤/旷工"', () => {
    const missing = signals.find((signal) => signal.kind === 'missing_punch');
    assert.ok(missing);
    assert.match(missing.detail, /请与本人确认/);
    for (const banned of ['旷工', '缺勤', '扣']) {
      assert.equal(
        missing.detail.includes(banned), false,
        `missing_punch 详情出现了惩罚性措辞「${banned}」—— 信号只能是建议`,
      );
    }
  });

  test('重复计算得到完全相同的 key 集合（幂等的全部依据）', () => {
    const again = computeSignals(input);
    assert.deepEqual(
      again.map((signal) => signal.signalKey).sort(),
      signals.map((signal) => signal.signalKey).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2) rest 边界：5 天不触发，6 天触发
// ---------------------------------------------------------------------------

describe('workforce signals: rest streak boundary', () => {
  function streak(days: number): SignalInput {
    const attendance = [];
    for (let i = 0; i < days; i += 1) {
      // 从 2026-09-01 起连续 N 天，每天 8 小时
      const day = String(1 + i).padStart(2, '0');
      attendance.push(punch(`2026-09-${day}T09:00:00.000Z`, 8));
    }
    return baseInput({ attendance });
  }

  test('正好 5 天：不触发 rest', () => {
    const kinds = computeSignals(streak(5)).map((signal) => signal.kind);
    assert.equal(kinds.includes('rest'), false, '5 天连续上班不该触发（双休制门店会全是噪音）');
  });

  test('正好 6 天：触发 rest', () => {
    const rest = computeSignals(streak(6)).find((signal) => signal.kind === 'rest');
    assert.ok(rest, '6 天连续上班必须触发');
    // 09-01 ~ 09-06 全部落在 2026-W36
    assert.equal(rest.signalKey, `rest:${STAFF_ID}:2026-W36`);
  });

  test('第 6 天和第 7 天落在同一 ISO 周 → 只有一条待办（去重靠唯一索引）', () => {
    const six = computeSignals(streak(6)).filter((signal) => signal.kind === 'rest');
    const seven = computeSignals(streak(7)).filter((signal) => signal.kind === 'rest');
    // 6 天（09-01~09-06）与 7 天（09-01~09-07）都触发，但 W36 那一条必须同键 ——
    // 否则"连续上班期间每天重算"会让同一条待办不断以新键重复出现。
    assert.equal(six.length, 1);
    assert.equal(six[0].signalKey, `rest:${STAFF_ID}:2026-W36`);
    assert.ok(seven.some((signal) => signal.signalKey === `rest:${STAFF_ID}:2026-W36`));
  });

  test('跨周的连续上班按周分桶：W36 与 W37 各一条', () => {
    const attendance = [];
    for (let i = 0; i < 10; i += 1) {
      const day = new Date(Date.UTC(2026, 8, 1 + i));
      attendance.push(punch(`${day.toISOString().slice(0, 10)}T09:00:00.000Z`, 8));
    }
    const keys = computeSignals(baseInput({ attendance }))
      .filter((signal) => signal.kind === 'rest')
      .map((signal) => signal.signalKey)
      .sort();
    // 09-01~09-06 在 W36，09-07~09-10 在 W37 —— 只报一周等于漏掉一半
    assert.deepEqual(keys, [`rest:${STAFF_ID}:2026-W36`, `rest:${STAFF_ID}:2026-W37`]);
  });

  test('中间休一天就重新计数：4 天 + 休 1 天 + 4 天 不触发', () => {
    const input = baseInput({
      attendance: [
        punch('2026-09-01T09:00:00.000Z', 8),
        punch('2026-09-02T09:00:00.000Z', 8),
        punch('2026-09-03T09:00:00.000Z', 8),
        punch('2026-09-04T09:00:00.000Z', 8),
        // 09-05 休息
        punch('2026-09-06T09:00:00.000Z', 8),
        punch('2026-09-07T09:00:00.000Z', 8),
        punch('2026-09-08T09:00:00.000Z', 8),
        punch('2026-09-09T09:00:00.000Z', 8),
      ],
    });
    const kinds = computeSignals(input).map((signal) => signal.kind);
    assert.equal(kinds.includes('rest'), false, '最长连续段只有 4 天，不该触发');
  });

  test('阈值可配置：restStreakDays=3 时 3 天就触发', () => {
    const input = baseInput({
      attendance: [
        punch('2026-09-01T09:00:00.000Z', 8),
        punch('2026-09-02T09:00:00.000Z', 8),
        punch('2026-09-03T09:00:00.000Z', 8),
      ],
    });
    assert.equal(computeSignals(input).some((signal) => signal.kind === 'rest'), false);
    assert.equal(
      computeSignals(input, { ...DEFAULT_THRESHOLDS, restStreakDays: 3 })
        .some((signal) => signal.kind === 'rest'),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 3) overtime 边界：正好 48h 不触发，48h+1min 触发
// ---------------------------------------------------------------------------

describe('workforce signals: overtime boundary', () => {
  /** 周一 00:00 起连续 6 天、每天 8 小时 = 正好 48 小时，全部落在 2026-W37。 */
  function fortyEightHours(): SignalInput {
    return baseInput({
      attendance: [
        punch('2026-09-07T00:00:00.000Z', 8),
        punch('2026-09-08T00:00:00.000Z', 8),
        punch('2026-09-09T00:00:00.000Z', 8),
        punch('2026-09-10T00:00:00.000Z', 8),
        punch('2026-09-11T00:00:00.000Z', 8),
        punch('2026-09-12T00:00:00.000Z', 8),
      ],
    });
  }

  test('正好 48 小时：不触发 overtime', () => {
    const kinds = computeSignals(fortyEightHours()).map((signal) => signal.kind);
    assert.equal(kinds.includes('overtime'), false, '48 小时是"到达关注线"，不是"超过"');
  });

  test('48 小时 + 1 分钟：触发 overtime', () => {
    const input = fortyEightHours();
    // 把最后一条拉长 1 分钟
    const last = input.attendance[input.attendance.length - 1];
    const from = Date.parse(last.clock_in_at);
    input.attendance[input.attendance.length - 1] = {
      clock_in_at: last.clock_in_at,
      clock_out_at: new Date(from + 8 * 3_600_000 + 60_000).toISOString(),
    };
    const overtime = computeSignals(input).find((signal) => signal.kind === 'overtime');
    assert.ok(overtime, '超过阈值 1 分钟就必须触发');
    assert.equal(overtime.signalKey, `overtime:${STAFF_ID}:2026-W37`);
  });

  test('上周的工时不计入本周（跨周不重复累计）', () => {
    const input = baseInput({
      attendance: [
        // 全部在 2026-W36（08-31 ~ 09-06）
        punch('2026-09-01T00:00:00.000Z', 8),
        punch('2026-09-02T00:00:00.000Z', 8),
        punch('2026-09-03T00:00:00.000Z', 8),
        punch('2026-09-04T00:00:00.000Z', 8),
        punch('2026-09-05T00:00:00.000Z', 8),
        punch('2026-09-06T00:00:00.000Z', 8),
        punch('2026-09-07T00:00:00.000Z', 8),
        punch('2026-09-08T00:00:00.000Z', 8),
      ],
    });
    const overtime = computeSignals(input).find((signal) => signal.kind === 'overtime');
    // 本周只有 16 小时 → 不该报；若实现把上周的 48 小时也算进来就会误报
    assert.equal(overtime, undefined);
  });

  test('未签退的班次不计入工时（没有结束时间就没有时长）', () => {
    const input = baseInput({
      attendance: [
        { clock_in_at: '2026-09-07T00:00:00.000Z', clock_out_at: null },
      ],
    });
    const kinds = computeSignals(input).map((signal) => signal.kind);
    assert.equal(kinds.includes('overtime'), false);
    assert.equal(kinds.includes('long_shift'), false);
  });
});

// ---------------------------------------------------------------------------
// 4) 可见性规则 —— 本文件里最重要的一组
//
// 这一组不是"跑一下路由看返回什么"，而是直接读源码并断言**过滤条件本身**。
// 理由：可见性规则是行级所有权，它无法被权限矩阵表达、也无法被集成测试覆盖
// （测试环境里 owner 与员工恰好是不同的人，而线上最常见的就是同一个人）。
// 能可靠失败的东西是"查询里到底有没有那个条件"。
// ---------------------------------------------------------------------------

describe('care notes: visibility rule is enforced in the query, not by permissions', () => {
  const source = read('src/app/api/team/care/notes/route.ts');
  const code = stripComments(source);

  /** 取出 POST 的 handler 函数体，用来与"读取分支"区分开。 */
  function postHandlerBody(): string {
    const start = code.indexOf('async function createNote');
    assert.ok(start >= 0, '未能在 notes 路由里找到 createNote —— 代码结构已变，请更新本测试');
    const end = code.indexOf('\nexport const POST', start);
    assert.ok(end > start, '未能在 notes 路由里定位 createNote 的结尾');
    return code.slice(start, end);
  }

  /** GET 的读取分支 = 全文去掉 POST handler。 */
  const readBranch = code.slice(0, code.indexOf('async function createNote'));

  test('读取分支同时出现 author_user_id 与"记录所属 staff 关联到会话用户"的过滤', () => {
    assert.match(
      readBranch, /author_user_id/,
      '读取关怀记录的查询里没有 author_user_id —— 作者本人将读不到自己写的记录',
    );
    // 当事人分支有两种同样正确的写法：
    //   a) 先在 staff 表上解析出"我的 staff id"，再用 staff_id in (...) 过滤
    //   b) 用 PostgREST 的嵌套关系 staff.user_id = 会话 userId
    // 两者都要求出现 staff 表上的 user_id 与会话 userId 的比较。
    // 参数名可能是 `userId`（helper 形参）或 `context.userId`，两者都接受。
    const resolvesSubjectThroughStaff =
      /from\('staff'\)[\s\S]{0,300}?\.eq\('user_id',\s*(?:context\.)?userId\)/.test(readBranch);
    const nestedSubjectFilter = /staff[\s\S]{0,120}?user_id[\s\S]{0,40}?(?:context\.)?userId/.test(readBranch);
    assert.ok(
      resolvesSubjectThroughStaff || nestedSubjectFilter,
      '读取分支没有把「记录的当事人」与会话 userId 绑起来 —— '
      + '只按 tenant/business 过滤的查询会让 owner 读到全店的私密记录（而权限检查会一路绿灯）',
    );
  });

  test('读取分支必须按 tenant 与 business 收敛（可见性之外的基本隔离不能丢）', () => {
    assert.match(readBranch, /\.eq\('tenant_id',\s*context\.tenantId\)/);
    assert.match(readBranch, /\.eq\('business_id',\s*context\.businessId\)/);
  });

  test('作者只能来自会话：POST 不从请求体读 author_user_id', () => {
    const post = postHandlerBody();
    assert.match(post, /author_user_id:\s*context\.userId/);
    assert.doesNotMatch(
      post, /author_user_id:\s*body\./,
      'author_user_id 取自请求体 —— 等于允许把内容挂到别人名下，可见性规则立刻失效',
    );
  });

  test('每一次读取都写审计（隐私数据必须可查证）', () => {
    assert.match(code, /care\.notes\.read\.\$\{outcome\}/);
    assert.match(code, /writeRequiredAudit\(/);
    // 审计不得把 content 抄进去：审计表是更宽的可见面
    const auditCalls = code.match(/auditRead\([\s\S]*?\);/g) ?? [];
    for (const call of auditCalls) {
      assert.doesNotMatch(call, /content/, '审计条目里出现了 content —— 那会让隐私规则从审计表被绕过');
    }
  });

  // -------------------------------------------------------------------------
  // 负向对照：把过滤条件换成"只按 tenant/business"，上面的断言必须不成立。
  //
  // 没有这一条，上面的 test 只是"看起来在检查"：如果断言写成了恒真的形式
  // （例如只检查文件里出现过 'tenant_id'），任何实现都会通过。
  // -------------------------------------------------------------------------
  test('负向对照：只按 tenant/business 过滤的实现在同一组断言下必须失败', () => {
    const broken = stripComments(`
      import { NextResponse } from 'next/server';
      export async function GET(request: Request) {
        const context = { tenantId: 't', businessId: 'b', userId: 'u' };
        const { data } = await client
          .from('staff_care_notes')
          .select('id, staff_id, content, created_at')
          .eq('tenant_id', context.tenantId)
          .eq('business_id', context.businessId)
          .order('created_at', { ascending: false })
          .limit(200);
        return NextResponse.json({ notes: data ?? [] });
      }
    `);

    assert.match(broken, /\.eq\('tenant_id',\s*context\.tenantId\)/);
    assert.match(broken, /\.eq\('business_id',\s*context\.businessId\)/);
    // …但它必须过不了可见性那两条
    assert.doesNotMatch(broken, /author_user_id/);
    const resolvesSubjectThroughStaff =
      /from\('staff'\)[\s\S]{0,300}?\.eq\('user_id',\s*(?:context\.)?userId\)/.test(broken);
    const nestedSubjectFilter = /staff[\s\S]{0,120}?user_id[\s\S]{0,40}?(?:context\.)?userId/.test(broken);
    assert.equal(
      resolvesSubjectThroughStaff || nestedSubjectFilter, false,
      '只按 tenant/business 过滤的实现竟被认为满足了可见性规则 —— 这条守卫是假的',
    );
  });

  test('负向对照：删掉读取分支的 author_user_id 会让第一条断言变红', () => {
    const withoutAuthor = readBranch.replace(/author_user_id/g, 'x_removed_x');
    assert.doesNotMatch(withoutAuthor, /author_user_id/);
    assert.notEqual(withoutAuthor, readBranch, '替换没有生效，说明原文里其实没有 author_user_id');
  });

  test('owner 的 "*" 权限不能覆盖可见性规则（规则不经过权限矩阵）', () => {
    // owner 全权 —— 这不是 bug，而是必须的；同时说明"靠 requirePermission 拦不住 owner"
    assert.equal(hasPermission('owner', 'workforce:care'), true);
    assert.equal(hasPermission('owner', '*'), true);
    // 因此可见性只能在查询里强制：源码中必须存在这条注释所描述的实现
    assert.match(source, /权限矩阵/);
  });
});

// ---------------------------------------------------------------------------
// 5) 迁移：signal_key 唯一索引 + 幂等
// ---------------------------------------------------------------------------

describe('workforce care migration', () => {
  const sql = read('scripts/migrate-workforce-care.sql');

  test('staff_care_tasks 上的部分唯一索引存在且只约束非空 signal_key', () => {
    assert.match(
      sql,
      /create unique index if not exists staff_care_tasks_signal_key\s+on public\.staff_care_tasks \(tenant_id, business_id, signal_key\)\s+where signal_key is not null;/,
      '缺少这条唯一索引 → "每日计算"会变成"每天各插一条"，同一个人同一件事堆成几十条待办',
    );
  });

  test('两张表的建表语句都在，且是幂等的', () => {
    assert.match(sql, /create table if not exists public\.staff_care_notes/);
    assert.match(sql, /create table if not exists public\.staff_care_tasks/);
  });

  test('staff 的九个档案列都用 add column if not exists 补齐', () => {
    for (const column of [
      'phone', 'email', 'position', 'employment_type', 'hourly_rate',
      'hired_at', 'birthday', 'emergency_contact', 'status',
    ]) {
      assert.match(
        sql,
        new RegExp(`alter table public\\.staff add column if not exists ${column}\\b`),
        `staff.${column} 没有幂等的 add column 语句`,
      );
    }
  });

  test('两个非空状态列都带 default（否则已有行会被违反非空约束）', () => {
    assert.match(sql, /employment_type varchar\(20\) not null default 'full_time'/);
    assert.match(sql, /status varchar\(20\) not null default 'active'/);
  });

  test('关怀记录按 (tenant, business, staff, created_at desc) 建索引', () => {
    assert.match(
      sql,
      /create index if not exists staff_care_notes_subject_idx\s+on public\.staff_care_notes \(tenant_id, business_id, staff_id, created_at desc\)/,
    );
  });

  test('待办按 (tenant, business, status, due_at) 建索引', () => {
    assert.match(
      sql,
      /create index if not exists staff_care_tasks_open_idx\s+on public\.staff_care_tasks \(tenant_id, business_id, status, due_at\)/,
    );
  });

  test('迁移里没有破坏性语句（自动迁移不得做无界删除）', () => {
    assert.doesNotMatch(stripComments(sql), /\b(delete\s+from|truncate\s+table|drop\s+table)\b/i);
  });
});

// ---------------------------------------------------------------------------
// 6) 补卡：reason 必填
// ---------------------------------------------------------------------------

describe('attendance make-up punch', () => {
  const code = stripComments(read('src/app/api/team/attendance/route.ts'));

  test('缺少 reason 时返回 400', () => {
    assert.match(code, /reason is required for a retroactive punch/);
    assert.match(code, /code: 'reason_required'/);
    assert.match(code, /\{ status: 400 \}/);
  });

  test('空白 reason 也算缺失（trim 之后判空，而不是只判 undefined）', () => {
    assert.match(
      code,
      /typeof body\.reason === 'string' \? body\.reason\.trim\(\) : ''/,
      'reason 没有 trim —— 一个空输入框提交会被当成"已填写理由"',
    );
    assert.match(code, /if \(!reason\)/);
  });

  test('补卡走中央守卫，action 为 attendance.retroactive', () => {
    assert.match(code, /export const PATCH = protectBusinessMutation\(/);
    assert.match(code, /action: 'attendance\.retroactive'/);
    assert.match(code, /permission: 'workforce:manage'/);
  });

  test('补卡写入审计明细（before/after），审计失败即请求失败', () => {
    assert.match(code, /writeRequiredAudit\(/);
    assert.match(code, /action: 'attendance\.retroactive\.detail'/);
    assert.match(code, /before,/);
  });

  test("来源列被标记为 manager_fix（补卡与员工自助打卡可区分）", () => {
    assert.match(code, /clock_in_source: 'manager_fix'/);
  });

  test('负向对照：没有 reason 校验的实现在上面两条断言下失败', () => {
    const broken = stripComments(`
      export const PATCH = protectBusinessMutation(
        { permission: 'workforce:manage', action: 'attendance.retroactive', entity: 'staff_attendance' },
        async (request) => {
          const body = await request.json();
          await client.from('staff_attendance').update({ clock_in_at: body.clock_in_at }).eq('id', 'x');
          return NextResponse.json({ ok: true });
        },
      );
    `);
    assert.doesNotMatch(broken, /reason is required/);
  });
});

// ---------------------------------------------------------------------------
// 7) 路由契约：权限、中央守卫、公开路径
// ---------------------------------------------------------------------------

describe('team backend route contract', () => {
  test('三个写接口都用中央守卫并各自带 action', () => {
    const team = stripComments(read('src/app/api/team/route.ts'));
    assert.match(team, /export const POST = protectBusinessMutation\(/);
    assert.match(team, /export const PATCH = protectBusinessMutation\(/);
    assert.match(team, /permission: 'workforce:manage'/);

    const signals = stripComments(read('src/app/api/team/care/signals/route.ts'));
    assert.match(signals, /export const POST = protectBusinessMutation\(/);
    assert.match(signals, /permission: 'workforce:care'/);

    const invite = stripComments(read('src/app/api/team/invite/route.ts'));
    assert.match(invite, /export const POST = protectBusinessMutation\(/);
  });

  test('关怀待办的插入带 onConflict（靠唯一索引去重，而不是先查再插）', () => {
    const signals = stripComments(read('src/app/api/team/care/signals/route.ts'));
    assert.match(signals, /onConflict: 'tenant_id,business_id,signal_key'/);
    assert.match(signals, /ignoreDuplicates: true/);
  });

  test('决定待办是单条带条件的 UPDATE（status = open 挂在链上）', () => {
    const code = stripComments(read('src/app/api/team/care/tasks/[id]/route.ts'));
    const updateIndex = code.indexOf('.update(');
    const openIndex = code.indexOf(".eq('status', 'open')");
    assert.ok(updateIndex > 0 && openIndex > updateIndex, 'status 过滤必须挂在 update 链上，不能是先查再改');
  });

  test('workforce:care 授予 owner 与 manager，staff 拿不到（fail-closed）', () => {
    // 之前这条钉的是"manager 拿不到 workforce:care" —— 那是当时 rbac.ts 的真实状态，
    // 但它是**遗漏而不是设计**：店长本来就要做员工关怀（谈心、生日福利），
    // 拿不到权限的话这个模块在真实门店里只有老板一个人能用，等于没人用。
    // 现在 rbac.ts 已补上该权限，测试随之更新为设计意图。
    //
    // 注意：这条权限只决定"能不能进关怀模块"。**关怀记录的内容**另有行级规则
    // （只有作者与当事人可读），owner 的 '*' 也覆盖不了 —— 见下面的可见性测试。
    assert.equal(hasPermission('owner', 'workforce:care'), true);
    assert.equal(hasPermission('manager', 'workforce:care'), true);
    assert.equal(hasPermission('staff', 'workforce:care'), false);
    assert.equal(hasPermission('manager', 'workforce:manage'), true);
  });

  test('新增的四个端点都不是公开路径', async () => {
    const mod = await import('../src/lib/auth-guard');
    for (const path of [
      '/api/team',
      '/api/team/attendance',
      '/api/team/care/signals',
      '/api/team/care/notes',
      '/api/team/care/resources',
      '/api/team/care/tasks/abc',
      '/api/team/invite',
    ]) {
      assert.equal(mod.isPublicApiPath(path), false, `${path} 不得是公开路径`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8) 邀请：不得返回 null 链接，也不得重复既有路由的缺陷
// ---------------------------------------------------------------------------

describe('team invite route', () => {
  const code = stripComments(read('src/app/api/team/invite/route.ts'));

  test('写入了 app_metadata.tenant_id（鉴权链唯一读取的地方）', () => {
    assert.match(
      code, /app_metadata:\s*\{[\s\S]{0,120}?tenant_id: context\.tenantId/,
      '没有写 app_metadata.tenant_id —— 被邀请人将"能设密码但每个请求 401"',
    );
    assert.match(code, /updateUserById\(/);
  });

  test('返回前校验三步都成功（链接 / 声明 / 占位行），任一步失败即明确报错', () => {
    assert.match(code, /claim_write_failed/);
    assert.match(code, /placeholder_failed|email_already_registered/);
    assert.match(code, /link_failed/);
  });

  test('invite_url 不是字面量 null，也不靠 fallback 造一个假链接', () => {
    assert.doesNotMatch(code, /invite_url:\s*null/);
    assert.match(code, /invite_url:/);
  });

  test('staff 必须属于本次会话的门店（不能给别店员工发邀请）', () => {
    assert.match(code, /\.eq\('tenant_id', context\.tenantId\)/);
    assert.match(code, /\.eq\('business_id', context\.businessId\)/);
  });

  test('角色固定为 staff：邀请接口不能用来提权', () => {
    assert.match(code, /const STAFF_ROLE = 'staff'/);
    assert.doesNotMatch(code, /body\.role/, '邀请接口从请求体读 role —— 等于把提权做成一个 POST 参数');
  });
});
