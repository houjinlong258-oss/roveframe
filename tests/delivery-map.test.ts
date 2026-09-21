import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 配送地图（可配置地图服务商）的守卫。
 *
 * ## 这一层守的是什么
 *
 * 地图这块有三类"看起来没事、其实是事故"的退化：
 *
 *   1. **明文 key 进了仓库**。key 必须只以 AES-256-GCM 密文落库
 *      （`integration_configs.config_encrypted`），仓库里任何文件 —— 含测试、
 *      示例、注释 —— 都不许出现厂商 key 的字面量。这里用**厂商 key 的真实形态**
 *      做正则，并配合成反例证明正则会拒绝它。
 *   2. **把平台级 key 当全局常量下发**。每个商家只能拿到自己那一份
 *      （按 tenant+business 读 `integration_configs`），否则一家店的 key
 *      会替所有店付费、也会让任何一家店看到别人的用量。
 *   3. **没有配置时渲染空白或编造地图**。空白框会被读成"加载失败"，
 *      编造的地图更糟 —— 原型正是用一个 2 秒定时器让标记自己走骗过评审的。
 *      因此：无配置必须显示明确的「地图未配置」，且组件里不许有任何定时器、
 *      不许有写死的坐标或厂商地址。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 递归列出源码文件（只扫会进仓库的代码目录，见文件头）。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      sourceFiles(rel, out);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js|json|sql|md)$/.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

/** 取出一个**顶层**声明的源码块：从 `[export] [async] function NAME` 起到下一个顶层声明为止。 */
function declaredBlock(src: string, name: string): string {
  const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm').exec(src);
  assert.ok(match, `未找到顶层声明 ${name}`);
  const start = match.index;
  const next = /\n(?:export |async function |function |const )/.exec(src.slice(start + 1));
  return next ? src.slice(start, start + 1 + next.index) : src.slice(start);
}

function assertContract(label: string, source: string, matcher: RegExp, counterExample: string): void {
  assert.match(source, matcher, `${label}：真实源码未命中 ${String(matcher)}`);
  assert.doesNotMatch(
    counterExample,
    matcher,
    `${label}：合成反例没有被同一条 matcher 拒绝 —— 这条断言是空的`,
  );
}

function assertForbidden(label: string, source: string, matcher: RegExp, counterExample: string): void {
  assert.doesNotMatch(source, matcher, `${label}：真实源码里出现了 ${String(matcher)}`);
  assert.match(
    counterExample,
    matcher,
    `${label}：这条禁令的合成反例没有被同一 matcher 命中 —— 禁令本身是坏的`,
  );
}

// ---------------------------------------------------------------------------
// 1) 仓库里不许出现明文地图 key
// ---------------------------------------------------------------------------

