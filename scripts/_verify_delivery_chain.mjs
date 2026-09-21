/**
 * 外卖全链路真实验证（真实 HTTP + 真实会话 + 真实数据库）。
 *
 * ## 这一步填的是哪个空白
 *
 * 外卖链（顾客下单 → 员工接单 → 状态推进 → 骑手位置 → 顾客看 ETA）的代码、
 * 迁移、守卫测试全都在，但库里 `delivery_orders` 是 0 行、`settings.delivery` 是 `{}`：
 * 配送没开启，顾客端 PWA 连外卖 tab 都不渲染。所有断言只能停在"源码看起来对不对"。
 *
 * 现在库里有了真实的规则与真实的单子，于是可以打真请求、带真会话，
 * 验的是"数据能不能流到顾客面前"，而不是"代码长什么样"。
 *
 * ## 为什么必须连数据库（本脚本与 `_verify_staff_tier.mjs` 唯一的结构差异）
 *
 * 有两个断言**无法只用 HTTP 完成**：
 *
 *   1. `estimate`（预计送达时间）需要 `delivery_orders.dest_lat/dest_lng`，
 *      而 `src/` 里**没有任何代码会写这两列**（只有 track 路由在读）。
 *      不手工放一份目的坐标，ETA 这条分支永远验不到 —— 这是缺陷，不是设计。
 *      端点验证因此分两半：先证明"没有目的坐标时不编 ETA"（estimate 为 null），
 *      放上坐标后再证明"有坐标时才算，并且算出来的距离/时间与本地独立复算一致"。
 *   2. "没有落脏数据"这类**否定结论**（拒绝的请求没有落单、NaN 没有进库、
 *      送达后不再写位置）需要直接数行数。接口 200/400 只能说明它回得对，
 *      说明不了它没写。
 *
 * 数据库只用于 fixture 与计数；链路本身全部走 HTTP。
 *
 * ## 每个边界都有负向对照
 *
 * 幂等（同 key 同内容 → 同一单 / 同 key 改内容 → 409）、起送价（低于 → 400 且不落单）、
 * 认领（第二次 → 409 already_claimed；不存在的单 → 404）、状态机（送达后再推 → 409；
 * 骑手不能 cancel）、坐标（999 / 字符串 / null / 字面量 NaN → 400）、
 * 追踪（不存在的单与无效 token → 404，绝不 403；无目的坐标 → estimate 为 null）、
 * 权限（店长看板：无会话 401 / 员工会话 403）。
 *
 * 用法（凭据只走环境变量，不落盘）：
 *   $env:PGHOST=...; $env:PGUSER=...; $env:PGPASSWORD=...
 *   node scripts/_verify_delivery_chain.mjs [baseUrl] [email] [password]
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 缺少数据库环境变量或前置条件不足。
 *
 * ## 两个会把本脚本打红、但**不是链路故障**的外部条件
 *
 *   1. **登录限流**：`POST /api/auth/login` 失败一次即触发 15 分钟退避
 *      （`AUTH_BACKOFF.baseMs`，src/app/api/auth/login/route.ts:22），期间连正确密码
 *      也拿到 429。所以本脚本**不做**"错误密码 → 401"那条负向对照（那是 15 分钟自锁），
 *      并且默认给每次运行一个独立的 `X-Forwarded-For`（见下面 XFF 的说明）。
 *      看到 429 就等窗口过去或重启服务（限速状态在内存里）。
 *   2. **员工端功能开关**：`settings.wellbeing.staff_access.delivery`
 *      （src/lib/staff-access.ts，默认开）。老板把它关掉之后，认领/推进/位置都会
 *      403 `feature_disabled` —— 那是"这家店对员工关掉了外卖"，不是链路坏了。
 *      第 8 节的"新单在 pending 里"会最先把它暴露出来。
 */
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? process.env.DELIVERY_BASE_URL ?? 'http://127.0.0.1:5067';
const EMAIL = process.argv[3] ?? 'staff.demo@roveframe.local';
const PASSWORD = process.argv[4] ?? 'Staff-demo-2026';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';
const SLUG = 'demo-bistro';
const SESSION_COOKIE = 'rf_session'; // src/lib/auth.ts:18

/**
 * 收货信息。地址与电话**刻意压短**：`orders.idempotency_fingerprint` 是
 * varchar(128)，而外卖指纹会把两个商品 uuid（各 36 字符）连同地址电话一起拼进去
 * （`deliveryContentFingerprint`）。正常写法（`455 W 37th St, Apt 12F, New York,
 * NY 10018` + `+1 212 555 0184`）算出来 147 字符 → 接口 500
 * `value too long for type character varying(128)`。这是缺陷 1，下面有独立探针复现它，
 * 不修（`src/` 禁改），只能迁就。
 */
const ORDER = {
  items: 'TWO_CHEAPEST_ACTIVE', // 运行时按 products 表解析，见 pickProducts()
  recipient_name: 'Amelia Chen',
  recipient_phone: '2125550184',
  address_line: '455 W 37th St, Apt 12F, NY',
  address_note: 'Ring buzzer 12F.',
  notes: 'delivery chain verification order',
};

/** 正常长度的地址 —— 只用于那条"缺陷探针"，不用于任何成功的下单。 */
const LONG_ADDRESS_PROBE = {
  address_line: '455 W 37th St, Apt 12F, New York, NY 10018',
  recipient_phone: '+1 212 555 0184',
};

/** 目的坐标（fixture）。放在曼哈顿 37 街西段，与上面的地址对应。 */
const DESTINATION = { lat: 40.7554, lng: -73.993 };

/** 骑手两次上报：第二次更靠近目的地，用来验"ETA 跟着位置走"，而不是写死的数。 */
const RIDER_POSITION_1 = { lat: 40.7321, lng: -73.9851, accuracy_m: 12 };
const RIDER_POSITION_2 = { lat: 40.7498, lng: -73.9917, accuracy_m: 8 };

const MAX_FINGERPRINT_CHARS = 128;
const ROAD_FACTOR = 1.35;
const AVERAGE_SPEED_KMH = 22;

/**
 * 本脚本请求使用的来源 IP（`X-Forwarded-For`）。
 *
 * 为什么需要它：登录限流按 `auth:login:ip:<getClientIp()>` 计数，而 `getClientIp`
 * （src/lib/rate-limit.ts:176）先看 `x-forwarded-for`。本机直连时没有代理设置这个头，
 * 于是**所有**直连调用方（本脚本、员工端验证脚本、任何别的会话）共用同一个 IP 桶；
 * 别人几次登录失败就会把本脚本里**正确密码**的登录一起锁进 429
 * （实测：retryAfterSec≈572，且这个 IP 桶的退避还会被后续失败继续翻倍）。
 *
 * 因此每次运行默认取一个独立的、保留给文档用的测试网段地址，并把它打印在报告抬头里
 * —— 不静默改行为。要看"真实来源 IP"下的行为就设
 * `DELIVERY_VERIFY_XFF=direct`（不发这个头，落回 `unknown` 桶）。
 * 部署环境下这个头由 Caddy 设置，脚本这里只是本机验证的隔离手段。
 */
