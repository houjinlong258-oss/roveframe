/**
 * 让外卖链路第一次有真实数据：开启配送规则 + 用**公开下单接口**造一张真外卖单。
 *
 * ## 这一步填的是哪个空白
 *
 * 外卖这条链（顾客下单 → 员工接单 → 状态推进 → 骑手位置 → 顾客看 ETA）代码、
 * 迁移、守卫测试都在，但库里 `delivery_orders` 是 0 行、`settings.delivery` 是 `{}`：
 * 配送根本没开启，顾客端 PWA 连外卖 tab 都不渲染（`CustomerPwa.tsx:604` 用
 * `config.modes.delivery` 决定）。于是所有关于它的断言只能停在源码级。
 *
 * ## 为什么走 HTTP 而不是直接 INSERT
 *
 * 直接写 `orders` + `delivery_orders` 只能证明"表能存数据"，证明不了**下单路径能用**：
 * 服务端按 `products` 表计价、幂等键与内容指纹、起送判定、规则快照
 * （`fee` / `min_order_amount` / `promised_at`）全都在路由里（`src/lib/delivery.ts`）。
 * 因此这张单子由 `POST /api/store/delivery-orders` 产生 —— 与顾客端点的是同一个按钮。
 * 代价是必须先有服务在跑（默认 http://127.0.0.1:5067）。
 *
 * ## 两处产品缺陷（只报告，不在这里修）
 *
 * 1. **`orders.idempotency_fingerprint` 是 varchar(128)，而外卖指纹会超过它。**
 *    指纹是 `商品id×数量,…|小计|配送费|地址|电话`（`deliveryContentFingerprint`），
 *    两个商品的 uuid 就占 77 字符，加上金额、地址、电话，一条**正常长度**的收货地址
 *    （`455 W 37th St, Apt 12F, New York, NY 10018` + `+1 212 555 0184`）算出来是
 *    **147 字符** → 插入抛 22001，接口返回 500 `value too long for type character
 *    varying(128)`。即：**2 件商品的外卖单在真实地址下根本下不成功**。
 *    （列宽来自 `scripts/migrate-email-compliance.sql:60`。）
 *
 *    因此本脚本的收货地址是**为迁就这 128 字符而压缩过的**真实地址
 *    （`455 W 37th St, Apt 12F, NY` + 10 位电话 = 指纹 126 字符）。
 *    脚本会自己算一遍指纹长度，超过 128 就直接失败，不把这个问题悄悄吞掉。
 *    验证脚本里另有一条"缺陷探针"用正常长度的地址把这 500 复现出来。
 *
 * 2. **`delivery_orders.dest_lat/dest_lng`（收货坐标）只有读、没有写。**
 *    下单路由不写、老板端 PATCH 不写、任何页面也不写。于是
 *    `GET /api/store/deliveries/{id}/track` 的 `estimate` 恒为 null ——
 *    顾客永远看不到预计送达时间（track 路由第 104 行
 *    `estimateForDelivery(position, destination)` 需要目的地坐标才能算）。
 *    本脚本因此在下单之后显式补写这两个坐标，让 ETA 这条分支至少能被真实 HTTP
 *    走一遍。**这是补数据，不是修代码**：缺陷本身留给 owner 处置。
 *
 * ## 幂等
 *
 * 本店已有外卖单就**复用**（不造第二张）；规则是同一组值的覆盖写。
 * `--cleanup` 精确删掉本脚本造的东西：位置行 → 配送行 → web 订单 → 规则复位为 `{}`。
 *
 * ## 一条不相干的开关（本脚本刻意不碰）
 *
 * 员工端还有一道「这家店对员工开放外卖吗」的偏好开关，寄存在
 * `settings.wellbeing.staff_access.delivery`（`src/lib/staff-access.ts`，**默认开**）。
 * 本脚本不写它：默认值已经是开，而那个键由另一条写入路径按"读-合并-写"维护，
 * 两个脚本各自整块覆盖同一个 jsonb 列迟早会互相抹掉。
 *
 * 用法（凭据只走环境变量，不落盘）：
 *   $env:PGHOST=...; $env:PGUSER=...; $env:PGPASSWORD=...
 *   npx tsx scripts/_seed_demo_delivery.mts
 *   npx tsx scripts/_seed_demo_delivery.mts --cleanup
 */
