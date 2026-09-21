import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALWAYS_AVAILABLE_STAFF_ENDPOINTS,
  DEFAULT_STAFF_ACCESS,
  featureDisabledResponse,
  normalizeStaffAccess,
  readStaffAccess,
  staffAccessSlice,
  type StaffAccessSettingsRow,
} from '../src/lib/staff-access';

/**
 * 商家侧员工功能开关（老板可配）的守卫。
 *
 * ## 这一层守的是什么
 *
 * 两条轴必须一直分得开：RBAC 回答"这个角色允许做什么"，商家开关回答"这家店愿意
 * 开放哪些"。最容易出的两类事故是：
 *
 *   1. **把开关接到了员工自身数据权利的接口上**（我的档案 / 考勤 / 排班 / 数据导出 /
 *      隐私开关）。那等于让老板一键关掉员工查看自己工时与导出自己数据的通道 ——
 *      它不是产品选项，是合规义务。所以这里用**源码级**断言守住"那几个路由里
 *      根本不调用本模块"，并给每条断言配一个"确实违规"的合成反例。
 *   2. **把默认值写成 fail-closed**（缺键 = 全关）。老库里没有这个键，一次部署就会
 *      让全店点不了"接单"、确认不了预订，且没有任何报错。默认值是产品决策，
 *      不是安全决策 —— 安全边界是 RBAC。
 *
 * 断言分两类：**行为**（真的调用函数，验默认值与 403 响应形态）与**源码**
 * （验"哪条路由不许调用它"）。行为断言优先，因为它不依赖正则写得对。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** 去掉注释：注释里出现某个词不算通过（断言的是代码，不是说明）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 本模块在路由里的调用形态。少写一个名字，守卫就漏一条路。 */
const FEATURE_HELPER_MATCHER = /requireStaffFeature|isStaffFeatureEnabled|readStaffAccess|staff-access/;

/**
 * 同一条 matcher 既要命中真实源码，又要拒绝合成反例 —— 少了后半句，
 * 断言就是空的（正则写成永远为真的空模式也能"通过"）。
 */
function assertContract(label: string, source: string, matcher: RegExp, counterExample: string): void {
  assert.match(source, matcher, `${label}：真实源码未命中 ${String(matcher)}`);
  assert.doesNotMatch(
    counterExample,
    matcher,
    `${label}：合成反例没有被同一条 matcher 拒绝 —— 这条断言是空的`,
  );
}

/**
 * 反向契约：某段代码**必须不出现**。
 * 反例是"必须被抓住的那种写法"，它必须命中同一条 matcher，
 * 否则这条禁令就是一句永远成立的废话。
 */
function assertForbidden(label: string, source: string, matcher: RegExp, counterExample: string): void {
  assert.doesNotMatch(source, matcher, `${label}：真实源码里出现了 ${String(matcher)}`);
  assert.match(
    counterExample,
    matcher,
    `${label}：这条禁令的合成反例没有被同一 matcher 命中 —— 禁令本身是坏的`,
  );
}

/** 构造一个"注入式" settings 行读取器（与路由里的测试缝同一形态）。 */
function rowLoader(
  wellbeing: unknown,
  id = 'settings-row-1',
): () => Promise<StaffAccessSettingsRow | null> {
  return async () => ({ id, wellbeing });
}

// ---------------------------------------------------------------------------
// 1) 不可关闭的员工自身数据权利：路由里根本不调用本模块
// ---------------------------------------------------------------------------