const XFF = process.env.DELIVERY_VERIFY_XFF === 'direct'
  ? ''
  : (process.env.DELIVERY_VERIFY_XFF || `198.51.100.${Math.floor(Math.random() * 200) + 1}`);

if (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGPASSWORD) {
  // 不跳过、不静默降级：上面的两个断言类没有数据库就验不了，
  // 缺了就直接退出，免得打出一片"绿"而其实什么都没验。
  console.error('缺 PGHOST / PGUSER / PGPASSWORD：本脚本需要它们做 fixture 与行数核对（凭据只从环境变量读）');
  process.exit(2);
}
if (!existsSync('src/app/api/store/deliveries/[id]/track/route.ts')) {
  // 源码级断言用的是相对路径，跑错目录会变成"文件不存在"这种与业务无关的报错。
  console.error('请在仓库根目录运行本脚本（找不到 src/app/api/store/deliveries/[id]/track/route.ts）');
  process.exit(2);
}

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

const results = [];
/** 记一条断言。detail 必须带实测值 —— 失败时报告里要能直接看出差在哪。 */
const record = (label, pass, detail) => results.push({ label, pass: Boolean(pass), detail });

// --- cookie jar（等价于浏览器）------------------------------------------------
const jar = new Map();
function captureCookies(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

/**
 * 打一次请求。`session: false` 表示**不带**会话 cookie ——
 * 公开接口的验证必须证明"没有会话也能用"，带 cookie 打等于没验。
 */
async function call(path, init = {}, { session = true } = {}) {
  const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (XFF) headers['X-Forwarded-For'] = XFF;
  if (session && jar.size > 0) headers.Cookie = cookieHeader();
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', ...init, headers });
  if (session) captureCookies(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 允许非 JSON（导出、404 页等） */ }
  return { status: response.status, json, text, headers: response.headers };
}
const postJson = (path, body, extraHeaders = {}, options) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body),
}, options);

// --- 金额/距离/指纹：本地独立复算，用来对照服务端的权威值 ----------------------
const round2 = (value) => Math.round(value * 100) / 100;
const EARTH_RADIUS_KM = 6371.0088;
function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
const expectedEtaMinutes = (distanceKm) => (distanceKm === 0 ? 0 : Math.max(1, Math.round(((distanceKm * ROAD_FACTOR) / AVERAGE_SPEED_KMH) * 60)));

/** 复刻 src/lib/delivery.ts 的 deliveryContentFingerprint 长度（只算长度，不算值）。 */
function fingerprintChars(items, subtotal, fee, addressLine, recipientPhone) {
  const joined = items.map((item) => `${item.product_id}x${item.qty}`).sort().join(',');
  return `${joined}|${subtotal.toFixed(2)}|${fee.toFixed(2)}|${addressLine}|${recipientPhone}`.length;
}

/** 递归收集响应里所有键名 —— 用来证明追踪响应里没有骑手身份字段。 */
function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** 骑手身份字段黑名单：顾客需要的是"人在哪"，不是"这个人是谁"。 */
const RIDER_IDENTITY_FIELDS = [
  'name', 'phone', 'email', 'rider_name', 'rider_phone', 'staff_name', 'staff_id',
  'rider_staff_id', 'recipient_name', 'recipient_phone', 'staff',
];

/** 去掉注释后再做源码断言：注释里出现某个词不算通过。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --- 数据库小工具 -------------------------------------------------------------
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
async function scalar(sql, params = []) {
  const rows = await q(sql, params);
  const first = rows[0] ?? {};
  return Number(Object.values(first)[0] ?? 0);
}
const deliveredCounts = async () => ({
  orders: await scalar('select count(*) from public.orders where tenant_id=$1', [TENANT]),
  web_orders: await scalar("select count(*) from public.orders where tenant_id=$1 and source='web'", [TENANT]),
  deliveries: await scalar('select count(*) from public.delivery_orders where tenant_id=$1', [TENANT]),
  positions: await scalar('select count(*) from public.delivery_positions where tenant_id=$1', [TENANT]),
  // 中央守卫写的审计表是 `audit_logs`（src/lib/audit.ts:57），不是 `audit_events`
  // —— 后者是另一张历史表，数它会永远得到 delta=0，看着像"没写审计"。
  audit: await scalar("select count(*) from public.audit_logs where tenant_id=$1", [TENANT]),
});

const before = await deliveredCounts();

/**
 * 提前退出（前置条件不足或关键 id 缺失）也要把已经记下的断言打出来 ——
 * 否则最需要看的那几条失败信息会随着退出一起消失。
 */
async function finish(code) {
  const failedNow = results.filter((row) => !row.pass).length;
  console.log(`\nbase = ${BASE}   as = ${EMAIL}   slug = ${SLUG}`);
  console.log(`来源 IP（X-Forwarded-For）= ${XFF || '(不发该头，落回 unknown 桶)'}\n`);
  for (const row of results) {
    console.log(`  ${row.pass ? '[ok]  ' : '[FAIL]'} ${row.label}\n         ${row.detail}`);
  }
  console.log(`\n${'='.repeat(78)}`);
  console.log(`验证中断（退出码 ${code}）：${failedNow}/${results.length} 条断言失败，后面的检查不再执行。`);
  await pool.end();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 1) 站点配置：顾客端 PWA 靠 modes.delivery 决定要不要渲染外卖 tab
// ---------------------------------------------------------------------------
const config = await call(`/api/site/config?slug=${SLUG}`, {}, { session: false });
record('GET /api/site/config 200 且 modes.delivery=true（外卖 tab 会出现）',
  config.status === 200 && config.json?.modes?.delivery === true,
  `status=${config.status} modes=${JSON.stringify(config.json?.modes)} body=${config.text.slice(0, 160)}`);

const rules = {
  enabled: config.json?.modes?.delivery === true,
  minOrderAmount: Number(config.json?.delivery?.minOrderAmount),
  fee: Number(config.json?.delivery?.fee),
  freeDeliveryAbove: Number(config.json?.delivery?.freeDeliveryAbove),
  prepMinutes: Number(config.json?.delivery?.prepMinutes),
};
record('配置里的四条规则与 settings.delivery 一致（20 / 3 / 50 / 35）',
  rules.minOrderAmount === 20 && rules.fee === 3 && rules.freeDeliveryAbove === 50 && rules.prepMinutes === 35,
  `rules=${JSON.stringify(rules)}`);

const badSlug = await call('/api/site/config?slug=no-such-store-xyz', {}, { session: false });
record('负向对照：不存在的 slug → 404（上面那个 200 是关于这家店的，不是"什么 slug 都回 200"）',
  badSlug.status === 404, `status=${badSlug.status} body=${badSlug.text.slice(0, 120)}`);

