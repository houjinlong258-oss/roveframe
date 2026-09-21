import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 外卖链路「种子 + 验证」脚本的源码契约。
 *
 * ## 这一层守的是什么
 *
 * `scripts/_seed_demo_delivery.mts` 与 `scripts/_verify_delivery_chain.mjs` 是**数据**层的
 * 工具：前者让外卖链第一次有真实行，后者用真实 HTTP 把整条链走一遍。它们不进
 * `src/` 的运行时，因此没有任何类型或运行期约束能拦住下面这些退化：
 *
 *   · 种子脚本不再复用已有外卖单 → 每跑一次多一张单，"幂等"名存实亡；
 *   · 种子脚本绕过公开接口直接 INSERT → 证明不了下单路径能用（这本来就是它的目的）；
 *   · 验证脚本只看状态码、不看 `code` → 409 到底是 `already_claimed`（被同事抢走）
 *     还是别的原因，全靠猜；竞态守卫就再也验不出来了；
 *   · 验证脚本不再检查追踪响应里的身份字段 → 骑手姓名/电话可能悄悄回到顾客手机上，
 *     而"通过"依旧全绿。
 *
 * ## 每条断言都必须能被证伪
 *
 * 每条源码断言都配一个**合成反例**：把"我们不想看到的那种写法"写出来，用**同一条
 * matcher** 去匹配，必须匹配不上。否则正则写成永远为真的空模式也能过，
 * 这类测试就成了自我安慰（见 `tests/delivery-tracking.test.ts` 的同类做法）。
 */

const read = (path: string): string => readFileSync(path, 'utf8');

const SEEDER_SOURCE = read('scripts/_seed_demo_delivery.mts');
const VERIFIER_SOURCE = read('scripts/_verify_delivery_chain.mjs');
const TRACK_ROUTE_PATH = 'src/app/api/store/deliveries/[id]/track/route.ts';

/** 去掉注释：注释里出现某个词不算通过（断言的是代码，不是说明）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SEEDER = stripComments(SEEDER_SOURCE);
const VERIFIER = stripComments(VERIFIER_SOURCE);

/**
 * 同一条 matcher 既要命中真实源码，又要拒绝合成反例 —— 少了后半句，断言就是空的
 * （正则写成永远为真的空模式也能"通过"）。
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
 * 这里的反例是"必须被抓住的那种写法"—— 它必须命中同一条 matcher，
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

/** 反例集合：每一条都是"我们不想在脚本里看到的写法"。 */
const COUNTER = {
  /** 每次跑都下单，不看有没有现成的单。 */
  noReuseBranch: "async function run() { const order = await createOrderViaPublicApi(token, products, subtotal); }",
  /** 绕过公开接口直接写表 —— 证明不了下单路径。 */
  rawInsert: "await pool.query('insert into public.orders (tenant_id, business_id, total) values ($1,$2,$3)');",
  /** 不带幂等头：重跑就会落第二张单。 */
  noIdempotencyHeader: "fetch(`${BASE}/api/store/delivery-orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })",
  /** 清理漏了位置行（位置是员工位置数据，必须一起走）。 */
  cleanupWithoutPositions: "if (cleanup) { await pool.query('delete from public.delivery_orders where tenant_id = $1'); await pool.query('delete from public.orders where tenant_id = $1'); return; }",
  /** 清理漏了配送行。 */
  cleanupWithoutDeliveries: "if (cleanup) { await pool.query('delete from public.delivery_positions where tenant_id = $1'); await pool.query('delete from public.orders where tenant_id = $1'); return; }",
  /** 清理漏了订单行。 */
  cleanupWithoutOrders: "if (cleanup) { await pool.query('delete from public.delivery_positions where tenant_id = $1'); await pool.query('delete from public.delivery_orders where tenant_id = $1'); return; }",
  /** 顺手把审计也删了 —— 那是"谁动了哪一单"的证据。 */
  deleteAudit: "await pool.query('delete from public.audit_logs where tenant_id = $1');",
  /** 认领竞态只看状态码 —— 409 有很多种原因。 */
  statusOnlyClaim: "record('第二次认领 409', claimAgain.status === 409, `status=${claimAgain.status}`);",
  /** 追踪只验有坐标，不验有没有泄漏骑手身份。 */
  noIdentityScan: "record('追踪有坐标', track.json?.rider?.lat === RIDER_POSITION_1.lat, '');",
  /** 一个真的会把骑手姓名/电话送到顾客手机上的响应。 */
  identityInResponse: "NextResponse.json({ rider: { lat: 1, lng: 2 }, rider_name: 'Li', recipient_phone: '555' })",
  /** 缺数据库就"跳过"—— 最需要证据的那两个断言会静默消失。 */
  silentSkipDb: "if (!process.env.PGHOST) { console.warn('skip db checks'); }",
  /** 计价只看 201。 */
  statusOnlyPricing: "record('下单 201', created.status === 201, `status=${created.status}`);",
  /** 算了指纹长度却不据此拦下来。 */
  ignoreFingerprint: "const fingerprintChars = fingerprintLength(items, subtotal, fee, address, phone); console.log(fingerprintChars);",
  /** 追踪失败回 403 —— 等于承认这张单存在。 */
  forbiddenInsteadOf404: "if (!owned) return NextResponse.json({ error: 'forbidden' }, { status: 403 });",
} as const;

