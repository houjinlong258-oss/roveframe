import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 —— 顾客端 PWA 落地的守卫。
 *
 * ## 守的是什么
 *
 * 这次是把原型（_pwa-review）搬进 Next.js，而搬运动作几乎全是**静默**的：
 *
 *   1. `import { motion } from 'motion/react'` 在原型里能用，在这个仓库里
 *      没有这个依赖 —— 但抄漏一行 `motion/react` 只会在运行时报模块找不到，
 *      ts-check 之前的所有检查都不会响。
 *   2. `import.meta.env.VITE_*` 是 Vite 的写法：Next 客户端只内联
 *      `process.env.NEXT_PUBLIC_*`，`import.meta.env` 会静默变成 undefined。
 *   3. `'use client';` 漏一行，页面会以服务端组件身份渲染 —— 里面全是
 *      useState / onClick，报错在浏览器控制台，构建照样通过。
 *   4. 后厨巡检弹窗的合规横幅是写死的（Grade A / 1.8-2.3°C / 4 次全区巡查），
 *      一旦被重新挂回渲染树，顾客就会看到编造的食品安全结论。
 *   5. 交付追踪原型里的"实时 GPS"是一个 2 秒一次的 setInterval 在挪标记，
 *      遥测（电量 / 体温 / 时速）全是字面量。这类代码回到仓库就是回归。
 *
 * ## 负向对照
 *
 * 下面的 checker 不只是"对现有文件返回空数组"：`负向对照` 一节用**合成源码**
 * 断言同一批 checker 真的会命中。没有这一步，"0 命中"可能只是 checker 写错了。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** 去掉注释再查，避免把"解释为什么不这么做"的注释误报成违规。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1) checker：被搬运的文件里不允许出现的东西
// ---------------------------------------------------------------------------

/** 本次搬运的 5 个组件（原型 → 仓库）。 */
const PORTED_COMPONENTS = [
  'src/components/customer/CustomerPwa.tsx',
  'src/components/customer/DishDetailModal.tsx',
  'src/components/customer/FlyingDishOverlay.tsx',
  'src/components/customer/KitchenInspectionModal.tsx',
  'src/components/pwa/tier-install-prompt.tsx',
] as const;

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
    { label: '伪造 GPS 的 setInterval', pattern: /setInterval\s*\(/ },
  ];
  return rules.filter((rule) => rule.pattern.test(code)).map((rule) => rule.label);
}

describe('pwa tier: 搬运后的组件不允许出现的形态', () => {
  for (const rel of PORTED_COMPONENTS) {
    test(`${rel} 不含 motion / Google Maps / import.meta.env`, () => {
      const source = read(rel);
      assert.deepEqual(findForbidden(source), [], `${rel} 命中了禁用形态`);
    });
  }

  test('每一个搬运组件的首个非空行都是 \'use client\';', () => {
    for (const rel of PORTED_COMPONENTS) {
      const firstLine = read(rel)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      assert.equal(firstLine, `'use client';`, `${rel} 的首个非空行不是 'use client';`);
    }
  });

  test('package.json 没有引入 motion / @googlemaps（零新增依赖）', () => {
    const pkg = read('package.json');
    assert.equal(/motion/.test(pkg), false, 'package.json 里出现了 motion —— 不允许新增该依赖');
    assert.equal(/@googlemaps/.test(pkg), false, 'package.json 里出现了 @googlemaps —— 不允许新增该依赖');
  });
});

// ---------------------------------------------------------------------------
// 2) 负向对照：证明 checker 会失败
// ---------------------------------------------------------------------------

