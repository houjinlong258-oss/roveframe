import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 —— 员工端 / 老板端 PWA 落地的守卫。
 *
 * ## 守的是什么
 *
 * 这次是把原型（_pwa-review）的 staff + owner 两个 tier 搬进 Next.js。
 * 与顾客端那次（tests/pwa-tier.test.ts）同一形态：搬运动作几乎全是**静默**的，
 * 构建不会响、ts-check 也不会响，只有运行时才炸或者只有顾客/员工看得见。
 *
 *   1. 抄漏 `'use client';` → 页面按服务端组件渲染，里面全是 useState/onClick，
 *      报错只出现在浏览器控制台，构建照样通过。
 *   2. 抄回 `from 'motion/react'` → 仓库没有这个依赖（零新增依赖），
 *      模块找不到只在运行时暴露。
 *   3. `import.meta.env` 是 Vite 写法：Next 客户端只内联
 *      `process.env.NEXT_PUBLIC_*`，`import.meta.env` 会静默变成 undefined。
 *   4. **后厨照片上传**整条链路是编的：4 个写死的 Unsplash 图库 URL、
 *      没有文件输入、上传者自己写 `verified: true`、后端 501。
 *      它一旦被挂回渲染树，员工"拍照上传"的东西会出现在顾客端的
 *      「一键看后厨」里 —— 那是在伪造食品安全公示。
 *   5. 老板端的 dashboard / analytics / simulations 三个 Tab 整块是字面量
 *      （固定的日期、金额、柱状高度数组、热门菜品）。它们若回到
 *      `/{locale}/team`，店长会拿编造的数字做经营判断。仓库里已经有一个
 *      **真实**的经营仪表盘，那才是这些数字该来的地方。
 *   6. 原型那个假登录页（`isAuthenticated` 初值 true、预填演示邮箱、
 *      `// Simulate login`）与两个不存在的方法
 *      （`staffApi.exportStaffData` / `bossApi.resetAllDemoData`）。
 *
 * ## 负向对照
 *
 * 每个 checker 都在 `负向对照` 一节用**合成源码**证明它真的会命中。
 * 没有这一步，"0 命中"可能只是 checker 写错了（正则写歪、剥注释剥过头）。
 * 对照里用的字符串是**故意写进来的**，它们只存在于本测试文件中，
 * 不属于任何被搬运的组件。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** 去掉注释再查，避免把"解释为什么不这么做"的注释误报成违规。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 首个非空行（去掉首尾空白）。`'use client';` 必须是它。 */