// ---------------------------------------------------------------------------
// 2) 前置条件：token、商品、指纹长度
// ---------------------------------------------------------------------------
const tokenRows = await q(
  "select public_token from public.store_qr_codes where tenant_id=$1 and business_id=$2 and table_no='WEB' and is_active=true limit 1",
  [TENANT, BUSINESS],
);
const webToken = tokenRows[0]?.public_token;
record('WEB 桌码 token 存在（顾客端外卖下单的身份凭据）',
  typeof webToken === 'string' && webToken.length > 0,
  `token=${webToken ? `${webToken.slice(0, 8)}…(${webToken.length})` : '(缺失)'}`);
if (!webToken) await finish(2);

const products = (await q(
  "select id, name, price from public.products where tenant_id=$1 and business_id=$2 and status='active' order by price asc, name asc",
  [TENANT, BUSINESS],
)).map((row) => ({ id: row.id, name: row.name, price: Number(row.price) }));

const cheapest = products[0];
const second = products[1];
const preconditionsOk = products.length >= 2
  && cheapest.price < rules.minOrderAmount
  && cheapest.price + second.price >= rules.minOrderAmount
  && cheapest.price + second.price < rules.freeDeliveryAbove;
record('前置条件：目录里最便宜的一件低于起送价、最便宜的两件落在 [起送价, 免配送门槛) 内',
  preconditionsOk,
  products.length >= 2
    ? `cheapest=${cheapest.name} ${cheapest.price} / second=${second.name} ${second.price} / 两件合计=${round2(cheapest.price + second.price)} / 规则 min=${rules.minOrderAmount} freeAbove=${rules.freeDeliveryAbove}`
    : `活跃商品只有 ${products.length} 件，无法组单`);
if (!preconditionsOk) await finish(2);

const items = [{ product_id: cheapest.id, qty: 1 }, { product_id: second.id, qty: 1 }];
const subtotal = round2(cheapest.price + second.price);
const expectedFee = subtotal >= rules.freeDeliveryAbove ? 0 : rules.fee;
const expectedTotal = round2(subtotal + expectedFee);
const fingerprintLen = fingerprintChars(items, subtotal, expectedFee, ORDER.address_line, ORDER.recipient_phone);
record('下单指纹长度在 orders.idempotency_fingerprint 的 128 字符以内（否则必然 500）',
  fingerprintLen <= MAX_FINGERPRINT_CHARS,
  `指纹=${fingerprintLen} 字符 / 列宽=${MAX_FINGERPRINT_CHARS}（地址被压缩过的原因见文件头缺陷 1）`);
if (fingerprintLen > MAX_FINGERPRINT_CHARS) await finish(2);

const orderBody = {
  token: webToken,
  items,
  recipient_name: ORDER.recipient_name,
  recipient_phone: ORDER.recipient_phone,
  address_line: ORDER.address_line,
  address_note: ORDER.address_note,
  notes: ORDER.notes,
  // 顾客设备定位（Phase 18 §4.1）：产品代码现在真的收这两个字段并写进
  // delivery_orders.dest_lat/dest_lng。此前没有任何写路径，因此追踪接口
  // 永远拿不到目的地，estimate 恒为 null —— ETA 在产品里不可达。
  dest_lat: DESTINATION.lat,
  dest_lng: DESTINATION.lng,
};

// ---------------------------------------------------------------------------
// 3) 公开下单 → 201，服务端计价
// ---------------------------------------------------------------------------
const KEY = `verify-delivery-chain-${Date.now()}`;
const created = await postJson('/api/store/delivery-orders', orderBody, { 'Idempotency-Key': KEY }, { session: false });
const orderId = created.json?.order_id;
record('POST /api/store/delivery-orders（全新幂等键）→ 201 且返回 order_id/total/fee/promised_at',
  created.status === 201 && typeof orderId === 'string' && orderId.length === 36
    && typeof created.json?.promised_at === 'string' && created.json?.delivery_id !== undefined,
  `status=${created.status} body=${created.text.slice(0, 240)}`);
record('order_no 形态是 RF-<12 位十六进制>',
  /^RF-[0-9A-F]{12}$/.test(String(created.json?.order_no)),
  `order_no=${JSON.stringify(created.json?.order_no)}`);
record('服务端计价：subtotal = 两件商品之和，fee = 规则里的配送费，total = subtotal + fee',
  created.json?.subtotal === subtotal && created.json?.fee === expectedFee && created.json?.total === expectedTotal,
  `接口 subtotal=${created.json?.subtotal} fee=${created.json?.fee} total=${created.json?.total} / 本地期望 ${subtotal} / ${expectedFee} / ${expectedTotal}`);
const promisedDeltaMin = (Date.parse(String(created.json?.promised_at)) - Date.now()) / 60000;
record('promised_at = 下单时刻 + prepMinutes（35 分钟，容差 ±2 分钟）',
  Number.isFinite(promisedDeltaMin) && Math.abs(promisedDeltaMin - rules.prepMinutes) <= 2,
  `promised_at=${created.json?.promised_at} 距现在 ${promisedDeltaMin.toFixed(2)} 分钟 / 规则 ${rules.prepMinutes} 分钟`);
if (!orderId) await finish(1);

// ---------------------------------------------------------------------------
// 4) 幂等：同 key 同内容 → 同一单；同 key 改内容 → 409
// ---------------------------------------------------------------------------
const repeat = await postJson('/api/store/delivery-orders', orderBody, { 'Idempotency-Key': KEY }, { session: false });
record('同一幂等键重放 → 返回同一张单（order.id 相同，不是第二张）',
  repeat.status === 200 && repeat.json?.order?.id === orderId && repeat.json?.idempotent === true,
  `status=${repeat.status} order.id=${JSON.stringify(repeat.json?.order?.id)} / 首次=${orderId} idempotent=${JSON.stringify(repeat.json?.idempotent)}`);
const ordersWithKey = await scalar(
  "select count(*) from public.orders where tenant_id=$1 and business_id=$2 and source='web' and external_id=$3",
  [TENANT, BUSINESS, KEY],
);
record('数据库旁证：这个幂等键只有 1 行订单（重放没有落第二张）',
  ordersWithKey === 1, `orders where external_id=${KEY}: ${ordersWithKey}`);

const deliveriesBeforeClash = await scalar(
  'select count(*) from public.delivery_orders where tenant_id=$1 and business_id=$2',
  [TENANT, BUSINESS],
);
const clash = await postJson('/api/store/delivery-orders', {
  ...orderBody,
  items: [{ product_id: cheapest.id, qty: 2 }],
}, { 'Idempotency-Key': KEY }, { session: false });
record('负向对照：同一幂等键 + 不同内容 → 409 且 code=idempotency_key_conflict（不是"照抄旧单"）',
  clash.status === 409 && clash.json?.error === 'idempotency_key_conflict',
  `status=${clash.status} body=${clash.text.slice(0, 200)}`);