import { Pool } from 'pg';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';
/** 顾客端 PWA 的站点 slug（`/api/site/config?slug=` 用它解析出 tenant/business）。 */
const SLUG = 'demo-bistro';
/** 服务地址：验证/种子的 HTTP 都打真实进程，不做任何"直接调 handler"的捷径。 */
const BASE = process.env.DELIVERY_BASE_URL ?? 'http://127.0.0.1:5067';

/**
 * 固定的幂等键。哪怕复用分支被绕过（例如有人手工删了配送行），
 * 同一个 key 也只会落一张单 —— 这是第二道保险，不是唯一一道。
 */
const IDEMPOTENCY_KEY = 'demo-delivery-seed-v1';

/** 老板在设置里能配的那 5 个字段，与 `normalizeDeliveryRules` 的字段一一对应。 */
const RULES = {
  enabled: true,
  minOrderAmount: 20,
  fee: 3,
  freeDeliveryAbove: 50,
  prepMinutes: 35,
} as const;

/** 按菜名挑商品，而不是硬编码 uuid：库重建后 uuid 会变，菜名不会。 */
const ITEM_NAMES = ['麻婆豆腐 Mapo Tofu', '手搓冰粉 Handmade Ice Jelly'] as const;

/**
 * 收货信息。地址与电话被**刻意压短**到能塞进 varchar(128) 的指纹里
 * （见文件头缺陷 1）：正常写法会算出 147 字符 → 500。
 * 这是真实可送达的纽约地址，只是省掉了 city/state/zip（电话是完整号码）。
 */
const RECIPIENT = {
  name: 'Amelia Chen',
  phone: '2125550184',
  address: '455 W 37th St, Apt 12F, NY',
  addressNote: 'Ring buzzer 12F; leave at the door if no answer.',
  notes: 'Mild please, one extra set of chopsticks.',
};

/** 与上面地址对应的真实坐标（曼哈顿 37 街西段）。只用于补 dest_lat/dest_lng。 */
const DESTINATION = { lat: 40.7554, lng: -73.993 };

/**
 * `orders.idempotency_fingerprint` 的列宽（scripts/migrate-email-compliance.sql:60）。
 * 这里复刻一遍 `deliveryContentFingerprint` 的拼法做长度自检：宁可脚本自己拒绝运行，
 * 也不要发一个必然 500 的请求出去。
 */
const MAX_FINGERPRINT_CHARS = 128;

function fingerprintLength(
  productIds: readonly string[],
  subtotal: number,
  fee: number,
  addressLine: string,
  recipientPhone: string,
): number {
  const items = [...productIds].map((id) => `${id}x1`).sort().join(',');
  return `${items}|${subtotal.toFixed(2)}|${fee.toFixed(2)}|${addressLine}|${recipientPhone}`.length;
}

const cleanup = process.argv.includes('--cleanup');

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

if (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGPASSWORD) {
  console.error('缺 PGHOST / PGUSER / PGPASSWORD（凭据只从环境变量读，不写文件）');
  process.exit(2);
}

const money = (value: number): number => Math.round(value * 100) / 100;

interface ProductRow {
  id: string;
  name: string;
  price: string;
}

interface ExistingDeliveryRow {
  id: string;
  order_id: string;
  order_no: string;
  fee: string;
  total: string;
  rider_status: string;
  promised_at: string | null;
  dest_lat: string | null;
  dest_lng: string | null;
}

interface CountRow {
  delivery_orders: string;
  delivery_positions: string;
  web_orders: string;
  orders_all: string;
}

/** 现有外卖单（本店最早的一张）。没有就返回 null —— 幂等的判据。 */
async function findExistingDelivery(): Promise<ExistingDeliveryRow | null> {
  const result = await pool.query<ExistingDeliveryRow>(
    `select d.id, d.order_id, o.order_no, d.fee, o.total, d.rider_status,
            d.promised_at, d.dest_lat, d.dest_lng
       from public.delivery_orders d
       join public.orders o on o.id = d.order_id
      where d.tenant_id = $1 and d.business_id = $2
      order by d.created_at asc
      limit 1`,
    [TENANT, BUSINESS],
  );
  return result.rows[0] ?? null;
}