function firstNonEmptyLine(src: string): string | undefined {
  return src
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// 0) 本次搬运的文件清单
// ---------------------------------------------------------------------------

/** 本次搬运的 4 个组件（原型 → 仓库）。 */
const PORTED_COMPONENTS = [
  'src/components/staff/StaffPwa.tsx',
  'src/components/staff/StaffShell.tsx',
  'src/components/staff/KitchenPhotoUploadModal.tsx',
  'src/components/owner/OwnerPortal.tsx',
] as const;

/** 本次新增的两个路由页面（不是"搬运"，但同样必须守）。 */
const ROUTE_PAGES = ['src/app/[locale]/staff/page.tsx', 'src/app/[locale]/team/page.tsx'] as const;

// ---------------------------------------------------------------------------
// 1) checker：被搬运的文件里不允许出现的东西
// ---------------------------------------------------------------------------

/**
 * 返回源码里命中的禁用形态（空数组 = 干净）。
 * 故意做成"返回违规列表"而不是"直接 assert"：负向对照要能拿到列表。
 */
function findForbidden(source: string): string[] {
  const code = stripComments(source);
  const rules: { label: string; pattern: RegExp }[] = [
    { label: 'motion/react 依赖', pattern: /from\s+['"]motion\/react['"]/ },
    { label: 'motion 组件', pattern: /<motion\./ },
    { label: 'AnimatePresence', pattern: /<AnimatePresence/ },
    { label: 'Google Maps 包', pattern: /from\s+['"]@googlemaps\// },
    { label: 'google.maps 全局', pattern: /google\.maps/ },
    { label: 'import.meta.env', pattern: /import\.meta\.env/ },
  ];
  return rules.filter((rule) => rule.pattern.test(code)).map((rule) => rule.label);
}

describe('pwa tier (staff/owner): 搬运后的组件不允许出现的形态', () => {
  for (const rel of PORTED_COMPONENTS) {
    test(`${rel} 不含 motion / Google Maps / import.meta.env`, () => {
      const source = read(rel);
      assert.deepEqual(findForbidden(source), [], `${rel} 命中了禁用形态`);
    });
  }

  test("每一个搬运组件的首个非空行都是 'use client';", () => {
    for (const rel of PORTED_COMPONENTS) {
      assert.equal(
        firstNonEmptyLine(read(rel)),
        `'use client';`,
        `${rel} 的首个非空行不是 'use client';`,
      );
    }
  });

  test('两个路由页面都是服务端组件（首行不是 use client，且 await 过 params）', () => {
    for (const rel of ROUTE_PAGES) {
      const page = read(rel);
      assert.notEqual(firstNonEmptyLine(page), `'use client';`, `${rel} 变成了客户端组件`);
      assert.match(page, /await params/, `${rel} 没有 await params`);
      assert.match(page, /hasLocale\(routing\.locales, locale\)/, `${rel} 没有校验 locale 段`);
    }
  });

  test('package.json 没有引入 motion / @googlemaps（零新增依赖）', () => {
    const pkg = read('package.json');
    assert.equal(/motion/.test(pkg), false, 'package.json 里出现了 motion —— 不允许新增该依赖');
    assert.equal(/@googlemaps/.test(pkg), false, 'package.json 里出现了 @googlemaps —— 不允许新增该依赖');
  });
});

// ---------------------------------------------------------------------------
// 2) checker：写死的演示字面量
// ---------------------------------------------------------------------------

/**
 * 原型里写死的、必须**一个都不留**的字面量。
 *
 * 这一条**故意不剥注释**：文件头的"为什么要去掉"极容易写成把原值再抄一遍，
 * 而抄一遍之后 grep 就无法区分"解释"和"还在用"。要求注释也不得出现这些值，
 * 才是可被机械检查的规则。
 */
const MOCK_LITERALS = [
  '386,560', // 老板端 analytics 的写死月营业额
  '¥ 12,560', // 老板端 dashboard 的写死日营业额
  '张总', // 老板端 dashboard 的写死称呼
  'Elena Rostova', // 员工端的写死占位姓名
  'elena@grovebistro.com', // 员工端假登录页的预填账号
  'Grove Bistro', // 原型里写死的演示店名
] as const;

function findMockLiterals(source: string): string[] {
  return MOCK_LITERALS.filter((token) => source.includes(token));
}

/**
 * 可能不存在的方法：原型调用过它们，而当时的 `src/lib/api.ts` 里没有。
 *
 * 2026-09 更新：`exportStaffData` 已经**真实落地**
 * （`src/lib/api.ts` 的 `staffApi.exportStaffData()` + `GET /api/staff/export`），
 * 因此它不再是幽灵方法；`resetAllDemoData` 仍然是。
 *
 * 关键改动：判据不能是这份手写清单本身 —— 清单会漂移（方法补上了，清单没改，
 * 于是断言开始冤枉正确的代码；或者反过来，方法删了，清单没改，断言永远通过）。
 * 现在改成**对着 api 源判**：一个 token 只有在"组件里出现、api 源里查不到"时
 * 才算幽灵。谁补上方法，谁就自动从幽灵名单里出去。
 */
const PHANTOM_CANDIDATES = ['exportStaffData', 'resetAllDemoData'] as const;

function findPhantomMethods(componentSource: string, apiSource: string): string[] {
  const component = stripComments(componentSource);
  const api = stripComments(apiSource);
  return PHANTOM_CANDIDATES.filter((token) => component.includes(token) && !api.includes(token));
}

/** 真实 api 源：所有"组件里调了、api 里没有"的判断都以它为准。 */
const API_SOURCE = read('src/lib/api.ts');

/** 假登录页的标记：本地布尔值冒充身份，不调任何接口。 */
const FAKE_AUTH_MARKERS = [
  'isAuthenticated',
  'simulate409StaffNotLinked',
  'setLoginPassword',
  'loginEmail',
] as const;

function findFakeAuth(source: string): string[] {
  return FAKE_AUTH_MARKERS.filter((token) => stripComments(source).includes(token));
}

describe('pwa tier (staff/owner): 不把演示数据搬回渲染树', () => {
  for (const rel of [...PORTED_COMPONENTS, ...ROUTE_PAGES]) {
    test(`${rel} 不含写死的演示字面量`, () => {
      assert.deepEqual(findMockLiterals(read(rel)), [], `${rel} 仍在渲染演示数据`);
    });
  }

  test('员工端不再有假登录页，也不再调用不存在的方法', () => {
    const staff = read('src/components/staff/StaffPwa.tsx');
    assert.deepEqual(findFakeAuth(staff), [], 'StaffPwa 里仍有假登录状态');
    assert.deepEqual(
      findPhantomMethods(staff, API_SOURCE),
      [],
      'StaffPwa 仍在调用 src/lib/api.ts 里不存在的方法',
    );
  });

  test('老板端不再调用不存在的方法', () => {
    assert.deepEqual(
      findPhantomMethods(read('src/components/owner/OwnerPortal.tsx'), API_SOURCE),
      [],
      'OwnerPortal 仍在调用 src/lib/api.ts 里不存在的方法',
    );
  });

  test('导出方法确实存在于 api 源（否则上面两条会因"清单脱节"而失真）', () => {
    // 阳性对照：这是 findPhantomMethods 现在依赖的事实本身。
    const api = stripComments(API_SOURCE);
    assert.ok(api.includes('exportStaffData'), 'src/lib/api.ts 里没有 exportStaffData');
    assert.match(api, /async exportStaffData\(\): Promise<StaffDataExport>/);
    // 反向：另一个候选确实仍然不存在
    assert.equal(api.includes('resetAllDemoData'), false, 'resetAllDemoData 不该出现在 api 里');
  });
});

// ---------------------------------------------------------------------------
// 3) 后厨照片上传：文件保留，但不许回到渲染树
// ---------------------------------------------------------------------------

const KITCHEN_WIRING_TOKENS = [
  'KitchenPhotoUploadModal',
  'KitchenInspectionModal',
  'kitchenPhotos',
  'showKitchenUpload',
  'showKitchenInspection',
  'uploadKitchenPhoto',
  '阳光透明后厨',
] as const;

function findKitchenWiring(source: string): string[] {
  const code = stripComments(source);
  return KITCHEN_WIRING_TOKENS.filter((token) => code.includes(token));
}

describe('pwa tier (staff/owner): 后厨照片上传不接入渲染树', () => {
  const staff = read('src/components/staff/StaffPwa.tsx');

  test('StaffPwa 不渲染 KitchenPhotoUploadModal / KitchenInspectionModal', () => {
    // 注释里提到这两个名字是允许的（"为什么摘掉"必须写清楚），
    // 所以这一条按 stripComments 之后的**代码**判。
    assert.deepEqual(findKitchenWiring(staff), [], 'StaffPwa 仍把后厨上传/巡检接在渲染树上');
  });

  test('StaffPwa 里没有 JSX 渲染（负向证据：只出现在注释里不算命中）', () => {
    // 直接证明上一条不是"正则写歪了"：注释里的名字确实存在，但代码里没有。
    assert.ok(
      staff.includes('KitchenPhotoUploadModal'),
      'StaffPwa 的文件头应当解释为什么摘掉后厨上传（注释里应出现该名字）',
    );
    assert.equal(
      stripComments(staff).includes('<KitchenPhotoUploadModal'),
      false,
      'StaffPwa 重新渲染了后厨上传弹窗',
    );
  });

  test('组件文件本身保留，且文件头写清楚为什么没挂载', () => {
    const modal = read('src/components/staff/KitchenPhotoUploadModal.tsx');
    assert.match(modal, /export const KitchenPhotoUploadModal/);
    // 保留文件不等于保留假数据：三条理由必须写在文件头里。
    assert.ok(modal.includes('上传者自己给自己发合格证'), '文件头没有写"上传者自签 verified"这一条');
    assert.ok(modal.includes('不存在'), '文件头没有写"没有文件输入"这一条');
    assert.ok(modal.includes('501'), '文件头没有写"后端不存在（501）"这一条');
  });

  test('员工端没有数据来源的入口也不再渲染空列表卡片', () => {
    const code = stripComments(staff);
    for (const token of ['拍照上传后厨', '巡查公示', '实时已公示', 'staff-upload-kitchen-btn']) {
      assert.equal(code.includes(token), false, `StaffPwa 仍残留后厨入口：${token}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4) 老板端：只挂 team + 考勤 + care，不挂 dashboard / analytics / simulations
// ---------------------------------------------------------------------------

/** 只属于被移除的四个 Tab 的标记（`rf-owner*` 这个前缀本身是保留的）。 */
const REMOVED_OWNER_TAB_TOKENS = [
  'rf-owner-dashboard',
  'rf-owner-welcome',
  'rf-revenue-card',
  'rf-owner-kpis',
  'rf-owner-analytics',
  'rf-analytics-total',
  'rf-analytics-chart',
  'rf-top-dishes',
  '热门菜品',
  'BUSINESS ANALYTICS',
  'owner-tab-dashboard',
  'owner-tab-analytics',
  'owner-tab-simulations',
  'owner-tab-config',
  "'dashboard'",
  "'analytics'",
  "'simulations'",
  "'config'",
] as const;

function findRemovedOwnerTabs(source: string): string[] {
  const code = stripComments(source);
  return REMOVED_OWNER_TAB_TOKENS.filter((token) => code.includes(token));
}

describe('pwa tier (staff/owner): 老板端只挂真实数据的三个面', () => {
  const portalPath = 'src/components/owner/OwnerPortal.tsx';
  const routePath = 'src/app/[locale]/team/page.tsx';

  test('OwnerTab 只剩 team / shifts / care 三个值', () => {
    assert.match(
      read(portalPath),
      /export type OwnerTab = 'team' \| 'shifts' \| 'care';/,
      'OwnerTab 的取值集合变了 —— dashboard/analytics/simulations/config 不该回来',
    );
  });

  test('OwnerPortal 不含 dashboard / analytics / simulations / config 的任何标记', () => {
    assert.deepEqual(findRemovedOwnerTabs(read(portalPath)), [], 'OwnerPortal 里还有被移除的 Tab');
  });

  test('owner 路由挂的是 OwnerPortal，且自身不含 mock analytics', () => {
    const page = read(routePath);
    assert.match(
      page,
      /import\s*\{\s*OwnerPortal\s*\}\s*from\s*'@\/components\/owner\/OwnerPortal'/,
      'team 页面没有 import OwnerPortal',
    );
    assert.match(page, /<OwnerPortal/, 'team 页面没有渲染 OwnerPortal');
    assert.deepEqual(findRemovedOwnerTabs(page), [], 'team 页面里出现了 mock analytics 的标记');
  });

  test('三个面都走真实的 bossApi（不是本地假数据）', () => {
    const code = stripComments(read(portalPath));
    for (const call of [
      'bossApi.getTeamMembers',
      'bossApi.addOrUpdateTeamMember',
      'bossApi.generateInviteUrl',
      'bossApi.getAttendanceRecords',
      'bossApi.retroactiveClock',
      'bossApi.getCareSignals',
      'bossApi.getCareNotes',
      'bossApi.createCareNote',
      'bossApi.handleCareSignal',
    ]) {
      assert.ok(code.includes(call), `OwnerPortal 没有调用 ${call}`);
    }
  });

  test('补卡按考勤记录 id 定位（原型按员工，会改错行）', () => {
    const code = stripComments(read(portalPath));
    // 表单状态必须绑在**记录**上，而不是员工上。
    assert.match(
      code,
      /const \[retroAttendanceId, setRetroAttendanceId\] = useState<string>/,
      '补卡没有按考勤记录 id 建状态',
    );
    assert.ok(code.includes('retroAttendanceId'), '补卡表单没有记录 id 这一维');
    // 传给 retroactiveClock 的最后一个参数必须是记录的 id。
    assert.match(
      code,
      /bossApi\.retroactiveClock\([\s\S]*?record\.id\s*,/,
      '补卡没有把考勤记录 id 交给 retroactiveClock',
    );
    // 反向：不能再按员工定位（原型传的是 staff.id）。
    assert.equal(
      /bossApi\.retroactiveClock\(\s*staff\.id/.test(code),
      false,
      '补卡又退回按员工定位了',
    );
  });

  test('邀请链接：不能再把整个响应对象交给剪贴板', () => {
    const code = stripComments(read(portalPath));
    assert.ok(code.includes('readInviteUrl'), 'invite_url 没有做运行时收窄（后端可能回 null）');
    assert.match(code, /writeText\(url\)/, '剪贴板写入的不是收窄后的 url 字符串');
    assert.equal(
      /writeText\((result|response|data)\b/.test(code),
      false,
      '又把未收窄的响应对象交给剪贴板了（写出来会是 [object Object]）',
    );
  });
});

// ---------------------------------------------------------------------------
// 5) 负向对照：证明每一个 checker 都会失败
// ---------------------------------------------------------------------------

describe('pwa tier (staff/owner): checker 的负向对照', () => {
  test("合成源码里的 import { motion } from 'motion/react' 会被命中", () => {
    const synthetic = "import { motion } from 'motion/react';\nexport const X = () => null;\n";
    assert.ok(
      findForbidden(synthetic).includes('motion/react 依赖'),
      'checker 漏掉了 motion/react',
    );
  });

  test('合成源码里的 <motion.div> / <AnimatePresence> 会被命中', () => {
    const synthetic = 'const A = () => (<AnimatePresence><motion.div /></AnimatePresence>);\n';
    const hits = findForbidden(synthetic);
    assert.ok(hits.includes('motion 组件'), 'checker 漏掉了 <motion.div>');
    assert.ok(hits.includes('AnimatePresence'), 'checker 漏掉了 <AnimatePresence>');
  });

  test('合成源码里的 @googlemaps / google.maps / import.meta.env 会被命中', () => {
    const synthetic = [
      "import { Loader } from '@googlemaps/js-api-loader';",
      'const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;',
      'new google.maps.Map(el, {});',
    ].join('\n');
    const hits = findForbidden(synthetic);
    assert.ok(hits.includes('Google Maps 包'), 'checker 漏掉了 @googlemaps');
    assert.ok(hits.includes('google.maps 全局'), 'checker 漏掉了 google.maps');
    assert.ok(hits.includes('import.meta.env'), 'checker 漏掉了 import.meta.env');
  });

  test('负向对照：缺少 use client 的合成源码会被首个非空行检查抓住', () => {
    assert.equal(
      firstNonEmptyLine("import React from 'react';\nexport const X = () => null;\n"),
      "import React from 'react';",
    );
    assert.notEqual(
      firstNonEmptyLine("import React from 'react';\n"),
      `'use client';`,
    );
  });

  test('负向对照：合成源码里的写死金额 / 演示称呼 / 演示邮箱会被命中', () => {
    // 合成源码由 MOCK_LITERALS 本身生成 —— 这样"检查器覆盖了每一个 token"
    // 就是被证明的，而不是靠手抄一份可能与清单脱节的样例。
    const synthetic = MOCK_LITERALS.map((token) => `const value = ${JSON.stringify(token)};`).join('\n');
    const hits = findMockLiterals(synthetic);
    for (const token of MOCK_LITERALS) {
      assert.ok(hits.includes(token), `checker 漏掉了写死字面量：${token}`);
    }
  });

  test('负向对照：合成"api 里没有的方法"会被命中', () => {
    const synthetic = 'await staffApi.exportStaffData();\nawait bossApi.resetAllDemoData();\n';
    // 拿一份**不含这两个方法**的合成 api 源喂给同一个 checker：
    // 两个 token 都必须被判为幽灵，证明判据真的在看 api 源，而不是恒为真/假。
    const apiWithoutThem = 'export const staffApi = { async getStaffMe() {} };\n';
    const hits = findPhantomMethods(synthetic, apiWithoutThem);
    assert.ok(hits.includes('exportStaffData'), 'checker 漏掉了 exportStaffData');
    assert.ok(hits.includes('resetAllDemoData'), 'checker 漏掉了 resetAllDemoData');
  });

  test('阳性对照：同一段合成代码对着真实 api 源时，exportStaffData 不再命中', () => {
    const synthetic = 'await staffApi.exportStaffData();\nawait bossApi.resetAllDemoData();\n';
    const hits = findPhantomMethods(synthetic, API_SOURCE);
    assert.equal(hits.includes('exportStaffData'), false, 'exportStaffData 已落地，不该再被判为幽灵');
    assert.ok(hits.includes('resetAllDemoData'), 'resetAllDemoData 仍然不存在，必须继续命中');
  });

  test('负向对照：合成源码里的假登录状态会被命中', () => {
    const synthetic = "const [isAuthenticated, setIsAuthenticated] = useState(true);\nconst [loginEmail, setLoginEmail] = useState('a@b.c');\n";
    const hits = findFakeAuth(synthetic);
    assert.ok(hits.includes('isAuthenticated'), 'checker 漏掉了 isAuthenticated');
    assert.ok(hits.includes('loginEmail'), 'checker 漏掉了 loginEmail');
  });

  test('负向对照：合成源码里渲染后厨弹窗会被命中', () => {
    const synthetic = [
      "import { KitchenPhotoUploadModal } from './KitchenPhotoUploadModal';",
      'const A = () => <KitchenPhotoUploadModal onClose={() => {}} onSuccess={() => {}} />;',
    ].join('\n');
    assert.ok(
      findKitchenWiring(synthetic).includes('KitchenPhotoUploadModal'),
      'checker 漏掉了 KitchenPhotoUploadModal 的渲染',
    );
  });

  test('负向对照：合成源码里的 mock analytics 标记会被命中', () => {
    const synthetic = [
      '<section className="rf-owner-analytics">',
      '  <article className="rf-analytics-total">本月营业额</article>',
      '  <div className="rf-analytics-chart" />',
      '  <article className="rf-top-dishes">热门菜品 TOP 5</article>',
      '</section>',
    ].join('\n');
    const hits = findRemovedOwnerTabs(synthetic);
    for (const token of ['rf-owner-analytics', 'rf-analytics-total', 'rf-analytics-chart', 'rf-top-dishes', '热门菜品']) {
      assert.ok(hits.includes(token), `checker 漏掉了 mock analytics 标记：${token}`);
    }
  });

  test('负向对照：stripComments 确实会剥掉注释（否则上面几条会互相污染）', () => {
    const synthetic = '/* KitchenPhotoUploadModal 不该挂 */\nconst a = 1;\n// exportStaffData 不存在\n';
    const code = stripComments(synthetic);
    assert.equal(code.includes('KitchenPhotoUploadModal'), false, 'stripComments 没有剥掉块注释');
    assert.equal(code.includes('exportStaffData'), false, 'stripComments 没有剥掉行注释');
  });
});