const deliveriesAfterClash = await scalar(
  'select count(*) from public.delivery_orders where tenant_id=$1 and business_id=$2',
  [TENANT, BUSINESS],
);
const ourOrderTotalAfterClash = await scalar(
  'select count(*) from public.orders where id=$1 and total=$2',
  [orderId, expectedTotal],
);
record('冲突请求没有改动既有订单，也没有落新单（配送单数不变 + 本单金额不变）',
  deliveriesAfterClash === deliveriesBeforeClash && ourOrderTotalAfterClash === 1,
  `delivery_orders ${deliveriesBeforeClash} → ${deliveriesAfterClash}；本单仍为 ${expectedTotal}：${ourOrderTotalAfterClash === 1}`);

// ---------------------------------------------------------------------------
// 5) 起送价边界：低于起送价 → 400 order_below_minimum + shortfall
// ---------------------------------------------------------------------------
const belowKey = `verify-below-min-${Date.now()}`;
const below = await postJson('/api/store/delivery-orders', {
  ...orderBody,
  items: [{ product_id: cheapest.id, qty: 1 }],
}, { 'Idempotency-Key': belowKey }, { session: false });
const expectedShortfall = round2(rules.minOrderAmount - cheapest.price);
record('低于起送价 → 400 且 error=order_below_minimum + shortfall 等于差额',
  below.status === 400 && below.json?.error === 'order_below_minimum' && below.json?.shortfall === expectedShortfall,
  `status=${below.status} error=${JSON.stringify(below.json?.error)} shortfall=${JSON.stringify(below.json?.shortfall)} / 期望 ${expectedShortfall} body=${below.text.slice(0, 200)}`);
const belowRows = await scalar(
  'select count(*) from public.orders where tenant_id=$1 and business_id=$2 and external_id=$3',
  [TENANT, BUSINESS, belowKey],
);
record('被拒的下单没有落任何订单行（旁证：按幂等键查 0 行）',
  belowRows === 0, `orders where external_id=${belowKey}: ${belowRows}`);

// ---------------------------------------------------------------------------
// 6) 缺陷探针：正常长度的地址 + 2 件商品
// ---------------------------------------------------------------------------
const longItems = [{ product_id: cheapest.id, qty: 1 }, { product_id: second.id, qty: 1 }];
const longFingerprintLen = fingerprintChars(
  longItems, subtotal, expectedFee, LONG_ADDRESS_PROBE.address_line, LONG_ADDRESS_PROBE.recipient_phone,
);
const longProbe = await postJson('/api/store/delivery-orders', {
  ...orderBody,
  address_line: LONG_ADDRESS_PROBE.address_line,
  recipient_phone: LONG_ADDRESS_PROBE.recipient_phone,
}, { 'Idempotency-Key': `verify-long-address-${Date.now()}` }, { session: false });
const defectStillThere = longProbe.status === 500 && /varying\(128\)/.test(longProbe.text);
record('观察（缺陷探针）：正常长度地址 + 2 件的两种可能结局都已经明确 —— 201=已修 / 500 varchar(128)=缺陷仍在',
  defectStillThere || longProbe.status === 201,
  `status=${longProbe.status} 指纹=${longFingerprintLen} 字符 / 列宽 ${MAX_FINGERPRINT_CHARS} → ${defectStillThere ? '缺陷仍在（src/ 未改，符合预期）' : '已被修复'} body=${longProbe.text.slice(0, 160)}`);

// ---------------------------------------------------------------------------
// 7) 员工会话（真实登录，不是伪造 JWT）
//
// 这里**刻意不做**"错误密码 → 401"那条负向对照：登录失败会走
// `noteFailure`（src/app/api/auth/login/route.ts:22 `AUTH_BACKOFF.baseMs = 15 分钟`），
// 一次错误密码会把该邮箱**与该 IP** 锁 15 分钟 —— 之后连正确密码也只拿 429。
// 那会让"可重复运行"这条要求直接失效（实测：一次错误密码后，正确密码拿到
// 429 retryAfterSec≈572）。"未登录会被拒"这条边界由第 17 节的 401/403 对照覆盖。
// ---------------------------------------------------------------------------
const login = await postJson('/api/auth/login', { email: EMAIL, password: PASSWORD });
const loginRateLimited = login.status === 429;
record('登录 200 且拿到真实会话 cookie（rf_session）',
  login.status === 200 && jar.has(SESSION_COOKIE),
  `status=${login.status} cookie=${[...jar.keys()].join(',') || '(无)'} role=${JSON.stringify(login.json?.role)}`
  + (loginRateLimited
    ? ` ← 登录限流生效中（失败退避 15 分钟），不是链路故障，等窗口过去再跑：${login.text.slice(0, 120)}`
    : ` body=${login.text.slice(0, 120)}`));

const me = await call('/api/staff/me');
record('会话有效：GET /api/staff/me 200 且返回员工档案',
  me.status === 200 && typeof me.json?.staff?.id === 'string',
  `status=${me.status} staff=${JSON.stringify(me.json?.staff?.name ?? null)} body=${me.text.slice(0, 120)}`);
if (me.status !== 200) await finish(1);

// ---------------------------------------------------------------------------
// 8) 派单列表：新单出现在 pending，且只出现一次
// ---------------------------------------------------------------------------
const list = await call('/api/staff/deliveries');
const pending = Array.isArray(list.json?.pending) ? list.json.pending : [];
const mineNow = Array.isArray(list.json?.mine) ? list.json.mine : [];
const matches = pending.filter((row) => row.order_id === orderId);
const ourRow = matches[0];
record('GET /api/staff/deliveries 200 且新单在 pending 里',
  list.status === 200 && matches.length === 1,
  `status=${list.status} pending=${pending.length} 本单命中=${matches.length}（幂等没有造出第二张）`);
record('pending 行的内容是真实的：order_no / 收件人 / 电话 / 地址 / fee / total 都对得上',
  ourRow?.order_no === created.json?.order_no
    && ourRow?.recipient_name === ORDER.recipient_name
    && ourRow?.recipient_phone === ORDER.recipient_phone
    && ourRow?.address_line === ORDER.address_line
    && Number(ourRow?.fee) === expectedFee
    && Number(ourRow?.total) === expectedTotal
    && ourRow?.rider_status === 'pending',
  `row=${JSON.stringify(ourRow ?? null).slice(0, 300)}`);
record('pending 行带得出餐品明细（员工看得到送什么）',
  typeof ourRow?.items_summary === 'string'
    && ourRow.items_summary.includes(cheapest.name) && ourRow.items_summary.includes(second.name),
  `items_summary=${JSON.stringify(ourRow?.items_summary ?? null)}`);
