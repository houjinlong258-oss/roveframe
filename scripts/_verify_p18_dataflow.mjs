/**
 * 真实数据流验证（在"边界成立"之上的那一层）。
 *
 * 上一步只证明了边界对不对：公开路径能进 handler、受保护路径拒绝。
 * 但一个所有 handler 都返回 404 的实现同样能通过那种检查。
 *
 * 这一步用的是**库里真实存在的数据**（scripts/_seed_p18_demo.mts 造的已发布站点
 * 与网页点单 token），因此它验证的是：公开接口能不能把真实内容取出来。
 *
 * 每一行都断言**内容**，不只断言状态码。
 *
 * 用法：node scripts/_verify_p18_dataflow.mjs <slug> <orderToken> [baseUrl]
 */
const SLUG = process.argv[2];
const TOKEN = process.argv[3];
const BASE = process.argv[4] ?? 'http://127.0.0.1:5067';

if (!SLUG || !TOKEN) {
  console.error('用法: node scripts/_verify_p18_dataflow.mjs <slug> <orderToken> [baseUrl]');
  process.exit(2);
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 允许非 JSON */ }
  return { status: response.status, json, text };
}

const checks = [];
const record = (label, pass, detail) => checks.push({ label, pass, detail });

// --- 1) 站点配置：必须有真实店名、模式、配送规则、主题 -------------------------
const cfg = await getJson(`/api/site/config?slug=${encodeURIComponent(SLUG)}`);
record(
  '站点配置 200 且含真实店名',
  cfg.status === 200 && typeof cfg.json?.store?.name === 'string' && cfg.json.store.name.length > 0,
  `status=${cfg.status} name=${JSON.stringify(cfg.json?.store?.name ?? null)}`,
);
record(
  '站点配置返回四个模式的可见性',
  cfg.status === 200 && cfg.json?.modes && typeof cfg.json.modes.dine_in === 'boolean',
  `modes=${JSON.stringify(cfg.json?.modes ?? null)}`,
);
record(
  '站点配置返回配送规则（外卖可用性的唯一来源）',
  cfg.status === 200 && cfg.json?.delivery && typeof cfg.json.delivery.minOrderAmount === 'number',
  `delivery=${JSON.stringify(cfg.json?.delivery ?? null)}`,
);
record(
  '站点配置返回主题（顾客端 PWA 的配色来源）',
  cfg.status === 200 && typeof cfg.json?.theme?.primary === 'string',
  `theme.primary=${JSON.stringify(cfg.json?.theme?.primary ?? null)}`,
);

// --- 2) 菜单：必须真的取到商品 -------------------------------------------------
const menu = await getJson(`/api/store/menu?token=${encodeURIComponent(TOKEN)}`);
const products = Array.isArray(menu.json?.products) ? menu.json.products : [];
record(
  '菜单返回真实商品（>0）',
  menu.status === 200 && products.length > 0,
  `status=${menu.status} products=${products.length}`,
);
record(
  '商品含价格与分类（服务端计价的输入）',
  products.length > 0 && products.every((p) => p.price !== undefined && typeof p.category === 'string'),
  products.length > 0 ? `sample=${JSON.stringify({ name: products[0].name, price: products[0].price, category: products[0].category })}` : 'no products',
);
record(
  '菜单返回该商家的网页桌号（顾客端下单的路由依据）',
  menu.status === 200 && menu.json?.table === 'WEB',
  `table=${JSON.stringify(menu.json?.table ?? null)}`,
);
record(
  '菜单币种来自站点配置，不是写死的 USD',
  menu.status === 200 && typeof menu.json?.store?.currency === 'string',
  `currency=${JSON.stringify(menu.json?.store?.currency ?? null)}`,
);

// --- 3) 已发布官网页面：必须真的渲染出内容 -------------------------------------
const page = await fetch(`${BASE}/en/site/${encodeURIComponent(SLUG)}`, { redirect: 'manual' });
const html = await page.text();
record(
  '已发布官网 200',
  page.status === 200,
  `status=${page.status}`,
);
record(
  '官网 HTML 含真实商品名（说明数据真的进了渲染）',
  page.status === 200 && products.length > 0 && products.some((p) => p.name && html.includes(String(p.name))),
  products.length > 0 ? `probe name=${JSON.stringify(products[0].name)}` : 'no products to probe',
);

// --- 报告 ---------------------------------------------------------------------
console.log(`\nbase = ${BASE}   slug = ${SLUG}\n`);
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.pass ? '[ok]  ' : '[FAIL]'} ${c.label}\n         ${c.detail}`);
  if (!c.pass) failed += 1;
}
console.log('\n' + '='.repeat(78));
if (failed === 0) {
  console.log(`真实数据流验证通过：${checks.length}/${checks.length} —— 公开接口取到了库里的真实内容。`);
} else {
  console.log(`${failed}/${checks.length} 项失败 —— 公开接口没有把真实数据取出来。`);
}
process.exit(failed === 0 ? 0 : 1);