describe('staff access: 员工自身数据权利的路由不接这个开关', () => {
  const ALWAYS_ON_ROUTES = [
    'src/app/api/staff/me/route.ts',
    'src/app/api/staff/attendance/route.ts',
    'src/app/api/staff/shifts/route.ts',
    'src/app/api/staff/export/route.ts',
    'src/app/api/staff/preferences/route.ts',
  ];

  /** 反例：一段"确实把开关接上去了"的路由实现。 */
  const COUNTER_EXAMPLE = `
    import { requireStaffFeature } from '@/lib/staff-access';
    export async function GET(request: NextRequest) {
      const gate = await requireStaffFeature(tenantId, businessId, 'delivery');
      if (gate) return gate;
      return NextResponse.json({ data: 'my own attendance' });
    }
  `;

  test('五条常开路由（me / attendance / shifts / export / preferences）一条都不含开关调用', () => {
    for (const route of ALWAYS_ON_ROUTES) {
      const source = stripComments(read(route));
      assert.equal(
        FEATURE_HELPER_MATCHER.test(source),
        false,
        `${route} 调用了商家功能开关 —— 员工本人的数据权利不是商家可关闭的功能`,
      );
    }
    // 反例必须被同一条 matcher 抓住，否则上面的"都不含"毫无意义。
    assert.match(
      COUNTER_EXAMPLE,
      FEATURE_HELPER_MATCHER,
      '反例没有被 matcher 命中，说明 matcher 是坏的（那上面五条断言就是空的）',
    );
  });

  test('常开清单与源码一致（清单少一条，测试就会漏守一条路由）', () => {
    assert.deepEqual(
      [...ALWAYS_AVAILABLE_STAFF_ENDPOINTS].sort(),
      [
        '/api/staff/attendance',
        '/api/staff/export',
        '/api/staff/me',
        '/api/staff/preferences',
        '/api/staff/shifts',
      ],
      '常开接口清单变了 —— 请同时更新本测试的 ALWAYS_ON_ROUTES',
    );
  });

  test('可开关的三条路由**必须**接上开关（正向对照）', () => {
    const gated: [string, RegExp][] = [
      ['src/app/api/staff/deliveries/route.ts', /requireStaffFeature\(tenantId, businessId, 'delivery'\)/],
      ['src/app/api/staff/deliveries/claim/route.ts', /requireStaffFeature\(context\.tenantId, context\.businessId, 'delivery'\)/],
      ['src/app/api/staff/deliveries/[id]/status/route.ts', /requireStaffFeature\(context\.tenantId, context\.businessId, 'delivery'\)/],
      ['src/app/api/staff/deliveries/[id]/position/route.ts', /requireStaffFeature\(context\.tenantId, context\.businessId, 'delivery'\)/],
      ['src/app/api/staff/reservations/route.ts', /requireStaffFeature\(tenantId, businessId, 'reservations'\)/],
      ['src/app/api/staff/reservations/[id]/confirm/route.ts', /requireStaffFeature\(tenantId, businessId, 'reservations'\)/],
      ['src/app/api/staff/care-resources/route.ts', /requireStaffFeature\(resolved\.ctx\.tenantId, resolved\.ctx\.businessId, 'care'\)/],
    ];
    for (const [route, matcher] of gated) {
      assertContract(
        `开关接线 ${route}`,
        stripComments(read(route)),
        matcher,
        'export async function GET() { return NextResponse.json({ pending: [], mine: [] }); }',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2) 默认值：缺键走默认，垃圾值**绝不**变成 true
// ---------------------------------------------------------------------------

describe('staff access: 默认值与非法值', () => {
  test('默认值是 delivery/reservations 开、care 关（fail-open 是刻意的）', () => {
    assert.deepEqual(DEFAULT_STAFF_ACCESS, {
      delivery: true,
      reservations: true,
      care: false,
    });
  });

  test('缺 settings 行 / 缺 wellbeing / wellbeing 是垃圾 → 一律默认值', async () => {
    const missing: unknown[] = [undefined, null, {}, [], ['x'], 'wellbeing', 0, true];
    for (const wellbeing of missing) {
      const access = await readStaffAccess('t-1', 'b-1', rowLoader(wellbeing));
      assert.deepEqual(
        access,
        DEFAULT_STAFF_ACCESS,
        `wellbeing=${JSON.stringify(wellbeing)} 必须落回默认值`,
      );
    }
  });

  test('缺 settings 行（loader 返回 null）同样是默认值，不是"全关"', async () => {
    const access = await readStaffAccess('t-1', 'b-1', async () => null);
    assert.deepEqual(access, DEFAULT_STAFF_ACCESS);
    assert.equal(access.delivery, true, '缺行即全关会让老库上的外卖功能直接停摆');
  });

  test('非布尔值一律按"没给"处理，care 的垃圾值永远不是 true', async () => {
    const access = await readStaffAccess('t-1', 'b-1', rowLoader({
      staff_access: { delivery: 'false', reservations: 1, care: 'true' },
    }));
    assert.equal(access.delivery, true, '字符串 "false" 必须落回默认（不是解析成 false）');
    assert.equal(access.reservations, true, '数字 1 必须落回默认');
    assert.equal(access.care, false, '字符串 "true" 绝不能把关怀打开');
  });

  test('显式布尔值被尊重（默认值不覆盖商家真的设置）', async () => {
    const access = await readStaffAccess('t-1', 'b-1', rowLoader({
      staff_access: { delivery: false, reservations: false, care: true },
    }));
    assert.deepEqual(access, { delivery: false, reservations: false, care: true });
  });

  test('只给一个键时，其余键取默认值（三个键始终齐全）', () => {
    assert.deepEqual(normalizeStaffAccess({ care: true }), {
      delivery: true,
      reservations: true,
      care: true,
    });
    assert.deepEqual(normalizeStaffAccess({ delivery: false }), {
      delivery: false,
      reservations: true,
      care: false,
    });
  });

  test('读失败必须抛错，不能静默回落到默认值', async () => {
    await assert.rejects(
      readStaffAccess('t-1', 'b-1', async () => {
        throw new Error('settings read failed: connection reset');
      }),
      /settings read failed/,
      '库读失败被吞掉了 —— 那会把"不知道"伪装成"商家关掉了"',
    );
  });

  test('切片保留兄弟键：staff_prefs 与 wellbeing 的其他配置不会被这一笔写丢', () => {
    const slice = staffAccessSlice({
      staff_prefs: { 'staff-1': { personal_data_opt_in: true } },
      timezone: 'Asia/Shanghai',
      staff_access: { care: true },
    });
    assert.deepEqual(slice.wellbeing.staff_prefs, {
      'staff-1': { personal_data_opt_in: true },
    });
    assert.equal(slice.wellbeing.timezone, 'Asia/Shanghai');
    assert.equal(slice.staffAccess.care, true);
  });
});

// ---------------------------------------------------------------------------
// 3) 关掉时是 403 + feature_disabled（不是 404，也不是空列表）
// ---------------------------------------------------------------------------

describe('staff access: 关闭语义', () => {
  test('featureDisabledResponse 是 403，且带 code: feature_disabled', async () => {
    for (const feature of ['delivery', 'reservations', 'care'] as const) {
      const response = featureDisabledResponse(feature);
      assert.equal(response.status, 403, `${feature} 被关掉时必须 403`);
      // 负向对照：403 不是这几个"别的语义"。
      assert.notEqual(response.status, 404, '404 会被读成"这条记录不存在"');
      assert.notEqual(response.status, 200, '200 + 空列表会让员工以为"今天没有单"');
      const body = (await response.json()) as { code?: string; feature?: string };
      assert.equal(body.code, 'feature_disabled');
      assert.equal(body.feature, feature);
    }
  });

  test('源码里 403 与 code 是同一个响应对象给出的（不是两处拼接）', () => {
    const source = stripComments(read('src/lib/staff-access.ts'));
    assertContract(
      '403 响应形态',
      source,
      /code: 'feature_disabled',\s*\n\s*feature,\s*\n\s*\},\s*\n\s*\{ status: 403 \}/,
      "return NextResponse.json({ pending: [], mine: [] });",
    );
  });

  test('老板端写接口走中央守卫（workforce:manage + 审计 action）', () => {
    const source = stripComments(read('src/app/api/team/staff-access/route.ts'));
    assert.match(source, /export const PATCH = protectBusinessMutation\(/);
    assert.match(source, /permission: 'workforce:manage'/);
    assert.match(source, /action: 'staff\.access\.update'/);
    // 读接口也必须要求权限 —— 否则员工端能读到本店的配置（虽然不敏感，但语义不对）。
    assert.match(source, /requirePermission\(context, 'workforce:manage'\)/);
    // 负向对照：一个不查权限的读接口必须被同一条断言拒绝。
    const counterExample = "export async function GET() { return NextResponse.json({ staff_access: {} }); }";
    assert.doesNotMatch(counterExample, /requirePermission\(context, 'workforce:manage'\)/);
  });

  test('写入只更新 wellbeing 一列（绝不整行 upsert，否则会覆盖别人的设置）', () => {
    const source = stripComments(read('src/lib/staff-access.ts'));
    assert.match(source, /\.update\(\{ wellbeing: nextWellbeing/);
    assert.match(source, /const nextWellbeing = \{\s*\n\s*\.\.\.wellbeing,\s*\n\s*staff_access:/);
    // 负向对照：整行覆盖的写法必须被同一条 matcher 拒绝。
    assertForbidden(
      '禁止整行 upsert',
      source,
      /\.upsert\(\{\s*\n\s*wellbeing:/,
      "await client.from('settings').upsert({\n  wellbeing: {},\n  business: {},\n});",
    );
  });
});
