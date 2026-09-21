import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { destinationCoords } from '../src/app/api/store/delivery-orders/route';
import { getDeviceCoordinates } from '../src/lib/device-location';

/**
 * Phase 18 §4.1 —— 收货坐标（`dest_lat` / `dest_lng`）的写入路径。
 *
 * ## 被修的是什么
 *
 * 这两列**只有读、没有写**：迁移加了列、追踪接口读它们算 ETA，但产品代码里
 * 没有任何一条路径写进去。后果不是崩溃，是**功能不可达** ——
 * `estimateForDelivery` 永远返回 null，顾客永远看不到 ETA，
 * 地图也永远不画（它要求目的地坐标）。
 *
 * 实测证据（修之前）：`scripts/_verify_delivery_chain.mjs` 里有一条源码级断言
 * 在钉住这个事实，并需要一段 fixture 手工 `update ... set dest_lat=...` 才能
 * 让后面的 ETA 断言跑起来。**要靠补数据才能测的功能，就是产品里不存在的功能。**
 *
 * ## 这批测试守住四个失败模式
 *
 *   1. 坐标只给一半 ⇒ 必须 400（静默丢弃会让客户端以为定位生效了）；
 *   2. 非法坐标（NaN / 超范围）⇒ 必须 400，且不得落单；
 *   3. 完全不传 ⇒ 必须放行且写 NULL（顾客拒绝授权是**正常路径**，不是错误）；
 *   4. 追踪用的 id 是 **delivery id**，不是 order id —— 传错必然 404，
 *      而"追踪接口永远 404"与"这单没有配送记录"在顾客眼里长得一样。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1) destinationCoords：真实调用（纯函数）
// ---------------------------------------------------------------------------

describe('destinationCoords — 坐标入参判定（真实调用）', () => {
  test('两个都合法 ⇒ 原样采用', () => {
    const result = destinationCoords({ dest_lat: 40.7554, dest_lng: -73.993 });
    assert.deepEqual(result, { ok: true, lat: 40.7554, lng: -73.993 });
  });

  test('两个都不给 ⇒ ok 且为 null（顾客拒绝授权是正常路径）', () => {
    assert.deepEqual(destinationCoords({}), { ok: true, lat: null, lng: null });
    assert.deepEqual(destinationCoords({ dest_lat: null, dest_lng: null }), { ok: true, lat: null, lng: null });
    assert.deepEqual(destinationCoords({ dest_lat: '', dest_lng: '' }), { ok: true, lat: null, lng: null });
  });

  test('只给一个 ⇒ ok:false（不可静默丢弃）', () => {
    assert.equal(destinationCoords({ dest_lat: 40.7554 }).ok, false);
    assert.equal(destinationCoords({ dest_lng: -73.993 }).ok, false);
    assert.equal(destinationCoords({ dest_lat: 40.7554, dest_lng: null }).ok, false);
    assert.equal(destinationCoords({ dest_lat: null, dest_lng: -73.993 }).ok, false);
  });

  test('超范围 ⇒ ok:false（纬度 ±90 / 经度 ±180）', () => {
    assert.equal(destinationCoords({ dest_lat: 999, dest_lng: 999 }).ok, false);
    assert.equal(destinationCoords({ dest_lat: 90.0001, dest_lng: 0 }).ok, false);
    assert.equal(destinationCoords({ dest_lat: 0, dest_lng: 180.0001 }).ok, false);
    // 边界值本身是合法的（含端点）
    assert.equal(destinationCoords({ dest_lat: 90, dest_lng: 180 }).ok, true);
    assert.equal(destinationCoords({ dest_lat: -90, dest_lng: -180 }).ok, true);
  });

  test('非有限值 ⇒ ok:false（NaN 一旦落库会让之后每次距离计算都是 NaN）', () => {
    assert.equal(destinationCoords({ dest_lat: Number.NaN, dest_lng: 0 }).ok, false);
    assert.equal(destinationCoords({ dest_lat: Number.POSITIVE_INFINITY, dest_lng: 0 }).ok, false);
    assert.equal(destinationCoords({ dest_lat: 'abc', dest_lng: 'def' }).ok, false);
  });

  test('数字字符串被接受（表单/JSON 边界常见），但结果必须是 number', () => {
    const result = destinationCoords({ dest_lat: '40.7554', dest_lng: '-73.993' });
    assert.deepEqual(result, { ok: true, lat: 40.7554, lng: -73.993 });
    assert.equal(typeof (result as { lat: number }).lat, 'number');
  });

  test('负向对照：注入"永远放行"的校验器会让上面三条拒绝断言全部失效', () => {
    const permissive = { isValidLatitude: () => true, isValidLongitude: () => true };
    // 只给一个坐标时仍然拒绝 —— 这条判定在注入前后都成立（它不依赖校验器）
    assert.equal(destinationCoords({ dest_lat: 1 }, permissive).ok, false);
    // 但超范围在"永远放行"的校验器下会被接受：证明 §超范围 那几条确实依赖真校验器
    assert.equal(destinationCoords({ dest_lat: 999, dest_lng: 999 }, permissive).ok, true);
    assert.equal(destinationCoords({ dest_lat: 999, dest_lng: 999 }).ok, false);
  });

  test('判定函数读的字段名与路由声明一致（靠"恰好同名"工作的地方最容易静默失配）', () => {
    // 源码里 DeliveryBody 声明的就是这两个名字；如果判定函数改读 destLat/destLng，
    // 它会永远看到 undefined ⇒ 静默走"不传坐标"分支 ⇒ 坐标永远写不进去，
    // 而上面所有断言仍然全绿（因为它们都是拿 dest_lat/dest_lng 调的）。
    const route = stripComments(read('src/app/api/store/delivery-orders/route.ts'));
    assert.match(route, /dest_lat\?: unknown;/);
    assert.match(route, /dest_lng\?: unknown;/);
    assert.match(route, /const coords = destinationCoords\(raw\)/);
    // 负向对照：同一组正则必须能拒绝一个改名后的声明
    assert.doesNotMatch('interface DeliveryBody { destLat?: unknown; destLng?: unknown }', /dest_lat\?: unknown;/);
  });
});

// ---------------------------------------------------------------------------
// 2) 设备定位：拿不到就是 null，绝不编坐标
// ---------------------------------------------------------------------------

/**
 * 临时替换 `globalThis.navigator` 并保证还原。
 *
 * 为什么不用 `globalThis.navigator = …`：Node 22 起 `navigator` 是**只读 getter**
 * （`{get, configurable:true, set:false}`），直接赋值会**静默失败**（非严格模式）
 * 或抛错（严格模式）。实测第一版就是这么写的，5 条用例全红，而失败原因看起来
 * 像"被测代码有问题" —— 实际是测试装不上替身。
 * 它是 `configurable` 的，因此 `defineProperty` 可以覆盖，且能还原。
 */