record('认领之前 mine 里没有这一单（"待接单"与"我的"确实是两个分组）',
  mineNow.every((row) => row.order_id !== orderId),
  `mine=${mineNow.length} 本单在 mine 中=${mineNow.some((row) => row.order_id === orderId)}`);

const deliveryId = String(created.json?.delivery_id ?? ourRow?.id ?? '');
record('拿到本单的 delivery_id（后续状态/位置接口用）',
  deliveryId.length === 36, `delivery_id=${deliveryId}`);
if (!deliveryId) await finish(1);

// ---------------------------------------------------------------------------
// 9) 认领：原子性 + 竞态守卫
// ---------------------------------------------------------------------------
const claim = await postJson('/api/staff/deliveries/claim', { delivery_id: deliveryId });
record('POST /api/staff/deliveries/claim → 200 且 rider_status=claimed',
  claim.status === 200 && claim.json?.ok === true, `status=${claim.status} body=${claim.text.slice(0, 200)}`);

const claimAgain = await postJson('/api/staff/deliveries/claim', { delivery_id: deliveryId });
record('竞态守卫：第二次认领 → 409 且 code=already_claimed（断言的是 code，不只是状态码）',
  claimAgain.status === 409 && claimAgain.json?.code === 'already_claimed',
  `status=${claimAgain.status} code=${JSON.stringify(claimAgain.json?.code)} body=${claimAgain.text.slice(0, 200)}`);

const claimGhost = await postJson('/api/staff/deliveries/claim', { delivery_id: '11111111-2222-4333-8444-555555555555' });
record('负向对照：认领不存在的单 → 404 not_found（409 是"真的被抢了"，不是一把万能钥匙）',
  claimGhost.status === 404, `status=${claimGhost.status} body=${claimGhost.text.slice(0, 160)}`);

const claimedRow = (await q('select rider_status, rider_staff_id, claimed_at from public.delivery_orders where id=$1', [deliveryId]))[0];
record('数据库旁证：这一单已挂到员工档案上并写了 claimed_at',
  claimedRow?.rider_status === 'claimed' && typeof claimedRow?.rider_staff_id === 'string' && claimedRow?.claimed_at !== null,
  `row=${JSON.stringify(claimedRow)}`);

// ---------------------------------------------------------------------------
// 10) 状态机：骑手不能 cancel；顺序只能是 picked_up → delivered
// ---------------------------------------------------------------------------
const cancelTry = await postJson(`/api/staff/deliveries/${deliveryId}/status`, { status: 'cancelled' });
record('骑手不能 cancel：status=cancelled → 400 且 allowed 只列 picked_up/delivered',
  cancelTry.status === 400 && Array.isArray(cancelTry.json?.allowed)
    && cancelTry.json.allowed.join(',') === 'picked_up,delivered',
  `status=${cancelTry.status} body=${cancelTry.text.slice(0, 160)}`);

// ---------------------------------------------------------------------------
// 11) 骑手位置：合法坐标落库，非法坐标一个都不落
// ---------------------------------------------------------------------------
const positionReady = await postJson(`/api/staff/deliveries/${deliveryId}/position`, RIDER_POSITION_1);
record('POST position（真实经纬度）→ 200 且返回 recorded_at',
  positionReady.status === 200 && Number.isFinite(Date.parse(String(positionReady.json?.recorded_at))),
  `status=${positionReady.status} body=${positionReady.text.slice(0, 160)}`);

const stored1 = (await q(
  'select lat::float8 as lat, lng::float8 as lng, accuracy_m::float8 as accuracy_m, staff_id, recorded_at from public.delivery_positions where delivery_id=$1 order by recorded_at desc limit 1',
  [deliveryId],
))[0];
record('数据库旁证：坐标与精度原样落库（round-trip，不是只回了个 200）',
  stored1 !== undefined && stored1.lat === RIDER_POSITION_1.lat && stored1.lng === RIDER_POSITION_1.lng
    && stored1.accuracy_m === RIDER_POSITION_1.accuracy_m,
  `stored=${JSON.stringify(stored1 ?? null)} / posted=${JSON.stringify(RIDER_POSITION_1)}`);

const positionsAfterValid = await scalar('select count(*) from public.delivery_positions where delivery_id=$1', [deliveryId]);

const outOfRange = await postJson(`/api/staff/deliveries/${deliveryId}/position`, { lat: 999, lng: -73.99 });
record('lat=999 → 400 且 code=invalid_coordinates',
  outOfRange.status === 400 && outOfRange.json?.code === 'invalid_coordinates',
  `status=${outOfRange.status} body=${outOfRange.text.slice(0, 160)}`);

const stringLat = await postJson(`/api/staff/deliveries/${deliveryId}/position`, { lat: '40.7', lng: -73.99 });
record('lat 是字符串 "40.7" → 400（刻意不"尽力解析"，否则 NaN 迟早会溜进库）',
  stringLat.status === 400, `status=${stringLat.status} body=${stringLat.text.slice(0, 160)}`);

const nullLat = await postJson(`/api/staff/deliveries/${deliveryId}/position`, { lat: null, lng: -73.99 });
record('lat=null → 400', nullLat.status === 400, `status=${nullLat.status} body=${nullLat.text.slice(0, 160)}`);

// JSON 里写不出的 NaN：只能用**字面量** NaN 发原始文本。parse 失败也必须 400。
const nanRaw = await call(`/api/staff/deliveries/${deliveryId}/position`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"lat": NaN, "lng": -73.99}',
});
record('字面量 NaN（非法 JSON）→ 400，绝不允许变成库里的一行 NaN',
  nanRaw.status === 400, `status=${nanRaw.status} body=${nanRaw.text.slice(0, 160)}`);

const lngOutOfRange = await postJson(`/api/staff/deliveries/${deliveryId}/position`, { lat: 40.7, lng: 200 });
record('lng=200 → 400', lngOutOfRange.status === 400, `status=${lngOutOfRange.status} body=${lngOutOfRange.text.slice(0, 160)}`);

const positionsAfterInvalid = await scalar('select count(*) from public.delivery_positions where delivery_id=$1', [deliveryId]);
record('四次非法上报之后位置行数没有增加（旁证：拒绝是真的没写）',
  positionsAfterInvalid === positionsAfterValid,
  `合法后=${positionsAfterValid} 非法后=${positionsAfterInvalid}`);

// ---------------------------------------------------------------------------
// 12) 顾客端追踪（无目的坐标）：有位置就报位置，没有 ETA 就说没有
// ---------------------------------------------------------------------------
const trackBefore = await call(`/api/store/deliveries/${deliveryId}/track?token=${webToken}`, {}, { session: false });
record('GET track（公开、无需会话）→ 200 且骑手坐标与上报值一致',
  trackBefore.status === 200 && trackBefore.json?.rider?.lat === RIDER_POSITION_1.lat
    && trackBefore.json?.rider?.lng === RIDER_POSITION_1.lng,
  `status=${trackBefore.status} rider=${JSON.stringify(trackBefore.json?.rider)} / posted=${JSON.stringify(RIDER_POSITION_1)}`);
