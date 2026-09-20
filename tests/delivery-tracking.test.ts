import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AVERAGE_SPEED_KMH,
  DEFAULT_POSITION_RETENTION_HOURS,
  DEFAULT_ROAD_FACTOR,
  estimateEtaMinutes,
  estimateForDelivery,
  haversineKm,
  isValidAccuracyM,
  isValidLatLng,
  isValidLatitude,
  isValidLongitude,
  normalizeRetentionHours,
} from '../src/lib/delivery-position';

/**
 * Phase 18 / P18-10 —— 配送追踪（骑手位置 + ETA）的守卫。
 *
 * ## 这一层要守住的失败模式，几乎全是**静默**的
 *
 *   1. NaN 坐标落库 → 之后每一次距离计算都是 NaN，接口照样 200，
 *      顾客端表现为"地图空白且没有报错"。必须有能拒绝 NaN 的负向对照。
 *   2. ETA 被当成实时预测展示 → 原型那个 2 秒定时器就是这么骗过评审的。
 *      返回对象必须自带 `isEstimate: true`。
 *   3. 位置行脱离"进行中的单" → 变成无理由持有的员工位置数据。
 *   4. delivery_positions 被加上级联外键 → 订单清理时静默删掉位置审计，
 *      而保留期任务再也无法独立决定何时删除。
 *   5. 公开追踪路由用 403 回答"不是你的单" → 泄漏"这张单存在"，可枚举。
 *   6. 追踪响应带上骑手姓名/电话 → 把"某个人"与"他的行踪"绑在一起送到顾客手机。
 *
 * ## 为什么每一条都配了"能失败"的对照
 *
 * 源码级断言（正则）最容易写成永远成立的空断言。因此每一条源码断言都附一个
 * **合成反例**：把反例喂给同一组正则，必须被判定为不合格。反例不触发，
 * 就说明断言写虚了。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1) 距离：纯函数，可对已知点对验算
// ---------------------------------------------------------------------------

describe('delivery tracking: haversineKm', () => {
  test('同一点距离为 0（不是"接近 0"）', () => {
    const p = { lat: 40.7128, lng: -74.006 };
    assert.equal(haversineKm(p, p), 0);
    // 负向对照：不同点不能也返回 0
    assert.notEqual(haversineKm(p, { lat: 40.7128, lng: -74.0 }), 0);
  });

  test('纬度方向 0.008993° ≈ 1.0 km（容差 2%）', () => {
    // 1 km 对应的纬度差 = 1 / 111.195 ≈ 0.008993°。这是可独立验算的已知点对。
    const a = { lat: 40.0, lng: -74.0 };
    const b = { lat: 40.008993, lng: -74.0 };
    const d = haversineKm(a, b);
    assert.ok(Math.abs(d - 1.0) < 0.02, `期望 ≈1.0 km，实得 ${d}`);
  });

  test('巴黎—伦敦 ≈ 343.5 km（容差 1.5%）', () => {
    const paris = { lat: 48.8566, lng: 2.3522 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const d = haversineKm(paris, london);
    assert.ok(Math.abs(d - 343.5) < 5, `期望 ≈343.5 km，实得 ${d}`);
  });

  test('对称：交换两点距离不变', () => {
    const a = { lat: 31.2304, lng: 121.4737 };
    const b = { lat: 39.9042, lng: 116.4074 };
    assert.equal(haversineKm(a, b), haversineKm(b, a));
  });

  test('合法输入的返回值始终有限（不会退化成 NaN）', () => {
    const points = [
      { lat: 0, lng: 0 }, { lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 89.999999, lng: -179.999999 },
    ];
    for (const a of points) {
      for (const b of points) {
        const d = haversineKm(a, b);
        assert.ok(Number.isFinite(d), `${JSON.stringify(a)} → ${JSON.stringify(b)} 得到 ${d}`);
        assert.ok(d >= 0, '距离不能为负');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2) ETA：永远是"估算"，且非零距离不给 0 分钟
// ---------------------------------------------------------------------------

describe('delivery tracking: estimateEtaMinutes', () => {
  test('返回对象自带 isEstimate: true 与两个系数', () => {
    const eta = estimateEtaMinutes(5);
    assert.equal(eta.isEstimate, true);
    assert.equal(eta.roadFactor, DEFAULT_ROAD_FACTOR);
    assert.equal(eta.averageSpeedKmh, DEFAULT_AVERAGE_SPEED_KMH);
    assert.equal(eta.distanceKm, 5);
    // 负向对照：这个值必须是**字面量 true**，而不是恰好为真的其它东西
    assert.equal(Object.keys(eta).includes('isEstimate'), true);
    assert.equal(typeof eta.isEstimate, 'boolean');
  });

  test('非零距离永不返回 0 分钟', () => {
    for (const km of [0.0001, 0.01, 0.5, 1, 3, 12.5, 100]) {
      const eta = estimateEtaMinutes(km);
      assert.ok(eta.etaMinutes >= 1, `${km} km 得到了 ${eta.etaMinutes} 分钟 —— "0 分钟送达"是不可能兑现的承诺`);
      assert.equal(eta.isEstimate, true);
    }
  });

  test('距离为 0 时 0 分钟是如实的', () => {
    assert.equal(estimateEtaMinutes(0).etaMinutes, 0);
    assert.equal(estimateEtaMinutes(0).isEstimate, true);
  });

  test('参数可覆盖：22 km/h、道路系数 1.0 → 22 km 恰好 60 分钟', () => {
    const eta = estimateEtaMinutes(22, { roadFactor: 1, averageSpeedKmh: 22 });
    assert.equal(eta.etaMinutes, 60);
    assert.equal(eta.roadFactor, 1);
    assert.equal(eta.averageSpeedKmh, 22);
  });

  test('参数非法时回落默认值，而不是产生 NaN', () => {
    const eta = estimateEtaMinutes(10, { roadFactor: Number.NaN, averageSpeedKmh: 0 });
    assert.equal(eta.roadFactor, DEFAULT_ROAD_FACTOR);
    assert.equal(eta.averageSpeedKmh, DEFAULT_AVERAGE_SPEED_KMH);
    // 负向对照：如果没有回落，这里会是 NaN/Infinity
    assert.ok(Number.isFinite(eta.etaMinutes));
  });

  test('单调：更远不会更早到', () => {
    let previous = 0;
    for (const km of [0.5, 1, 2, 5, 20]) {
      const eta = estimateEtaMinutes(km).etaMinutes;
      assert.ok(eta >= previous, `${km} km 的 ETA (${eta}) 小于更近距离的 ETA (${previous})`);
      previous = eta;
    }
  });

  test('负向对照：NaN / Infinity / 负数距离必须抛错，不得返回一个"正常的"分钟数', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.throws(() => estimateEtaMinutes(bad), `distanceKm=${bad} 必须抛错`);
    }
    // 反例确实会抛（证明上面的断言不是空转）
    assert.throws(() => estimateEtaMinutes(Number.NaN));
  });
});

// ---------------------------------------------------------------------------
// 3) 坐标白名单（NaN 的负向对照）
// ---------------------------------------------------------------------------

describe('delivery tracking: coordinate validation', () => {
  test('边界内的有限数被接受', () => {
    assert.equal(isValidLatitude(0), true);
    assert.equal(isValidLatitude(90), true);
    assert.equal(isValidLatitude(-90), true);
    assert.equal(isValidLongitude(0), true);
    assert.equal(isValidLongitude(180), true);
    assert.equal(isValidLongitude(-180), true);
    assert.equal(isValidLatLng(40.0, -74.0), true);
  });

  test('越界、非有限、非数字一律拒绝', () => {
    assert.equal(isValidLatitude(90.0001), false);
    assert.equal(isValidLatitude(-90.0001), false);
    assert.equal(isValidLongitude(180.0001), false);
    assert.equal(isValidLongitude(-180.0001), false);
    assert.equal(isValidLatitude(Number.NaN), false);
    assert.equal(isValidLongitude(Number.NaN), false);
    assert.equal(isValidLatitude(Number.POSITIVE_INFINITY), false);
    assert.equal(isValidLatitude(Number.NEGATIVE_INFINITY), false);
    assert.equal(isValidLatitude('40'), false);
    assert.equal(isValidLatitude(null), false);
    assert.equal(isValidLatitude(undefined), false);
  });

  test('负向对照：合成的 lat: NaN 调用必须被同一校验器拒绝', () => {
    // 这正是"静默存进库的 NaN"的形态：它看起来像一个坐标对象。
    const synthetic = { lat: Number.NaN, lng: -74.0, accuracy_m: 12 };
    assert.equal(isValidLatLng(synthetic.lat, synthetic.lng), false, 'NaN 纬度被放行了 —— 之后每次距离计算都会是 NaN');
    assert.equal(isValidLatLng(synthetic.lng, synthetic.lat), false, 'NaN 经度被放行了');
    // 阳性对照：把 NaN 换成一个合法值，同一断言必须放行（否则上面两条是空转）
    assert.equal(isValidLatLng(40.0, synthetic.lng), true);
  });

  test('accuracy_m 可选，给了就必须是有限的非负数', () => {
    assert.equal(isValidAccuracyM(undefined), true);
    assert.equal(isValidAccuracyM(null), true);
    assert.equal(isValidAccuracyM(0), true);
    assert.equal(isValidAccuracyM(12.5), true);
    assert.equal(isValidAccuracyM(-1), false);
    assert.equal(isValidAccuracyM(Number.NaN), false);
    assert.equal(isValidAccuracyM(Number.POSITIVE_INFINITY), false);
    assert.equal(isValidAccuracyM('5'), false);
  });
});

// ---------------------------------------------------------------------------
// 4) 缺任一端就没有 ETA —— 不拿"到某个点"的距离冒充"到顾客"的距离
// ---------------------------------------------------------------------------

describe('delivery tracking: estimateForDelivery', () => {
  const position = { lat: 40.0, lng: -74.0 };
  const destination = { lat: 40.008993, lng: -74.0 };

  test('有位置、有目的地 → 给出估算（阳性对照）', () => {
    const eta = estimateForDelivery(position, destination);
    assert.ok(eta, '两端齐全时必须给出 ETA');
    assert.equal(eta.isEstimate, true);
    assert.ok(Math.abs(eta.distanceKm - 1.0) < 0.02);
  });

  test('没有位置 → null（不回落成店铺坐标或"上次已知位置"）', () => {
    assert.equal(estimateForDelivery(null, destination), null);
  });

  test('没有目的地坐标 → null（不计算"到虚无"的距离）', () => {
    assert.equal(estimateForDelivery(position, null), null);
  });

  test('两端都没有 → null', () => {
    assert.equal(estimateForDelivery(null, null), null);
  });

  test('脏坐标 → null，而不是 NaN 距离或抛错', () => {
    assert.equal(estimateForDelivery({ lat: Number.NaN, lng: -74 }, destination), null);
    assert.equal(estimateForDelivery(position, { lat: 91, lng: -74 }), null);
  });

  test('同一点 → 0 分钟，仍然是估算对象', () => {
    const eta = estimateForDelivery(position, position);
    assert.ok(eta);
    assert.equal(eta.etaMinutes, 0);
    assert.equal(eta.isEstimate, true);
  });
});

// ---------------------------------------------------------------------------
// 5) 保留期
// ---------------------------------------------------------------------------

describe('delivery tracking: retention', () => {
  test('默认 24 小时，脏值回落到默认而不是变成 NaN/0', () => {
    assert.equal(DEFAULT_POSITION_RETENTION_HOURS, 24);
    assert.equal(normalizeRetentionHours(undefined), 24);
    assert.equal(normalizeRetentionHours(null), 24);
    assert.equal(normalizeRetentionHours(0), 24);
    assert.equal(normalizeRetentionHours(-3), 24);
    assert.equal(normalizeRetentionHours('abc'), 24);
    assert.equal(normalizeRetentionHours(Number.NaN), 24);
  });

  test('合法值被采纳，极端值被夹住（不得退化成"永不过期"）', () => {
    assert.equal(normalizeRetentionHours(48), 48);
    assert.equal(normalizeRetentionHours('12'), 12);
    assert.equal(normalizeRetentionHours(0.5), 1);
    assert.equal(normalizeRetentionHours(100000), 24 * 30);
  });
});

// ---------------------------------------------------------------------------
// 6) 写库路径：先验所有权与活跃状态，再插入
// ---------------------------------------------------------------------------

describe('delivery tracking: recording guards (source)', () => {
  const lib = stripComments(read('src/lib/delivery-position.ts'));

  test('只允许 claimed / picked_up 两种状态上报', () => {
    assert.match(
      lib,
      /ACTIVE_RIDER_STATUSES: readonly RiderStatus\[\] = \['claimed', 'picked_up'\]/,
      '允许上报的状态集合被改了 —— 位置只能在配送进行中采集',
    );
    // 负向对照：pending / delivered / cancelled 绝不能出现在这个集合里
    const decl = lib.match(/ACTIVE_RIDER_STATUSES: readonly RiderStatus\[\] = \[([^\]]*)\]/);
    assert.ok(decl, '未解析到 ACTIVE_RIDER_STATUSES 声明');
    for (const forbidden of ['pending', 'delivered', 'cancelled']) {
      assert.equal(decl[1].includes(forbidden), false, `${forbidden} 不该允许上报位置`);
    }
  });

  test('所有权由 rider_staff_id 过滤保证，不看客户端传的身份字段', () => {
    const start = lib.indexOf('export async function recordDeliveryPosition');
    const end = lib.indexOf('export async function latestPositionForDelivery');
    assert.ok(start > 0 && end > start, '未找到 recordDeliveryPosition —— 结构已变，请更新本测试');
    const body = lib.slice(start, end);

    assert.match(body, /\.eq\('rider_staff_id', staffId\)/);
    assert.match(body, /\.in\('rider_status', \[\.\.\.ACTIVE_RIDER_STATUSES\]\)/);
    assert.match(body, /\.eq\('tenant_id', tenantId\)/);
    assert.match(body, /\.eq\('business_id', businessId\)/);
  });

  test('坐标校验发生在插入之前 —— 一行都不能先写进去', () => {
    const start = lib.indexOf('export async function recordDeliveryPosition');
    const end = lib.indexOf('export async function latestPositionForDelivery');
    const body = lib.slice(start, end);

    const validateAt = body.indexOf('isValidLatLng(');
    const insertAt = body.indexOf(".from('delivery_positions')");
    assert.ok(validateAt > 0, 'recordDeliveryPosition 里没有调用 isValidLatLng');
    assert.ok(insertAt > validateAt, '坐标校验必须排在写入 delivery_positions 之前');

    // 负向对照：先插入再校验的写法必须被上面的顺序断言判为不合格
    const broken = `
      export async function recordDeliveryPosition() {
        await client.from('delivery_positions').insert({ lat, lng });
        if (!isValidLatLng(input.lat, input.lng)) return { ok: false };
      }`;
    assert.equal(
      broken.indexOf('isValidLatLng(') > broken.indexOf(".from('delivery_positions')"),
      true,
      '先写后验的合成反例没有被判为不合格 —— 顺序断言写虚了',
    );
  });

  test('未命中时区分 not_found / not_mine / not_active', () => {
    const start = lib.indexOf('export async function recordDeliveryPosition');
    const end = lib.indexOf('export async function latestPositionForDelivery');
    const body = lib.slice(start, end);
    // 三个原因字面量都必须出现（not_mine 与 not_active 由同一个三元表达式给出，
    // 所以这里断言字面量本身，而不是 `reason: '<值>'` 的写法）
    for (const reason of ['not_found', 'not_mine', 'not_active']) {
      assert.match(body, new RegExp(`'${reason}'`), `缺少失败原因 ${reason}`);
    }
    // 负向对照：一个只回 not_found 的合成片段必须被判为缺原因
    const synthetic = "if (!existing) return { ok: false, reason: 'not_found' };";
    assert.doesNotMatch(synthetic, /'not_mine'/);
  });

  test('最新位置按 recorded_at 倒序只取一条，没有就是 null', () => {
    const start = lib.indexOf('export async function latestPositionForDelivery');
    assert.ok(start > 0);
    const body = lib.slice(start);
    assert.match(body, /\.order\('recorded_at', \{ ascending: false \}\)/);
    assert.match(body, /\.limit\(1\)/);
    assert.match(body, /if \(!data\) return null;/);
    // 负向对照：不得回落成店铺坐标之类的"默认位置"
    assert.doesNotMatch(body, /fallback/i);
  });

  test('保留期清理是**单条** DELETE，且保留期可由 settings 覆盖', () => {
    const start = lib.indexOf('export async function purgeOldPositions');
    assert.ok(start > 0, '未找到 purgeOldPositions');
    const body = lib.slice(start);
    assert.equal(
      (body.match(/\.delete\(\)/g) ?? []).length, 1,
      '保留期清理必须恰好一条 DELETE（调度器每 tick 都会调用它）',
    );
    assert.match(body, /\.lt\('recorded_at', cutoff\)/);
    assert.match(body, /positionRetentionHours/);
    assert.match(lib, /export const DEFAULT_POSITION_RETENTION_HOURS = 24;/);
  });

  test('模块头部写明隐私硬规则（不是口头承诺，而是被断言钉住）', () => {
    const src = read('src/lib/delivery-position.ts');
    const headerEnd = src.indexOf('export interface GeoPoint');
    assert.ok(headerEnd > 0, '未找到模块头部的结尾 —— 结构已变，请更新本测试');
    const header = src.slice(0, headerEnd);

    for (const phrase of ['员工位置数据', '认领', '显式上报', '保留期']) {
      assert.ok(header.includes(phrase), `模块头部缺少隐私规则关键词：${phrase}`);
    }
    assert.match(header, /不做任何后台追踪/);
    assert.match(header, /purgeOldPositions/);

    // 负向对照：把关键词全部删掉，同一断言必须不成立
    // （用 replaceAll：这个词在头部出现两次，只删一处会让对照空转）
    assert.equal(header.replaceAll('员工位置数据', '').includes('员工位置数据'), false);
  });
});

// ---------------------------------------------------------------------------
// 7) 员工端上报路由：中央守卫 + 员工档案解析
// ---------------------------------------------------------------------------

describe('delivery tracking: staff position route', () => {
  const route = stripComments(read('src/app/api/staff/deliveries/[id]/position/route.ts'));

  test('走中央守卫，带权限与审计 action/entity', () => {
    assert.match(route, /export const POST = protectBusinessMutation\(/);
    assert.match(route, /permission: 'delivery:claim'/);
    assert.match(route, /action: 'delivery\.position'/);
    assert.match(route, /entity: 'delivery_positions'/);
  });

  test('会话 → 员工档案：不接受客户端传来的任何身份字段', () => {
    assert.match(route, /resolveStaffForUser\(/);
    assert.doesNotMatch(route, /body\.staff_id|body\.rider_staff_id|body\.tenant_id|body\.business_id/);
  });

  test('坐标在路由层就挡掉非法值（400），不合法就不进写库路径', () => {
    assert.match(route, /if \(!isValidLatitude\(lat\) \|\| !isValidLongitude\(lng\)\)/);
    assert.match(route, /code: 'invalid_coordinates'/);
    assert.match(route, /status: 400/);
    // 不得"尽力解析"字符串数字 —— 那条路的终点是 NaN
    assert.doesNotMatch(route, /Number\(body\.lat\)|parseFloat/);
  });

  test('单不是他的 / 已结束 → 409 code not_active；单不存在 → 404', () => {
    assert.match(route, /code: 'not_active'/);
    assert.match(route, /status: 409/);
    assert.match(route, /status: 404/);
    assert.match(route, /recorded_at: outcome\.recordedAt/);

    // 负向对照：把 not_active 改成 200 的合成片段必须被同一断言判为不合格
    const synthetic = 'return NextResponse.json({ ok: true }, { status: 200 });';
    assert.doesNotMatch(synthetic, /code: 'not_active'/);
    assert.doesNotMatch(synthetic, /status: 409/);
  });
});

// ---------------------------------------------------------------------------
// 8) 公开追踪路由：token 边界、404（不是 403）、无骑手身份
// ---------------------------------------------------------------------------

describe('delivery tracking: public track route', () => {
  const route = stripComments(read('src/app/api/store/deliveries/[id]/track/route.ts'));

  test('租户与门店只来自 token', () => {
    assert.match(route, /resolvePublicStore\(request\.nextUrl\.searchParams\.get\('token'\)\)/);
    assert.match(route, /\.eq\('tenant_id', store\.tenantId\)/);
    assert.match(route, /\.eq\('business_id', store\.businessId\)/);
    // 不得从查询参数里读租户/门店
    assert.doesNotMatch(route, /searchParams\.get\('(tenant|business)/);
  });

  test('用的是 404 而不是 403（403 会泄漏"这张单存在"）', () => {
    assert.match(route, /status: 404/);
    assert.doesNotMatch(route, /status: 403/, '403 等于告诉调用方"这张单存在，只是不归你" —— 可被用来枚举订单');

    // 负向对照：下面这个合成片段必须被同一组断言判为不合格
    const synthetic = "return NextResponse.json({ error: 'forbidden' }, { status: 403 });";
    assert.match(synthetic, /status: 403/);
    assert.doesNotMatch(synthetic, /status: 404/);
  });

  test('响应里没有骑手姓名 / 电话等身份字段', () => {
    for (const field of ['rider_name', 'recipient_name', 'recipient_phone', 'rider_phone', 'phone']) {
      assert.doesNotMatch(
        route,
        new RegExp(field),
        `追踪响应里出现了 ${field} —— 顾客需要的是位置，不是这名员工的身份`,
      );
    }

    // 负向对照：带 identity 的合成响应必须被同一断言判为不合格
    const synthetic = "NextResponse.json({ rider: { lat: 1, lng: 2 }, rider_name: 'Li', phone: '555' })";
    assert.match(synthetic, /rider_name/);
    assert.match(synthetic, /phone/);
  });

  test('响应形状：rider 与 estimate 均可为 null，且不含编造的位置', () => {
    assert.match(route, /rider_status: riderStatus/);
    assert.match(route, /promised_at: row\.promised_at/);
    assert.match(route, /destination: \{ address_line: row\.address_line \}/);
    assert.match(route, /rider: position/, 'rider 必须由"有没有位置行"决定，不能无条件给对象');
    assert.match(route, /estimate,/);
    // 没有位置时必须是 null，不得回落成任何坐标
    assert.match(route, /: null,/);
  });

  test('状态值过白名单，脏值不会直接透给顾客', () => {
    assert.match(route, /RIDER_STATUSES\.includes\(row\.rider_status as RiderStatus\)/);
  });
});

// ---------------------------------------------------------------------------
// 9) 迁移：表/索引/幂等，且**不得**给 delivery_orders 加级联外键
// ---------------------------------------------------------------------------

describe('delivery tracking: migration', () => {
  const sql = read('scripts/migrate-delivery-positions.sql');

  test('表与索引齐全，且全部幂等', () => {
    assert.match(sql, /create table if not exists public\.delivery_positions/);
    assert.match(sql, /lat numeric\(9,6\) not null/);
    assert.match(sql, /lng numeric\(9,6\) not null/);
    assert.match(sql, /accuracy_m numeric\(7,1\)/);
    assert.match(sql, /recorded_at timestamptz not null default now\(\)/);
    assert.match(
      sql,
      /create index if not exists delivery_positions_delivery_idx\s+on public\.delivery_positions \(delivery_id, recorded_at desc\)/,
    );
    assert.match(
      sql,
      /create index if not exists delivery_positions_recorded_idx\s+on public\.delivery_positions \(recorded_at\)/,
    );
  });

  test('目标点坐标是可空列，且是幂等的 add column', () => {
    assert.match(sql, /add column if not exists dest_lat numeric\(9,6\)/);
    assert.match(sql, /add column if not exists dest_lng numeric\(9,6\)/);
    // 可空：没有地理编码就没有坐标，NULL 是合法且唯一诚实的状态
    assert.doesNotMatch(sql, /dest_lat numeric\(9,6\) not null/);
  });

  test('不得给 delivery_orders 加级联外键 —— 位置必须能被保留期独立删除', () => {
    // 合成阳性对照：这一段**就是**我们要拦住的那种写法。
    const synthetic = 'delivery_id varchar(36) not null references public.delivery_orders(id) on delete cascade,';
    const cascadeRe = /on\s+delete\s+cascade/i;
    const cascadeFkRe = /references\s+public\.delivery_orders\s*\([^)]*\)\s*on\s+delete\s+cascade/i;

    assert.match(synthetic, cascadeRe, '阳性对照没能被正则命中 —— 下面的断言是无效的');
    assert.match(synthetic, cascadeFkRe, '阳性对照没能被外键正则命中 —— 下面的断言是无效的');

    const stripped = stripComments(sql);
    assert.doesNotMatch(stripped, cascadeRe, '迁移里出现了级联删除：订单被清理时会静默删掉位置审计');
    assert.doesNotMatch(stripped, cascadeFkRe);
    assert.doesNotMatch(stripped, /references\s+public\.delivery_orders/i, '本表不得引用 delivery_orders');
  });

  test('为什么"不加级联"必须写在注释里（下一个人加外键时得看得见）', () => {
    assert.match(sql, /级联删除/, '缺少"为什么不加级联"的说明');
    assert.match(sql, /保留期/, '缺少"位置由保留期任务独立删除"的说明');
  });
});

// ---------------------------------------------------------------------------
// 10) 调度器：保留期清理挂在既有 tick 上，不另起调度器
// ---------------------------------------------------------------------------

describe('delivery tracking: scheduler retention job', () => {
  const scheduler = stripComments(read('src/lib/scheduler.ts'));

  test('在 runScheduledJobsInner 的逐门店循环里恰好调用一次', () => {
    const start = scheduler.indexOf('async function runScheduledJobsInner');
    const end = scheduler.indexOf('export async function runScheduledJobs');
    assert.ok(start > 0 && end > start, '未找到 runScheduledJobsInner —— 结构已变，请更新本测试');
    const body = scheduler.slice(start, end);

    assert.equal(
      (body.match(/purgeOldPositions\(/g) ?? []).length, 1,
      '必须在既有 tick 内恰好调用一次；另起调度器会多出一条无人监督的定时链路',
    );
    const loopAt = body.indexOf('for (const business of businesses)');
    assert.ok(loopAt > 0, '未找到逐门店循环');
    assert.ok(body.indexOf('purgeOldPositions(') > loopAt, '清理必须落在逐门店循环内');
  });

  test('删除条数被记录，失败被记录（不静默）', () => {
    const start = scheduler.indexOf('async function runScheduledJobsInner');
    const end = scheduler.indexOf('export async function runScheduledJobs');
    const body = scheduler.slice(start, end);
    assert.match(body, /const purgedPositions = await purgeOldPositions\(/);
    assert.match(body, /if \(purgedPositions > 0\)/);
    assert.match(body, /console\.log\(/);
    assert.match(body, /purged \$\{purgedPositions\} expired delivery position/);
    assert.match(body, /delivery position purge failed/);
    assert.match(scheduler, /import \{ purgeOldPositions \} from '@\/lib\/delivery-position';/);

    // 负向对照：吞掉异常的写法必须被上面的断言判为不合格
    const synthetic = 'try { await purgeOldPositions(a, b); } catch {}';
    assert.doesNotMatch(synthetic, /delivery position purge failed/);
  });
});