async function withNavigator<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe('getDeviceCoordinates — 无能力/取消授权时必须是 null', () => {
  test('没有 navigator（服务端）⇒ null，不抛错', async () => {
    const result = await withNavigator(undefined, () => getDeviceCoordinates(10));
    assert.equal(result, null);
  });

  test('navigator 存在但没有 geolocation（http 上下文）⇒ null', async () => {
    const result = await withNavigator({}, () => getDeviceCoordinates(10));
    assert.equal(result, null);
  });

  test('顾客拒绝授权（error 回调）⇒ null', async () => {
    const result = await withNavigator({
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) => {
          err({ code: 1, message: 'denied' });
        },
      },
    }, () => getDeviceCoordinates(10));
    assert.equal(result, null);
  });

  test('设备永不回调（室内无 GPS 的真实症状）⇒ 超时后 null，不挂住下单', async () => {
    const started = Date.now();
    const result = await withNavigator({
      geolocation: { getCurrentPosition: () => { /* 永不回调 */ } },
    }, () => getDeviceCoordinates(40));
    assert.equal(result, null);
    assert.ok(Date.now() - started >= 30, '必须在超时之后才返回，而不是立刻');
  });

  test('授权且设备返回有限坐标 ⇒ 原样返回', async () => {
    const result = await withNavigator({
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => {
          ok({ coords: { latitude: 40.7554, longitude: -73.993, accuracy: 12 } });
        },
      },
    }, () => getDeviceCoordinates(100));
    assert.deepEqual(result, { lat: 40.7554, lng: -73.993, accuracyM: 12 });
  });

  test('设备返回非有限坐标 ⇒ null（不把 NaN 写进订单）', async () => {
    const result = await withNavigator({
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => {
          ok({ coords: { latitude: Number.NaN, longitude: -73.993, accuracy: 5 } });
        },
      },
    }, () => getDeviceCoordinates(100));
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// 3) 接线契约：谁写坐标、追踪用哪个 id
// ---------------------------------------------------------------------------
describe('接线契约：坐标写入与追踪 id', () => {
  const orderRoute = stripComments(read('src/app/api/store/delivery-orders/route.ts'));
  const trackRoute = stripComments(read('src/app/api/store/deliveries/[id]/track/route.ts'));
  const teamDelivery = stripComments(read('src/app/api/team/delivery/route.ts'));
  const tracker = stripComments(read('src/components/delivery/delivery-tracker.tsx'));
  const customerOrders = stripComments(read('src/app/api/customer/orders/route.ts'));
  const customerPwa = stripComments(read('src/components/customer/CustomerPwa.tsx'));

  test('下单路由把坐标写进 delivery_orders（唯一诚实来源）', () => {
    assert.match(orderRoute, /dest_lat: coords\.lat/);
    assert.match(orderRoute, /dest_lng: coords\.lng/);
    assert.match(orderRoute, /invalid_destination_coordinates/);
  });

  test('派单路由**不**写坐标（骑手不能改目的地）', () => {
    assert.doesNotMatch(teamDelivery, /dest_lat/);
  });

  test('负向对照：同一 matcher 能命中一个写了 dest_lat 的合成片段', () => {
    assert.match(
      "update('delivery_orders').update({ dest_lat: 1, dest_lng: 2 })",
      /dest_lat/,
    );
  });

  test('追踪接口按 delivery_orders.id 查（读坐标算 ETA）', () => {
    assert.match(trackRoute, /\.from\('delivery_orders'\)/);
    assert.match(trackRoute, /\.eq\('id', deliveryId\)/);
    assert.match(trackRoute, /dest_lat, dest_lng/);
  });

  test('顾客端追踪用 delivery_id，不是 order.id', () => {
    assert.match(tracker, /order\.delivery_id/);
    // 这个反例正是修之前的写法：拿 order.id 去查 delivery 表，必然 404
    assert.doesNotMatch(
      "fetch(`/api/store/deliveries/${encodeURIComponent(order.id)}/track?`)",
      /order\.delivery_id/,
    );
  });

  test('顾客订单接口返回 delivery_id（否则调用方只能猜）', () => {
    assert.match(customerOrders, /delivery_id: deliveryId/);
    assert.match(customerOrders, /\.select\('id, order_id, rider_status'\)/);
  });

  test('下单 201 响应同时给出 delivery_id 与确认写入的坐标', () => {
    assert.match(orderRoute, /delivery_id: \(delivery as \{ id: string \}\)\.id/);
    assert.match(orderRoute, /destination_coordinates: coords\.lat === null \? null/);
  });

  test('顾客端下单时真的会去要一次设备定位（且失败不阻断下单）', () => {
    assert.match(customerPwa, /await getDeviceCoordinates\(\)/);
    assert.match(customerPwa, /\.\.\.\(coords \? \{ dest_lat: coords\.lat, dest_lng: coords\.lng \} : \{\}\)/);
  });

  test('API 层只在拿到数字坐标时才带这两个字段（不传 null/0）', () => {
    const api = stripComments(read('src/lib/api.ts'));
    assert.match(api, /typeof req\.dest_lat === 'number' && typeof req\.dest_lng === 'number'/);
  });
});