// ---------------------------------------------------------------------------
// 1) 种子脚本：幂等
// ---------------------------------------------------------------------------
describe('delivery chain seed: 种子脚本幂等', () => {
  test('有"已有外卖单就复用"的分支，而不是每次下单都新建', () => {
    assertContract(
      '复用分支',
      SEEDER,
      /const existing = await findExistingDelivery\(\);[\s\S]{0,240}?if \(existing\) \{/,
      COUNTER.noReuseBranch,
    );
    // 复用判据必须是**查库**得出的，不能是"跑过一次就写个标记文件"那种状态。
    assert.match(SEEDER, /from public\.delivery_orders d[\s\S]{0,200}?order by d\.created_at asc/);
  });

  test('下单只走公开接口，不直接 INSERT 订单/配送行', () => {
    assertForbidden(
      '禁止直接写表',
      SEEDER,
      /insert into public\.(orders|delivery_orders)/i,
      COUNTER.rawInsert,
    );
    // 正向：HTTP 调用必须真的在，否则"没有 INSERT"可以靠"什么都不做"满足。
    assertContract(
      '走公开下单接口',
      SEEDER,
      /\/api\/store\/delivery-orders/,
      COUNTER.rawInsert,
    );
  });

  test('请求带固定幂等键（复用分支被绕过时的第二道保险）', () => {
    assertContract(
      '固定幂等键',
      SEEDER,
      /'Idempotency-Key': IDEMPOTENCY_KEY/,
      COUNTER.noIdempotencyHeader,
    );
    assert.match(SEEDER, /const IDEMPOTENCY_KEY = 'demo-delivery-seed-v1'/);
  });

  test('指纹长度自检：超过 varchar(128) 直接失败，不把缺陷吞掉', () => {
    assertContract(
      '指纹长度自检',
      SEEDER,
      /fingerprintChars > MAX_FINGERPRINT_CHARS[\s\S]{0,240}?throw new Error/,
      COUNTER.ignoreFingerprint,
    );
  });
});

// ---------------------------------------------------------------------------
// 2) 种子脚本：--cleanup
// ---------------------------------------------------------------------------
describe('delivery chain seed: --cleanup 精确且不留位置数据', () => {
  test('清理覆盖位置行 → 配送行 → 订单（顺序不可反）', () => {
    assert.match(SEEDER, /--cleanup/);
    // 三条各配一个"漏掉它"的反例：漏掉任何一条，那条断言都必须失败。
    assertContract('清理位置行', SEEDER, /delete from public\.delivery_positions/, COUNTER.cleanupWithoutPositions);
    assertContract('清理配送行', SEEDER, /delete from public\.delivery_orders/, COUNTER.cleanupWithoutDeliveries);
    assertContract('清理订单行', SEEDER, /delete from public\.orders/, COUNTER.cleanupWithoutOrders);
    // 顺序：位置行引用配送单、配送单引用订单，反了会留孤儿。
    const positionsAt = SEEDER.indexOf('delete from public.delivery_positions');
    const deliveriesAt = SEEDER.indexOf('delete from public.delivery_orders');
    const ordersAt = SEEDER.indexOf('delete from public.orders');
    assert.ok(positionsAt < deliveriesAt && deliveriesAt < ordersAt,
      `删除顺序不对：positions@${positionsAt} deliveries@${deliveriesAt} orders@${ordersAt}`);
  });

  test('清理不删审计行（那是"谁动了哪一单"的证据）', () => {
    assertForbidden(
      '禁止删审计',
      SEEDER,
      /delete from public\.audit_logs/,
      COUNTER.deleteAudit,
    );
    // 这条"为什么不删"的说明写在注释里，所以要在**原文**上断言（去注释后自然找不到）。
    assert.match(SEEDER_SOURCE, /audit_logs[\s\S]{0,40}不删/, '种子脚本必须写明为什么不删审计');
  });

  test('清理把 settings.delivery 复位成 {}，不动兄弟列', () => {
    assertContract(
      '规则复位',
      SEEDER,
      /set delivery = '\{\}'::jsonb/,
      "await pool.query('delete from public.settings where tenant_id = $1');",
    );
  });
});

// ---------------------------------------------------------------------------
// 3) 验证脚本：竞态守卫断言的是 code
// ---------------------------------------------------------------------------
describe('delivery chain verifier: 认领竞态断言 code=already_claimed', () => {
  test('第二次认领同时断言 409 与 already_claimed（不是"409 就算过"）', () => {
    assertContract(
      'already_claimed',
      VERIFIER,
      /claimAgain\.status === 409 && claimAgain\.json\?\.code === 'already_claimed'/,
      COUNTER.statusOnlyClaim,
    );
    // 断言文案里也要点名 code，报告读起来才知道验的是哪一个边界。
    assert.match(VERIFIER, /record\('竞态守卫[\s\S]{0,80}?already_claimed/);
  });

  test('状态机终态同样断言 already_settled', () => {
    assertContract(
      'already_settled',
      VERIFIER,
      /settled\.status === 409 && settled\.json\?\.code === 'already_settled'/,
      "record('第三次状态', settled.status === 409, '');",
    );
  });
});

// ---------------------------------------------------------------------------
// 4) 验证脚本：追踪响应不含骑手身份
// ---------------------------------------------------------------------------
describe('delivery chain verifier: 追踪响应不带骑手身份', () => {
  test('响应级：递归收集键名，与身份字段黑名单求交集后必须为空', () => {
    assertContract(
      '响应级身份扫描',
      VERIFIER,
      /const leaked = RIDER_IDENTITY_FIELDS\.filter\(\(field\) => trackKeys\.includes\(field\)\)[\s\S]{0,160}?leaked\.length === 0/,
      COUNTER.noIdentityScan,
    );
    assert.match(VERIFIER, /const trackKeys = collectKeys\(trackBefore\.json\)/);
    // 黑名单必须真的点名身份字段，否则"交集为空"毫无意义。
    for (const field of ['rider_name', 'rider_phone', 'staff_id', 'recipient_phone']) {
      assert.match(VERIFIER, new RegExp(`'${field}'`), `黑名单缺 ${field}`);
    }
  });

  test('源码级：读 track 路由并断言（去注释后）不出现身份字段，且配了合成反例', () => {
    assertContract(
      '源码级身份扫描',
      VERIFIER,
      /readFileSync\('src\/app\/api\/store\/deliveries\/\[id\]\/track\/route\.ts', 'utf8'\)[\s\S]{0,600}?identityRe\.test\(/,
      "const trackSource = readFileSync('src/app/api/store/deliveries/[id]/track/route.ts', 'utf8'); record('ok', true, '');",
    );
    // 这条 matcher 必须能命中真正的身份字段写法 —— 反例必须被拒绝这件事本身也要有证据。
    const identityRe = /(rider_name|rider_phone|recipient_name|recipient_phone|staff_name|rider_staff_id)/;
    assert.match(COUNTER.identityInResponse, identityRe, '反例没被身份正则命中，说明正则是坏的');
    assert.doesNotMatch(
      stripComments(read(TRACK_ROUTE_PATH)),
      identityRe,
      'track 路由（去注释后）出现了身份字段 —— 顾客需要的是位置，不是这名员工的身份',
    );
  });
});

// ---------------------------------------------------------------------------
// 5) 验证脚本：每个失败边界都断言具体语义
// ---------------------------------------------------------------------------
describe('delivery chain verifier: 失败边界断言具体语义', () => {
  test('追踪不存在的单是 404，不是 403', () => {
    assertContract(
      '404 而不是 403',
      VERIFIER,
      /ghostTrack\.status === 404/,
      COUNTER.forbiddenInsteadOf404,
    );
  });

  test('店长看板：无会话 401 / 员工会话 403（两条都要，才排得掉"一把 401"）', () => {
    assertContract('无会话 401', VERIFIER, /teamAnon\.status === 401/, "record('anon', true, '');");
    assertContract('员工会话 403', VERIFIER, /teamAsStaff\.status === 403/, "record('staff', teamAsStaff.status !== 404, '');");
  });

  test('有坐标 ⇒ estimate 有值；无坐标 ⇒ estimate 必须是 null（不编 ETA）', () => {
    // Phase 18 §4.1 修好之前：产品代码里没有任何写 dest_lat/dest_lng 的路径，
    // 于是主单的 estimate 恒为 null，验证脚本只需要断言这一个方向。
    // 现在下单能带顾客设备坐标了 ⇒ 契约变成**两个方向都要断言**：
    //   · 带坐标的主单 ⇒ estimate 必须有值（否则"修好了"这句话没有证据）；
    //   · 不带坐标的那一单 ⇒ 必须仍为 null（否则就是"为了有 ETA 而编一个"）。
    assertContract(
      '带坐标的主单 estimate 有值',
      VERIFIER,
      /trackBefore\.json\?\.estimate !== null/,
      "record('track 200', trackBefore.status === 200, '');",
    );
    assertContract(
      '无坐标的那一单 estimate 为 null',
      VERIFIER,
      /noCoordsTrack\.json\?\.estimate === null/,
      "record('track 200', trackBefore.status === 200, '');",
    );
    assertContract(
      'isEstimate=true',
      VERIFIER,
      /trackAfter\.json\?\.estimate\?\.isEstimate === true/,
      "record('有 estimate', trackAfter.json?.estimate !== null, '');",
    );
  });

  test('坐标边界：越界 / 字符串 / null / 字面量 NaN 四种都断言 400', () => {
    for (const matcher of [
      /outOfRange\.status === 400 && outOfRange\.json\?\.code === 'invalid_coordinates'/,
      /stringLat\.status === 400/,
      /nullLat\.status === 400/,
      /nanRaw\.status === 400/,
    ]) {
      assertContract(`坐标边界 ${String(matcher)}`, VERIFIER, matcher, "record('坐标', true, '');");
    }
    // NaN 只能用原始文本发出去（JSON.stringify 会把它变成 null），这点必须留在源码里。
    assert.match(VERIFIER, /body: '\{"lat": NaN, "lng": -73\.99\}'/);
  });

  test('内容断言：计价、承诺时间、距离/ETA 复算都在，不能只看状态码', () => {
    for (const matcher of [
      /created\.json\?\.subtotal === subtotal && created\.json\?\.fee === expectedFee && created\.json\?\.total === expectedTotal/,
      /Math\.abs\(promisedDeltaMin - rules\.prepMinutes\) <= 2/,
      /Math\.abs\(reportedKm - expectedKm\) < 0\.01/,
      /trackAfter\.json\?\.estimate\?\.etaMinutes === expectedEtaMinutes\(reportedKm\)/,
    ]) {
      assertContract(`内容断言 ${String(matcher)}`, VERIFIER, matcher, COUNTER.statusOnlyPricing);
    }
  });

  test('低于起送价断言 shortfall 的差额，不只是 400', () => {
    assertContract(
      'shortfall',
      VERIFIER,
      /below\.json\?\.error === 'order_below_minimum' && below\.json\?\.shortfall === expectedShortfall/,
      "record('低于起送价', below.status === 400, '');",
    );
  });

  test('幂等重放断言的是"同一张单"，冲突断言的是 idempotency_key_conflict', () => {
    assertContract(
      '同 key 同内容',
      VERIFIER,
      /repeat\.json\?\.order\?\.id === orderId/,
      "record('重放', repeat.status === 200, '');",
    );
    assertContract(
      '同 key 改内容',
      VERIFIER,
      /clash\.json\?\.error === 'idempotency_key_conflict'/,
      "record('冲突', clash.status === 409, '');",
    );
  });
});

// ---------------------------------------------------------------------------
// 6) 验证脚本：不会静默降级
// ---------------------------------------------------------------------------
describe('delivery chain verifier: 缺条件时失败而不是跳过', () => {
  test('缺数据库环境变量 → 打印原因并以退出码 2 结束', () => {
    assertContract(
      '缺 PG 环境变量即退出',
      VERIFIER,
      /缺 PGHOST \/ PGUSER \/ PGPASSWORD[\s\S]{0,200}?process\.exit\(2\)/,
      COUNTER.silentSkipDb,
    );
  });

  test('前置条件不满足（目录组不出合法订单）也以非零码退出', () => {
    assertContract(
      '前置条件',
      VERIFIER,
      /if \(!preconditionsOk\) await finish\(2\)/,
      "if (!preconditionsOk) { console.log('skipping'); }",
    );
  });

  test('详细行必须带实测响应体（否则失败时无从排查）', () => {
    // 每条 record 的 detail 里都要有实测值：状态码 + 响应体切片是最低要求。
    const withBody = (VERIFIER.match(/text\.slice\(0, \d+\)/g) ?? []).length;
    assert.ok(withBody >= 10, `带响应体切片的失败明细只有 ${withBody} 处，太少`);
    assertContract(
      '响应体切片',
      VERIFIER,
      /body=\$\{created\.text\.slice\(0, 240\)\}/,
      "record('下单', created.status === 201, 'failed');",
    );
  });
});