async function counts(): Promise<CountRow> {
  const result = await pool.query<CountRow>(
    `select
       (select count(*)::text from public.delivery_orders where tenant_id = $1 and business_id = $2) as delivery_orders,
       (select count(*)::text from public.delivery_positions where tenant_id = $1 and business_id = $2) as delivery_positions,
       (select count(*)::text from public.orders where tenant_id = $1 and business_id = $2 and source = 'web') as web_orders,
       (select count(*)::text from public.orders where tenant_id = $1 and business_id = $2) as orders_all`,
    [TENANT, BUSINESS],
  );
  return result.rows[0];
}

/** WEB 桌码 token：顾客端外卖下单就是拿它当身份（`resolvePublicStore`）。 */
async function webToken(): Promise<string> {
  const result = await pool.query<{ public_token: string }>(
    `select public_token from public.store_qr_codes
      where tenant_id = $1 and business_id = $2 and table_no = 'WEB' and is_active = true
      limit 1`,
    [TENANT, BUSINESS],
  );
  const token = result.rows[0]?.public_token;
  if (!token) {
    // 没有 token 就没有"顾客身份"这条路 —— 明确失败，不退回任何替代方案。
    throw new Error('本店没有激活的 WEB 桌码（store_qr_codes.table_no = WEB），无法走公开下单');
  }
  return token;
}

async function loadProducts(): Promise<Map<string, ProductRow>> {
  const result = await pool.query<ProductRow>(
    `select id, name, price from public.products
      where tenant_id = $1 and business_id = $2 and status = 'active' and name = any($3::text[])`,
    [TENANT, BUSINESS, [...ITEM_NAMES]],
  );
  const byName = new Map(result.rows.map((row) => [row.name, row]));
  for (const name of ITEM_NAMES) {
    if (!byName.has(name)) throw new Error(`商品不存在或已下架：${name}`);
  }
  return byName;
}

/**
 * 把配送规则写进 `settings.delivery`（jsonb 列）。
 *
 * 用单列 UPDATE 而不是整行覆盖：`business` / `locale` / `ai_prefs` / `model_assign`
 * 是同一行上的兄弟列，整行写会把它们抹掉。行不存在时**不新建** ——
 * app 的 `updateSettings` 会 insert 一行，这里不替它做这个决定。
 */
async function writeRules(): Promise<{ previous: unknown; written: typeof RULES }> {
  const before = await pool.query<{ delivery: unknown }>(
    'select delivery from public.settings where tenant_id = $1 and business_id = $2',
    [TENANT, BUSINESS],
  );
  if (before.rowCount !== 1) {
    throw new Error(`settings 行不存在（命中 ${before.rowCount ?? 0} 行），拒绝凭空新建一行`);
  }
  const updated = await pool.query(
    `update public.settings set delivery = $3::jsonb, updated_at = now()
      where tenant_id = $1 and business_id = $2`,
    [TENANT, BUSINESS, JSON.stringify({ ...RULES })],
  );
  if (updated.rowCount !== 1) throw new Error(`规则写入命中 ${updated.rowCount ?? 0} 行，期望 1 行`);
  return { previous: before.rows[0].delivery, written: RULES };
}

interface CreateResponse {
  order_id?: string;
  order_no?: string;
  subtotal?: number;
  fee?: number;
  total?: number;
  promised_at?: string;
  delivery_id?: string;
  error?: string;
  detail?: string;
  shortfall?: number;
}