record('track 返回的状态/承诺时间/地址与库里一致',
  trackBefore.json?.rider_status === 'claimed'
    // 承诺时间比较的是**时刻**而不是字符串：PostgREST 回的是 `+00:00`，
    // 下单响应是 `.toISOString()` 的 `Z`，字面比较会假失败。
    && Date.parse(String(trackBefore.json?.promised_at)) === Date.parse(String(created.json?.promised_at))
    && trackBefore.json?.destination?.address_line === ORDER.address_line,
  `rider_status=${JSON.stringify(trackBefore.json?.rider_status)} promised_at=${JSON.stringify(trackBefore.json?.promised_at)} destination=${JSON.stringify(trackBefore.json?.destination)}`);
// Phase 18 §4.1：这一单**带了**顾客设备坐标，因此 estimate 真的有值 ——
// 这正是修复的证明。修复前 dest_lat/dest_lng 没有写路径，这里只能是 null。
record('本单带顾客定位 ⇒ estimate 真的有值（修复前这里恒为 null，ETA 不可达）',
  trackBefore.json?.estimate !== null && Number.isFinite(Number(trackBefore.json?.estimate?.etaMinutes)),
  `estimate=${JSON.stringify(trackBefore.json?.estimate)}`);
record('本单的 destination_coordinates 等于下单时提供的坐标（不是店铺坐标，也不是编的）',
  trackBefore.json?.destination_coordinates?.lat === DESTINATION.lat
    && trackBefore.json?.destination_coordinates?.lng === DESTINATION.lng,
  `destination_coordinates=${JSON.stringify(trackBefore.json?.destination_coordinates)} / 请求 ${JSON.stringify(DESTINATION)}`);

// --- 追踪响应不含骑手身份（响应级）------------------------------------------
const trackKeys = collectKeys(trackBefore.json);
const leaked = RIDER_IDENTITY_FIELDS.filter((field) => trackKeys.includes(field));
record('追踪响应里没有任何骑手身份字段（姓名/电话/员工 id 一个都没有）',
  leaked.length === 0,
  `违规字段=${JSON.stringify(leaked)} 全部键=${JSON.stringify([...new Set(trackKeys)])}`);
record('rider 对象的键恰好是 lat/lng/recorded_at（多一个字段都要问一句"顾客需要吗"）',
  JSON.stringify(Object.keys(trackBefore.json?.rider ?? {}).sort()) === JSON.stringify(['lat', 'lng', 'recorded_at']),
  `keys=${JSON.stringify(Object.keys(trackBefore.json?.rider ?? {}))}`);

// --- 追踪响应不含骑手身份（源码级）------------------------------------------
const trackSource = readFileSync('src/app/api/store/deliveries/[id]/track/route.ts', 'utf8');
const identityRe = /(rider_name|rider_phone|recipient_name|recipient_phone|staff_name|rider_staff_id)/;
const identityHits = stripComments(trackSource).match(new RegExp(identityRe, 'g')) ?? [];
record('源码级：track 路由（去掉注释后）不出现任何身份字段名',
  identityHits.length === 0,
  `命中=${JSON.stringify(identityHits)}`);
record('源码级负向对照：同一 matcher 必须能拒绝一个"带身份字段"的合成响应',
  identityRe.test("NextResponse.json({ rider: { lat: 1, lng: 2 }, rider_name: 'Li', recipient_phone: '555' })")
    && identityHits.length === 0,
  '合成片段 rider_name/recipient_phone 被同一正则命中 → 上面的"0 命中"才算数');

// ---------------------------------------------------------------------------
// 13) 收货坐标：由**产品路径**写入（不再是 fixture 补数据）
//
// Phase 18 §4.1 修的就是这一段：此前 `dest_lat/dest_lng` 只有读、没有写，
// 追踪接口因此永远拿不到目的地，`estimate` 恒为 null。现在下单请求带
// 顾客设备定位（见 orderBody），下面验证它真的落了库。
// ---------------------------------------------------------------------------
const storedDest = await pool.query(
  'select dest_lat, dest_lng from public.delivery_orders where id=$1 and tenant_id=$2 and business_id=$3',
  [deliveryId, TENANT, BUSINESS],
);
const storedLat = storedDest.rows[0]?.dest_lat === null || storedDest.rows[0]?.dest_lat === undefined
  ? null : Number(storedDest.rows[0].dest_lat);
const storedLng = storedDest.rows[0]?.dest_lng === null || storedDest.rows[0]?.dest_lng === undefined
  ? null : Number(storedDest.rows[0].dest_lng);
record('产品路径：下单请求带的顾客定位真的写进了 delivery_orders.dest_lat/dest_lng',
  storedLat !== null && storedLng !== null
    && Math.abs(storedLat - DESTINATION.lat) < 1e-6 && Math.abs(storedLng - DESTINATION.lng) < 1e-6,
  `库中 dest_lat=${storedLat} dest_lng=${storedLng} / 请求 ${DESTINATION.lat}/${DESTINATION.lng}`);

record('201 响应同时返回 delivery_id 与确认写入的坐标（调用方不必再猜）',
  typeof created.json?.delivery_id === 'string' && created.json.delivery_id.length === 36
    && created.json?.destination_coordinates?.lat === DESTINATION.lat,
  `delivery_id=${JSON.stringify(created.json?.delivery_id)} destination_coordinates=${JSON.stringify(created.json?.destination_coordinates)}`);

// 负向对照 1：只给一个坐标 ⇒ 400（静默丢弃会让客户端以为定位生效了）
const halfCoords = await postJson('/api/store/delivery-orders', {
  ...orderBody,
  dest_lng: undefined,
}, { 'Idempotency-Key': `verify-half-coords-${Date.now()}` }, { session: false });
record('只给 dest_lat 不给 dest_lng ⇒ 400 invalid_destination_coordinates（fail-closed）',
  halfCoords.status === 400 && halfCoords.json?.error === 'invalid_destination_coordinates',
  `status=${halfCoords.status} error=${JSON.stringify(halfCoords.json?.error)}`);

// 负向对照 2：给非法坐标 ⇒ 400，且**不落单**
const badCoordsKey = `verify-bad-coords-${Date.now()}`;
const badCoords = await postJson('/api/store/delivery-orders', {
  ...orderBody,
  dest_lat: 999,
  dest_lng: 999,
}, { 'Idempotency-Key': badCoordsKey }, { session: false });
record('非法坐标（999/999）⇒ 400，不落任何订单行',
  badCoords.status === 400 && (await scalar(
    'select count(*) from public.orders where tenant_id=$1 and business_id=$2 and external_id=$3',
    [TENANT, BUSINESS, badCoordsKey],
  )) === 0,
  `status=${badCoords.status} error=${JSON.stringify(badCoords.json?.error)}`);