describe('pwa tier: checker 的负向对照', () => {
  test("合成源码里的 import { motion } from 'motion/react' 会被命中", () => {
    const synthetic = "import { motion } from 'motion/react';\nexport const X = () => null;\n";
    assert.ok(findForbidden(synthetic).includes('motion/react 依赖'), 'checker 漏掉了 motion/react');
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

  test('合成源码里的 setInterval 会被命中', () => {
    assert.ok(
      findForbidden('setInterval(() => tick(), 2000);').includes('伪造 GPS 的 setInterval'),
      'checker 漏掉了 setInterval',
    );
  });
});

// ---------------------------------------------------------------------------
// 3) 后厨巡检：文件保留，但不许回到渲染树
// ---------------------------------------------------------------------------

describe('pwa tier: 后厨巡检不接入渲染树', () => {
  const customer = read('src/components/customer/CustomerPwa.tsx');

  test('CustomerPwa 不引用 KitchenInspectionModal', () => {
    assert.equal(customer.includes('KitchenInspectionModal'), false, 'CustomerPwa 仍在引用后厨巡检弹窗');
  });

  test('CustomerPwa 也没有后厨巡检的入口（按钮 / 状态 / 图片）', () => {
    const code = stripComments(customer);
    for (const token of ['kitchenPhotos', 'showKitchenModal', 'KitchenPhotoUploadModal', '看后厨', '后厨卫生实况']) {
      assert.equal(code.includes(token), false, `CustomerPwa 仍残留后厨入口：${token}`);
    }
  });

  test('组件文件本身保留（后端做出来之后要能接回来）', () => {
    const kept = read('src/components/customer/KitchenInspectionModal.tsx');
    assert.match(kept, /export const KitchenInspectionModal/);
    // 保留文件不等于保留假数据：文件头必须写清楚为什么没挂载。
    assert.match(kept, /Grade A/);
  });
});

// ---------------------------------------------------------------------------
// 4) 交付追踪：没有地图，没有假 GPS，没有编造的遥测
// ---------------------------------------------------------------------------

describe('pwa tier: 交付追踪只显示真实状态', () => {
  const tracker = read('src/components/delivery/delivery-tracker.tsx');

  test('没有任何模拟位移 / 地图', () => {
    assert.equal(tracker.includes('setInterval'), false, '交付追踪里出现了 setInterval（假 GPS 回归）');
    assert.equal(tracker.includes('google.maps'), false, '交付追踪里出现了 google.maps');
    assert.equal(tracker.includes('@googlemaps'), false, '交付追踪里出现了 @googlemaps');
  });

  test('没有编造的骑手遥测字段', () => {
    for (const token of ['battery_level', 'health_certified', 'speed_kmh', 'temperature', 'vehicle_plate']) {
      assert.equal(tracker.includes(token), false, `交付追踪仍在读不存在的遥测字段：${token}`);
    }
  });

  test('保留了 CustomerPwa 需要的导出名与四步状态', () => {
    assert.match(tracker, /export const DeliveryTrackerMap/);
    for (const step of ['unclaimed', 'claimed', 'picked_up', 'delivered']) {
      assert.ok(tracker.includes(`'${step}'`), `交付时间线缺少状态 ${step}`);
    }
    assert.ok(tracker.includes('promised_at'), '交付时间线没有显示 promised_at');
  });

  test('CustomerPwa 传给交付追踪的 props 都被接住了', () => {
    const customer = read('src/components/customer/CustomerPwa.tsx');
    assert.match(customer, /from '@\/components\/delivery\/delivery-tracker'/);
    for (const prop of ['order=', 'onClose=', 'currency=', 'locale=']) {
      assert.ok(customer.includes(prop), `CustomerPwa 没有传 ${prop}`);
    }
    for (const prop of ['order', 'onClose', 'currency', 'locale']) {
      assert.ok(tracker.includes(prop), `delivery-tracker 没有声明 ${prop}`);
    }
  });

  test('没有骑手就明说没有骑手（不是留空白）', () => {
    assert.ok(tracker.includes('尚未分配骑手'), '未分配骑手时没有明确的说明文案');
  });
});

// ---------------------------------------------------------------------------
// 5) 门面：/{locale}/store 挂的是顾客端 PWA
// ---------------------------------------------------------------------------

describe('pwa tier: 默认门面挂载', () => {
  const page = read('src/app/[locale]/store/page.tsx');

  test('store 页面 import 了 CustomerPwa 并渲染它', () => {
    assert.match(page, /import\s*\{\s*CustomerPwa\s*\}\s*from\s*'@\/components\/customer\/CustomerPwa'/);
    assert.match(page, /<CustomerPwa/);
  });

  test('Next 16 的 params / searchParams 都是 await 过的 Promise', () => {
    assert.match(page, /await params/);
    assert.match(page, /await searchParams/);
  });

  test('旧的 ?token= 二维码地址继续可用，?mode= 语义保留', () => {
    assert.match(page, /query\.token/, 'store 页面不再读 ?token=');
    assert.match(page, /token=\{token\}/, 'store 页面没有把 token 交给客户端');
    assert.match(page, /query\.mode/, 'store 页面不再读 ?mode=');
    for (const mode of ['dine_in', 'delivery', 'booking', 'menu']) {
      assert.ok(page.includes(`'${mode}'`), `?mode= 少了 ${mode}`);
    }
  });

  test('页面上不再是 useSearchParams 客户端页（服务端组件才能反查 slug）', () => {
    assert.equal(page.includes('use client'), false, 'store 页面变回了客户端组件');
    assert.equal(page.includes('useSearchParams'), false, 'store 页面又用回了 useSearchParams');
  });
});

// ---------------------------------------------------------------------------
// 6) 顺手守住"不许把编造的演示数据搬回来"
// ---------------------------------------------------------------------------

describe('pwa tier: 不把演示数据搬回渲染树', () => {
  test('CustomerPwa 不再渲染原型里的假店名 / 假联系人 / 假评分 / 假 GPS 文案', () => {
    const code = stripComments(read('src/components/customer/CustomerPwa.tsx'));
    for (const token of ['Grove Bistro', 'Jane Doe', '742 Evergreen', '320+', 'GPS', 'LE JARDIN']) {
      assert.equal(code.includes(token), false, `CustomerPwa 仍在渲染演示数据：${token}`);
    }
  });

  test('DishDetailModal 的 canOrder 默认值是 false（fail-closed），且 CustomerPwa 显式传入', () => {
    const modal = read('src/components/customer/DishDetailModal.tsx');
    assert.match(modal, /canOrder = false/, 'canOrder 默认值不是 false');
    assert.match(
      read('src/components/customer/CustomerPwa.tsx'),
      /canOrder=\{mode !== 'menu'\}/,
      'CustomerPwa 没有按模式传 canOrder',
    );
  });
});