/** 走顾客端同一个接口下单。失败时把响应体原样带出来，不做任何静默回落。 */
async function createOrderViaPublicApi(
  token: string,
  products: Map<string, ProductRow>,
  subtotal: number,
): Promise<CreateResponse> {
  const productIds = ITEM_NAMES.map((name) => products.get(name)!.id);
  const expectedFee = subtotal >= RULES.freeDeliveryAbove ? 0 : RULES.fee;

  // 前置自检：指纹长度超列宽的话，这个请求必然 500。与其发出去拿一个
  // "value too long" 回来，不如在这里就指名说出是哪一列、差多少字符。
  const fingerprintChars = fingerprintLength(
    productIds, subtotal, expectedFee, RECIPIENT.address, RECIPIENT.phone,
  );
  if (fingerprintChars > MAX_FINGERPRINT_CHARS) {
    throw new Error(
      `幂等指纹 ${fingerprintChars} 字符 > orders.idempotency_fingerprint 的 ${MAX_FINGERPRINT_CHARS}；`
      + '这是产品缺陷（见文件头缺陷 1），需要先改列宽或指纹算法',
    );
  }

  const body = {
    token,
    items: productIds.map((productId) => ({ product_id: productId, qty: 1 })),
    recipient_name: RECIPIENT.name,
    recipient_phone: RECIPIENT.phone,
    address_line: RECIPIENT.address,
    address_note: RECIPIENT.addressNote,
    notes: RECIPIENT.notes,
  };

  let response: Response;
  try {
    response = await fetch(`${BASE}/api/store/delivery-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `${BASE} 不可达（${error instanceof Error ? error.message : String(error)}）；先起服务：npx next start -p 5067`,
    );
  }

  const text = await response.text();
  let parsed: CreateResponse;
  try {
    parsed = JSON.parse(text) as CreateResponse;
  } catch {
    throw new Error(`下单返回非 JSON：HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (response.status !== 201) {
    throw new Error(`下单失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  // 服务端计价是权威值，必须与本地按 products 表算出的期望一致 —— 不一致说明
  // 规则没生效或价格读错，此时宁可失败也不要留下一个"看起来正常"的种子单。
  if (parsed.subtotal !== subtotal) {
    throw new Error(`小计不符：接口 ${String(parsed.subtotal)} / 期望 ${subtotal}`);
  }
  if (parsed.fee !== expectedFee) {
    throw new Error(`配送费不符：接口 ${String(parsed.fee)} / 期望 ${expectedFee}（规则 ${JSON.stringify(RULES)}）`);
  }
  if (parsed.total !== money(subtotal + expectedFee)) {
    throw new Error(`总额不符：接口 ${String(parsed.total)} / 期望 ${money(subtotal + expectedFee)}`);
  }
  return parsed;
}

/**
 * 补写收货坐标。理由见文件头：产品代码里没有任何写 `dest_lat/dest_lng` 的路径，
 * 不补这一步，track 的 ETA 分支永远走不到。幂等：每次写成同一组值。
 */
async function writeDestination(deliveryId: string): Promise<number> {
  const result = await pool.query(
    `update public.delivery_orders set dest_lat = $2, dest_lng = $3, updated_at = now()
      where id = $1 and tenant_id = $4 and business_id = $5`,
    [deliveryId, DESTINATION.lat, DESTINATION.lng, TENANT, BUSINESS],
  );
  return result.rowCount ?? 0;
}

async function run(): Promise<void> {
  if (cleanup) {
    const before = await counts();
    const client = await pool.connect();
    try {
      await client.query('begin');
      // 顺序不能反：位置行引用配送单，配送单引用订单。
      const positions = await client.query(
        'delete from public.delivery_positions where tenant_id = $1 and business_id = $2',
        [TENANT, BUSINESS],
      );
      const orderIds = await client.query<{ order_id: string }>(
        'select order_id from public.delivery_orders where tenant_id = $1 and business_id = $2',
        [TENANT, BUSINESS],
      );
      const deliveries = await client.query(
        'delete from public.delivery_orders where tenant_id = $1 and business_id = $2',
        [TENANT, BUSINESS],
      );
      // 只删"有配送单的订单"，绝不碰扫码堂食单。
      // 注意 `orders.id` 是 varchar(36) 而不是 uuid 类型：`any($3::uuid[])` 会报
      // "operator does not exist: character varying = uuid"（实测踩过）。
      const orders = await client.query(
        `delete from public.orders
          where tenant_id = $1 and business_id = $2 and id = any($3::text[])`,
        [TENANT, BUSINESS, orderIds.rows.map((row) => row.order_id)],
      );
      // 规则复位成 `{}`（脚本开工前的原值），兄弟列 business/locale/... 不动。
      await client.query(
        `update public.settings set delivery = '{}'::jsonb, updated_at = now()
          where tenant_id = $1 and business_id = $2`,
        [TENANT, BUSINESS],
      );
      await client.query('commit');
      console.log(JSON.stringify({
        cleaned: {
          delivery_positions: positions.rowCount,
          delivery_orders: deliveries.rowCount,
          orders: orders.rowCount,
          settings_delivery: '{}',
        },
        audit_logs: '不清理（审计是证据，所以它不会回到之前的值 —— 这是设计）',
        before,
        after: await counts(),
      }, null, 2));
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    // 注意：`audit_logs`（中央守卫写的审计表，src/lib/audit.ts:57）**不删**。
    // 每次写操作都会留 started + outcome 两行，删审计等于抹掉"谁在什么时候动了哪一单"
    // 的证据。所以 --cleanup 之后 audit_logs 不会回到之前的值 —— 这是设计，不是漏删。
    return;
  }

  const rules = await writeRules();
  const token = await webToken();
  const products = await loadProducts();
  const subtotal = money(
    ITEM_NAMES.reduce((sum, name) => sum + Number(products.get(name)!.price), 0),
  );
  // 前置条件：小计必须落在 [起送价, 免配送门槛) 里，否则这张种子单证明不了"配送费按规则收"。
  if (subtotal < RULES.minOrderAmount || subtotal >= RULES.freeDeliveryAbove) {
    throw new Error(
      `所选菜品的合计 ${subtotal} 不在 [${RULES.minOrderAmount}, ${RULES.freeDeliveryAbove}) 区间，种子单无法证明配送费路径`,
    );
  }

  const existing = await findExistingDelivery();
  let order: CreateResponse;
  let created = false;
  let destinationBefore: { lat: number | null; lng: number | null } | null = null;
  if (existing) {
    // 复用分支：本店已有外卖单就不再造第二张。
    console.log(`已有外卖单，复用不新建：delivery=${existing.id} order_no=${existing.order_no} status=${existing.rider_status}`);
    destinationBefore = {
      lat: existing.dest_lat === null ? null : Number(existing.dest_lat),
      lng: existing.dest_lng === null ? null : Number(existing.dest_lng),
    };
    order = {
      order_id: existing.order_id,
      order_no: existing.order_no,
      subtotal: money(Number(existing.total) - Number(existing.fee)),
      fee: Number(existing.fee),
      total: Number(existing.total),
      promised_at: existing.promised_at ?? undefined,
      delivery_id: existing.id,
    };
  } else {
    order = await createOrderViaPublicApi(token, products, subtotal);
    created = true;
  }

  const touched = await writeDestination(String(order.delivery_id));
  if (touched !== 1) throw new Error(`补写收货坐标命中 ${touched} 行，期望 1 行`);

  const row = await findExistingDelivery();
  console.log(JSON.stringify({
    deliveryEnabled: true,
    rules: { previous: rules.previous, written: rules.written },
    storeLink: { slug: SLUG, webTokenSource: 'store_qr_codes.table_no=WEB' },
    order: {
      createdThisRun: created,
      order_id: order.order_id,
      order_no: order.order_no,
      delivery_id: order.delivery_id,
      subtotal: order.subtotal,
      fee: order.fee,
      total: order.total,
      promised_at: order.promised_at,
      rider_status: row?.rider_status,
      // 复用时把"这单原本的坐标"也打出来：null 表示这一轮才补上，
      // 非 null 表示上一轮已经补过（幂等可见）。
      destinationBefore,
      destination: DESTINATION,
      // 指纹长度贴在输出里：它离 128 的上限只有 2 字符，必须每轮都看得见。
      idempotencyFingerprintChars: fingerprintLength(
        ITEM_NAMES.map((name) => products.get(name)!.id),
        subtotal,
        subtotal >= RULES.freeDeliveryAbove ? 0 : RULES.fee,
        RECIPIENT.address,
        RECIPIENT.phone,
      ),
      // 复用旧单时它可能带着旧规则下的金额；不静默，直接标出来。
      feeMatchesCurrentRules: Number(order.fee) === (Number(order.subtotal) >= RULES.freeDeliveryAbove ? 0 : RULES.fee),
      recipient: RECIPIENT.name,
      address: RECIPIENT.address,
    },
    note: 'dest_lat/dest_lng 由本脚本补写：src/ 里没有任何写这两列的路径（产品缺陷，见文件头）',
  }, null, 2));
}

run()
  .then(() => pool.end())
  .catch(async (error: unknown) => {
    console.error('[FAIL]', error instanceof Error ? error.message : String(error));
    await pool.end();
    process.exit(1);
  });