// 负向对照 3：完全不传坐标 ⇒ 201 且落 NULL（顾客拒绝授权是正常路径，不是错误）
const noCoordsKey = `verify-no-coords-${Date.now()}`;
const noCoordsBody = { ...orderBody };
delete noCoordsBody.dest_lat;
delete noCoordsBody.dest_lng;
const noCoords = await postJson('/api/store/delivery-orders', noCoordsBody, { 'Idempotency-Key': noCoordsKey }, { session: false });
const noCoordsRow = await pool.query(
  'select id, dest_lat, dest_lng from public.delivery_orders where order_id=$1 and tenant_id=$2 and business_id=$3',
  [noCoords.json?.order_id, TENANT, BUSINESS],
);
record('不传坐标 ⇒ 201 且 dest_lat/dest_lng 为 NULL（拒绝授权是正常路径，不编坐标）',
  noCoords.status === 201
    && noCoords.json?.destination_coordinates === null
    && noCoordsRow.rows[0]?.dest_lat === null && noCoordsRow.rows[0]?.dest_lng === null,
  `status=${noCoords.status} coords=${JSON.stringify(noCoords.json?.destination_coordinates)} 库中=${JSON.stringify(noCoordsRow.rows[0] ?? null)}`);

// 负向对照 4：**没有**坐标的那一单，其 estimate 必须是 null。
// 这是"不编 ETA、也不回落成店铺坐标"的唯一可失败证据 —— 靠对比两单得出。
{
  const noCoordsDeliveryId = noCoordsRow.rows[0]?.id
    ?? (await pool.query(
      'select id from public.delivery_orders where order_id=$1 and tenant_id=$2 and business_id=$3',
      [noCoords.json?.order_id, TENANT, BUSINESS],
    )).rows[0]?.id;
  const noCoordsTrack = await call(`/api/store/deliveries/${noCoordsDeliveryId}/track?token=${webToken}`, {}, { session: false });
  record('没有目的坐标的那一单：estimate=null 且 destination_coordinates=null（不编 ETA、不回落店铺坐标）',
    noCoordsTrack.status === 200
      && noCoordsTrack.json?.estimate === null
      && noCoordsTrack.json?.destination_coordinates === null,
    `status=${noCoordsTrack.status} estimate=${JSON.stringify(noCoordsTrack.json?.estimate)} coords=${JSON.stringify(noCoordsTrack.json?.destination_coordinates)}`);
}

// 源码级：仍然只有**这一条**诚实来源。员工的派单接口不许写坐标 ——
// 骑手改目的地会让顾客看到的 ETA 与自己的地址不符。
const fixSource = readFileSync('src/app/api/store/delivery-orders/route.ts', 'utf8');
const fixSource2 = readFileSync('src/app/api/team/delivery/route.ts', 'utf8');
record('源码级：只有顾客下单路由写 dest_lat/dest_lng（派单路由不写）',
  stripComments(fixSource).includes('dest_lat') && !stripComments(fixSource2).includes('dest_lat'),
  `delivery-orders 命中=${stripComments(fixSource).includes('dest_lat')} team/delivery 命中=${stripComments(fixSource2).includes('dest_lat')}`);
record('源码级负向对照：同一 matcher 能命中一个写了 dest_lat 的合成片段',
  stripComments("update('delivery_orders').update({ dest_lat: 1, dest_lng: 2 })").includes('dest_lat'),
  '合成片段含 dest_lat → 上面的"派单路由不含"才算数');

// ---------------------------------------------------------------------------
// 14) 顾客端追踪（有目的坐标）：ETA 是估算、且与本地独立复算一致
// ---------------------------------------------------------------------------
const trackAfter = await call(`/api/store/deliveries/${deliveryId}/track?token=${webToken}`, {}, { session: false });
const expectedKm = haversineKm({ lat: RIDER_POSITION_1.lat, lng: RIDER_POSITION_1.lng }, DESTINATION);
const reportedKm = Number(trackAfter.json?.estimate?.distanceKm);
record('estimate 带 isEstimate=true（UI 无法把它当成实时 GPS 预测）',
  trackAfter.json?.estimate?.isEstimate === true,
  `estimate=${JSON.stringify(trackAfter.json?.estimate)}`);
record('estimate 的距离与本地 haversine 独立复算一致（误差 < 0.01 km）',
  Number.isFinite(reportedKm) && Math.abs(reportedKm - expectedKm) < 0.01,
  `接口=${reportedKm} 本地=${expectedKm.toFixed(6)}`);
record('estimate 的分钟数与本地按同一公式复算一致，且系数如实带出（roadFactor=1.35 / 22km/h）',
  trackAfter.json?.estimate?.etaMinutes === expectedEtaMinutes(reportedKm)
    && trackAfter.json?.estimate?.roadFactor === ROAD_FACTOR
    && trackAfter.json?.estimate?.averageSpeedKmh === AVERAGE_SPEED_KMH,
  `etaMinutes=${trackAfter.json?.estimate?.etaMinutes} 本地=${expectedEtaMinutes(reportedKm)} roadFactor=${trackAfter.json?.estimate?.roadFactor} speed=${trackAfter.json?.estimate?.averageSpeedKmh}`);
const etaFirst = Number(trackAfter.json?.estimate?.etaMinutes);

// ---------------------------------------------------------------------------
// 15) 状态推进 picked_up → delivered，位置随之更新，之后一切写操作都停
// ---------------------------------------------------------------------------
const picked = await postJson(`/api/staff/deliveries/${deliveryId}/status`, { status: 'picked_up' });
record('status=picked_up → 200', picked.status === 200 && picked.json?.rider_status === 'picked_up',
  `status=${picked.status} body=${picked.text.slice(0, 160)}`);
const pickedRow = (await q('select rider_status, picked_up_at from public.delivery_orders where id=$1', [deliveryId]))[0];
record('数据库旁证：picked_up_at 已写入（不是只回了 200）',
  pickedRow?.rider_status === 'picked_up' && pickedRow?.picked_up_at !== null,
  `row=${JSON.stringify(pickedRow)}`);

const positionMoved = await postJson(`/api/staff/deliveries/${deliveryId}/position`, RIDER_POSITION_2);
record('配送途中继续上报位置（picked_up 状态仍允许）→ 200',
  positionMoved.status === 200, `status=${positionMoved.status} body=${positionMoved.text.slice(0, 160)}`);

const trackMoved = await call(`/api/store/deliveries/${deliveryId}/track?token=${webToken}`, {}, { session: false });
record('track 给的是**最新**一条位置，不是第一条',
  trackMoved.json?.rider?.lat === RIDER_POSITION_2.lat && trackMoved.json?.rider?.lng === RIDER_POSITION_2.lng,
  `rider=${JSON.stringify(trackMoved.json?.rider)} / 最新上报=${JSON.stringify(RIDER_POSITION_2)}`);