describe('delivery map: 明文 key 不得进仓库', () => {
  /**
   * 只认**厂商 key 的真实形态**：
   *   · Google API key：AIza + 35 个 [0-9A-Za-z_-]；
   *   · Mapbox token：pk. + 20 个以上 [A-Za-z0-9_-]。
   * 刻意不用"长字符串"这类宽泛规则：那会把正常的 base64 密文、哈希、测试夹具
   * 全部命中，而一条总在报错的守卫等于没有守卫。
   *
   * 反例在**运行时**拼接出来（`${'x'.repeat(35)}`），而不是写成一个字面量：
   * 这个测试文件本身也在扫描范围里，写字面量就等于往仓库里塞一个"明文 key 形状"
   * 的字符串，然后守卫必然命中自己。拼接不影响反例的有效性 —— 它照样是一个
   * 匹配该正则的真实字符串。
   */
  const PLAINTEXT_KEY_PATTERNS: { id: string; pattern: RegExp; counter: string }[] = [
    {
      id: 'google-api-key',
      pattern: /AIza[0-9A-Za-z_-]{35}/,
      counter: `const GOOGLE = "AIza${'x'.repeat(35)}";`,
    },
    {
      id: 'mapbox-token',
      pattern: /\bpk\.[A-Za-z0-9_-]{20,}/,
      counter: `const TOKEN = "pk.${'e'.repeat(24)}";`,
    },
  ];

  test('src / tests / scripts 里没有任何厂商 key 的字面量，且同一 matcher 会拒绝合成反例', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('tests'), ...sourceFiles('scripts')];
    assert.ok(files.length > 100, `扫描到的文件太少（${files.length}），扫描本身可能失效了`);
    for (const { id, pattern, counter } of PLAINTEXT_KEY_PATTERNS) {
      // 反例必须被抓住，否则下面的"零命中"是假的。
      assert.match(counter, pattern, `${id} 的合成反例没被 matcher 命中 —— 正则写错了`);
      const hits: string[] = [];
      for (const file of files) {
        if (!statSync(join(ROOT, file)).isFile()) continue;
        const text = read(file);
        if (pattern.test(text)) hits.push(file);
      }
      assert.deepEqual(hits, [], `${id} 形式的明文 key 出现在：${hits.join(', ')}`);
    }
  });

  test('key 只以密文落库：保存路径必须走 encrypt()', () => {
    const source = stripComments(read('src/lib/map-config.ts'));
    assertContract(
      'encrypt 落库',
      source,
      /config_encrypted: encrypt\(JSON\.stringify\(\{/,
      "await client.from('integration_configs').insert({ provider: 'map', config_encrypted: JSON.stringify({ api_key: key }) });",
    );
  });
});

// ---------------------------------------------------------------------------
// 2) 按商家下发：读的是 (tenant, business) 那一行，不是全局常量
// ---------------------------------------------------------------------------

describe('delivery map: 配置按商家隔离', () => {
  test('存储层按 tenant_id + business_id 读，绝不无过滤读整表', () => {
    const source = stripComments(read('src/lib/map-config.ts'));
    assertContract(
      '按门店过滤',
      source,
      /\.eq\('tenant_id', tenantId\)\s*\n\s*\.eq\('business_id', businessId\)/,
      "const MAP = { provider: 'google', api_key: process.env.MAP_KEY };",
    );
    // 负向对照：一段"全局常量配置"必须被同一条 matcher 拒绝。
    assert.doesNotMatch(
      "const MAP = { provider: 'google', api_key: process.env.MAP_KEY };",
      /\.eq\('tenant_id', tenantId\)/,
    );
  });

  test('顾客端拿到的配置来自 token 解析出的门店，不是请求参数，也不是常量', () => {
    const route = stripComments(read('src/app/api/store/deliveries/[id]/track/route.ts'));
    assert.match(route, /resolvePublicStore\(request\.nextUrl\.searchParams\.get\('token'\)\)/);
    assert.match(route, /readMapConfig\(store\.tenantId, store\.businessId\)/);
    // 不得从查询参数读租户/门店，也不得读任何"平台默认 key"环境变量。
    assert.doesNotMatch(route, /searchParams\.get\('(tenant|business)/);
    assert.doesNotMatch(route, /process\.env\.[A-Z_]*MAP[A-Z_]*/);
  });

  test('老板端读接口**不回显 key**，只回状态（key_state）', () => {
    const route = read('src/app/api/settings/map/route.ts');
    const getBlock = declaredBlock(stripComments(route), 'GET');
    assertContract(
      '不回显 key',
      getBlock,
      /key_state: state\.keyState/,
      "return NextResponse.json({ map: { api_key: state.config?.apiKey, provider } });",
    );
    assertForbidden(
      'GET 里不得出现 api_key',
      getBlock,
      /api_key/,
      "return NextResponse.json({ map: { api_key: state.config?.apiKey } });",
    );
  });
});

// ---------------------------------------------------------------------------
// 3) 组件：无配置明说、不模拟移动、不写死坐标与地址
// ---------------------------------------------------------------------------

describe('delivery map: 组件不编造', () => {
  const MAP_COMPONENT = 'src/components/delivery/delivery-map.tsx';
  const component = read(MAP_COMPONENT);

  test('没有配置时显示「地图未配置」，不是空白框', () => {
    assertContract(
      '未配置文案',
      component,
      /地图未配置/,
      'export const DeliveryMap = () => null;',
    );
    // 也不许回落成"用别家免费地图顶上"：组件里不得出现任何写死的厂商地址。
    assertForbidden(
      '组件不写死厂商地址',
      stripComments(component),
      /https?:\/\/[a-z0-9.-]+/i,
      "const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';",
    );
  });

  test('没有任何定时器（模拟位移的回归点就在这儿）', () => {
    assertForbidden(
      '禁止 setInterval',
      component,
      /setInterval/,
      'setInterval(() => setProgress((p) => p + 1.2), 2000);',
    );
    assertForbidden(
      '禁止 setTimeout',
      component,
      /setTimeout/,
      'setTimeout(() => setSimProgress(1), 2000);',
    );
  });

  test('没有写死的坐标（不编造骑手位置）', () => {
    assertForbidden(
      '禁止字面量坐标',
      stripComments(component),
      /lat:\s*-?\d+(?:\.\d+)?,\s*\n?\s*lng:\s*-?\d+(?:\.\d+)?/,
      'const rider = { lat: 40.7128, lng: -74.006 };',
    );
  });

  test('需要坐标时才画：不画"半张地图"，缺坐标由调用方回落到时间线', () => {
    assertContract(
      '缺坐标即不渲染',
      stripComments(component),
      /if \(!rider \|\| !destination\) return null;/,
      'if (!rider) return <div className="h-[240px] bg-stone-800" />;',
    );
  });

  test('瓦片地址由注册表与配置拼出来，key 作为查询参数（不含写死域名）', () => {
    const source = stripComments(component);
    assert.match(source, /buildTileUrl\(config\.base_url, layout\.zoom, x, y, config\.api_key, config\.key_param\)/);
    const registry = stripComments(read('src/lib/map-providers.ts'));
    assert.match(registry, /const separator = url\.includes\('\?'\) \? '&' : '\?'/);
    // 负向对照：把 key 直接缝进路径的写法必须被同一条断言拒绝（那样会把 key 写进日志与 Referer）。
    assert.doesNotMatch(
      "const url = `https://tiles.example.com/${apiKey}/${z}/${x}/${y}.png`;",
      /const separator = url\.includes\('\?'\) \? '&' : '\?'/,
    );
  });

  test('追踪面板：没有 token 就不发请求，且不引入定时器', () => {
    const tracker = read('src/components/delivery/delivery-tracker.tsx');
    assert.match(tracker, /if \(trackingToken\) void loadTracking\(\);/);
    assert.match(tracker, /if \(!trackingToken\) return;/);
    assertForbidden(
      'tracker 禁止 setInterval',
      tracker,
      /setInterval/,
      'setInterval(loadTracking, 5000);',
    );
    // 位置刷新必须是**人点出来的**，不是自己跑的。
    assert.match(tracker, /刷新位置/);
  });
});