record('ETA 跟着位置走：更靠近目的地之后距离与分钟数都变小（不是写死的数）',
  Number(trackMoved.json?.estimate?.distanceKm) < reportedKm
    && Number(trackMoved.json?.estimate?.etaMinutes) <= etaFirst,
  `距离 ${reportedKm} → ${trackMoved.json?.estimate?.distanceKm}；分钟 ${etaFirst} → ${trackMoved.json?.estimate?.etaMinutes}`);

const delivered = await postJson(`/api/staff/deliveries/${deliveryId}/status`, { status: 'delivered' });
record('status=delivered → 200', delivered.status === 200 && delivered.json?.rider_status === 'delivered',
  `status=${delivered.status} body=${delivered.text.slice(0, 160)}`);

const settled = await postJson(`/api/staff/deliveries/${deliveryId}/status`, { status: 'picked_up' });
record('已送达之后再推进 → 409 且 code=already_settled（断言的是 code）',
  settled.status === 409 && settled.json?.code === 'already_settled',
  `status=${settled.status} code=${JSON.stringify(settled.json?.code)} body=${settled.text.slice(0, 160)}`);

const positionsBeforeClosed = await scalar('select count(*) from public.delivery_positions where delivery_id=$1', [deliveryId]);
const positionAfterDelivered = await postJson(`/api/staff/deliveries/${deliveryId}/position`, { lat: 40.75, lng: -73.99 });
record('隐私边界：单子结束后拒绝继续上报位置 → 409 且 code=not_active',
  positionAfterDelivered.status === 409 && positionAfterDelivered.json?.code === 'not_active',
  `status=${positionAfterDelivered.status} code=${JSON.stringify(positionAfterDelivered.json?.code)} body=${positionAfterDelivered.text.slice(0, 160)}`);
const positionsAfterClosed = await scalar('select count(*) from public.delivery_positions where delivery_id=$1', [deliveryId]);
record('单子结束后的那次上报确实一行都没写（位置数据不再被持有）',
  positionsAfterClosed === positionsBeforeClosed,
  `送达前=${positionsBeforeClosed} 送达后=${positionsAfterClosed}`);

const trackEnd = await call(`/api/store/deliveries/${deliveryId}/track?token=${webToken}`, {}, { session: false });
record('顾客看得到最终状态：track 的 rider_status=delivered 且仍带最后位置',
  trackEnd.status === 200 && trackEnd.json?.rider_status === 'delivered' && trackEnd.json?.rider?.lat === RIDER_POSITION_2.lat,
  `rider_status=${JSON.stringify(trackEnd.json?.rider_status)} rider=${JSON.stringify(trackEnd.json?.rider)}`);

// ---------------------------------------------------------------------------
// 16) 追踪的失败语义：一律 404，永远不 403
// ---------------------------------------------------------------------------
const ghostTrack = await call(`/api/store/deliveries/11111111-2222-4333-8444-555555555555/track?token=${webToken}`, {}, { session: false });
record('负向对照：追踪不存在的单 → 404（不是 403 —— 403 等于承认这张单存在，可被用来枚举订单）',
  ghostTrack.status === 404, `status=${ghostTrack.status} body=${ghostTrack.text.slice(0, 160)}`);

const garbageTrack = await call(`/api/store/deliveries/${'x'.repeat(40)}/track?token=${webToken}`, {}, { session: false });
record('负向对照：id 形态不合法 → 同样 404（400 与 404 的差异本身就能被用来探测 id 形态）',
  garbageTrack.status === 404, `status=${garbageTrack.status} body=${garbageTrack.text.slice(0, 160)}`);

const noTokenTrack = await call(`/api/store/deliveries/${deliveryId}/track`, {}, { session: false });
record('负向对照：不带 token 追踪 → 404（公开接口的身份来自 token，不是"公开就等于谁都能看"）',
  noTokenTrack.status === 404, `status=${noTokenTrack.status} body=${noTokenTrack.text.slice(0, 160)}`);

const wrongTokenTrack = await call(`/api/store/deliveries/${deliveryId}/track?token=${'a'.repeat(40)}`, {}, { session: false });
record('负向对照：伪造 token → 404', wrongTokenTrack.status === 404, `status=${wrongTokenTrack.status} body=${wrongTokenTrack.text.slice(0, 160)}`);

// ---------------------------------------------------------------------------
// 17) 店长看板不是公开的：无会话 401 / 员工会话 403
// ---------------------------------------------------------------------------
const teamAnon = await call('/api/team/delivery', {}, { session: false });
record('GET /api/team/delivery 无会话 → 401（全店配送单与规则不对外公开）',
  teamAnon.status === 401, `status=${teamAnon.status} body=${teamAnon.text.slice(0, 160)}`);

const teamAsStaff = await call('/api/team/delivery');
record('负向对照（差分）：带员工会话 → 403 而不是 401（401 是"没登录"，403 是"登录了但不够格"）',
  teamAsStaff.status === 403, `status=${teamAsStaff.status} body=${teamAsStaff.text.slice(0, 160)}`);

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
const after = await deliveredCounts();
const failed = results.filter((row) => !row.pass).length;

console.log(`\nbase = ${BASE}   as = ${EMAIL}   slug = ${SLUG}`);
console.log(`来源 IP（X-Forwarded-For）= ${XFF || '(不发该头，落回 unknown 桶)'}\n`);
for (const row of results) {
  console.log(`  ${row.pass ? '[ok]  ' : '[FAIL]'} ${row.label}\n         ${row.detail}`);
}
console.log(`\n${'='.repeat(78)}`);
console.log('留下的数据（本轮不自动清理）：');
console.log(`  settings.delivery = ${JSON.stringify(rules)}`);
console.log(`  delivery_orders delta = ${after.deliveries - before.deliveries}（其中本单 ${deliveryId} 已 delivered）`);
console.log(`  delivery_positions delta = ${after.positions - before.positions}`);
console.log(`  orders(source='web') delta = ${after.web_orders - before.web_orders}`);
console.log(`  audit_logs delta = ${after.audit - before.audit}（中央守卫每次写操作留 started + outcome 两行；审计是证据，脚本不删）`);
console.log('  一行清理：npx tsx scripts/_seed_demo_delivery.mts --cleanup');
console.log('='.repeat(78));

if (failed === 0) {
  console.log(`外卖全链路验证通过：${results.length}/${results.length}`);
  console.log('用的是真实登录拿到的会话 cookie（rf_session），链路全部走真实 HTTP。');
} else {
  console.log(`${failed}/${results.length} 项失败`);
  for (const row of results.filter((item) => !item.pass)) console.log(`  - ${row.label}\n    ${row.detail}`);
}

await pool.end();
process.exit(failed === 0 ? 0 : 1);
