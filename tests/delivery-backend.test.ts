import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasPermission } from '../src/lib/rbac';
import {
  DEFAULT_DELIVERY_RULES,
  RIDER_STATUSES,
  canRiderAdvance,
  deliveryContentFingerprint,
  normalizeDeliveryRules,
  promisedAtFrom,
  quoteDelivery,
} from '../src/lib/delivery';

/**
 * Phase 18 —— 外卖配送后端的守卫。
 *
 * ## 守的是什么
 *
 * 这一层的失败模式几乎全是**静默**的：
 *
 *   1. 幂等索引写错范围（`where source='qr'` 而不是 `'web'`）→ 并发同 key 落两张单，
 *      而路由的 23505 兜底永远不会触发（它等的就是这个冲突）。
 *   2. 认单从"单条原子 UPDATE"被重构成"先查再改"→ 两个员工接到同一单，
 *      偶发、测试环境几乎复现不出来。
 *   3. 状态推进漏掉 `rider_staff_id` 过滤 → 任何员工能推进任何单。
 *   4. `settings.delivery` 是 jsonb，里面可能是任何东西；不做归一化就会
 *      把字符串当数字算配送费。
 *   5. 公开路径写成了 `/api/store` 前缀 → 整段 store API 静默变成公开。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1) 迁移链与幂等索引
// ---------------------------------------------------------------------------

describe('delivery backend: migrations', () => {
  test('两个新迁移都在自动迁移清单里且文件存在', async () => {
    const mod = await import('../src/lib/migration');
    for (const rel of ['scripts/migrate-staff-identity.sql', 'scripts/migrate-delivery-orders.sql']) {
      assert.ok(mod.MIGRATION_FILE_LIST.includes(rel), `${rel} 不在 MIGRATION_FILES —— 全新部署不会执行它`);
      assert.ok(existsSync(join(ROOT, rel)), `${rel} 被引用但文件不存在`);
    }
  });

  test('外卖幂等索引的范围是 source = web（不是 qr）', () => {
    const sql = read('scripts/migrate-delivery-orders.sql');
    assert.match(
      sql,
      /create unique index orders_web_idempotency_idx\s+on public\.orders \(tenant_id, business_id, external_id\)\s+where source = 'web' and external_id is not null;/,
    );
  });

  test('既有索引确实是 source = qr —— 这正是必须新建一条的原因', () => {
    const sql = read('scripts/migrate-business-tables.sql');
    assert.match(
      sql,
      /create unique index orders_qr_idempotency_idx[\s\S]{0,120}where source = 'qr' and external_id is not null;/,
      '既有幂等索引不再是 qr 范围 —— 那么外卖那条新索引的前提假设变了，请重新评估',
    );
  });

  test('配送状态列存在且默认 pending', () => {
    const sql = read('scripts/migrate-delivery-orders.sql');
    assert.match(sql, /rider_status varchar\(20\) not null default 'pending'/);
    assert.match(sql, /alter table public\.settings\s+add column if not exists delivery jsonb not null default '\{\}'::jsonb;/);
  });

  test('配送单外键是 cascade —— 否则 /api/settings/wipe 会失败', () => {
    const sql = read('scripts/migrate-delivery-orders.sql');
    assert.match(sql, /order_id varchar\(36\) not null references public\.orders\(id\) on delete cascade/);
  });

  test('schema.ts 与迁移一致（表名被迁移覆盖）', async () => {
    const schema = read('src/storage/database/shared/schema.ts');
    assert.match(schema, /export const deliveryOrders = pgTable\(\s*"delivery_orders"/);
    const sql = read('scripts/migrate-delivery-orders.sql');
    assert.match(sql, /create table if not exists public\.delivery_orders/);
  });
});

// ---------------------------------------------------------------------------
// 2) 并发安全（源码级守卫）
//
// 这一条守的是"实现方式"，不是"某次行为"。理由是竞态只在真实并发下偶发，
// 行为测试在单进程里几乎必然通过 —— 那样的测试给不出任何保证。
// ---------------------------------------------------------------------------

describe('delivery backend: concurrency guards', () => {
  const lib = stripComments(read('src/lib/delivery.ts'));

  test('认单是单条原子 UPDATE：条件里带 rider_status = pending', () => {
    const fn = lib.slice(lib.indexOf('export async function claimDeliveryOrder'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /\.from\('delivery_orders'\)\s*\.update\(/);
    assert.match(body, /\.eq\('rider_status', 'pending'\)/);
    assert.match(body, /\.select\('id'\)/);
    // 必须是 update 链上的过滤条件，而不是先 select 再 update
    const updateIndex = body.indexOf('.update(');
    const pendingIndex = body.indexOf(".eq('rider_status', 'pending')");
    assert.ok(pendingIndex > updateIndex, 'rider_status 过滤必须挂在 update 链上，不能是先查再改');
  });

  test('负向对照：把认单改回"先查再改"，上面的断言必须不成立', () => {
    const broken = `
      export async function claimDeliveryOrder() {
        const { data: existing } = await client.from('delivery_orders').select('id').eq('rider_status', 'pending');
        if (!existing) return { ok: false };
        await client.from('delivery_orders').update({ rider_status: 'claimed' }).eq('id', 'x');
      }`;
    const body = broken.slice(broken.indexOf('export async function claimDeliveryOrder'));
    assert.equal(
      /\.from\('delivery_orders'\)\s*\.update\([\s\S]*?\.eq\('rider_status', 'pending'\)/.test(body),
      false,
      '先查再改的写法不该被这条断言放行',
    );
  });

  test('状态推进带 rider_staff_id 过滤 —— 这是越权的第二道锁', () => {
    const fn = lib.slice(lib.indexOf('export async function advanceDeliveryStatus'));
    const body = fn.slice(0, fn.indexOf('export async function assignDelivery'));
    assert.match(body, /\.eq\('rider_staff_id', staffId\)/);
    // 读与写之间可能有人推进过，所以 UPDATE 里也要保留 from 状态
    assert.match(body, /\.eq\('rider_status', from\)/);
  });

  test('状态机白名单：pending 不能直接跳 picked_up，delivered 是终态', () => {
    assert.equal(canRiderAdvance('pending', 'picked_up'), false);
    assert.equal(canRiderAdvance('pending', 'delivered'), false);
    assert.equal(canRiderAdvance('claimed', 'picked_up'), true);
    assert.equal(canRiderAdvance('picked_up', 'delivered'), true);
    assert.equal(canRiderAdvance('delivered', 'picked_up'), false);
    assert.equal(canRiderAdvance('cancelled', 'claimed'), false);
    assert.deepEqual([...RIDER_STATUSES], ['pending', 'claimed', 'picked_up', 'delivered', 'cancelled']);
  });

  test('骑手不能自己取消单 —— cancelled 不在骑手可推进集合里', () => {
    for (const from of RIDER_STATUSES) {
      assert.equal(canRiderAdvance(from, 'cancelled'), false, `${from} → cancelled 不该被放行`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3) 规则归一化与计价
// ---------------------------------------------------------------------------

describe('delivery backend: rules and pricing', () => {
  test('缺省是关闭的 —— 不能凭空给所有商家多一个没定价的配送通道', () => {
    assert.equal(DEFAULT_DELIVERY_RULES.enabled, false);
    assert.equal(normalizeDeliveryRules(undefined).enabled, false);
    assert.equal(normalizeDeliveryRules({}).enabled, false);
    assert.equal(normalizeDeliveryRules(null).enabled, false);
    assert.equal(normalizeDeliveryRules('nonsense').enabled, false);
    assert.equal(normalizeDeliveryRules([]).enabled, false);
  });

  test('jsonb 里的脏值被收敛，不会把字符串当数字算', () => {
    const rules = normalizeDeliveryRules({
      enabled: true,
      minOrderAmount: '20',
      fee: 'abc',
      freeDeliveryAbove: '',
      prepMinutes: 9999,
    });
    assert.equal(rules.enabled, true);
    assert.equal(rules.minOrderAmount, 20);
    assert.equal(rules.fee, 0, 'fee=abc 必须回落到 0，而不是 NaN');
    assert.equal(rules.freeDeliveryAbove, null);
    assert.equal(rules.prepMinutes, 240, 'prepMinutes 必须被夹到上限');
  });

  test('负数与超上限的金额被拒绝', () => {
    const rules = normalizeDeliveryRules({ minOrderAmount: -5, fee: 10_000_000 });
    assert.equal(rules.minOrderAmount, 0);
    assert.equal(rules.fee, 0);
  });

  test('起送价判定给出差额', () => {
    const rules = normalizeDeliveryRules({ enabled: true, minOrderAmount: 20, fee: 3 });
    const below = quoteDelivery(rules, 12.5);
    assert.equal(below.meetsMinimum, false);
    assert.equal(below.shortfall, 7.5);
    const ok = quoteDelivery(rules, 25);
    assert.equal(ok.meetsMinimum, true);
    assert.equal(ok.shortfall, 0);
    assert.equal(ok.fee, 3);
  });

  test('满额免配送费', () => {
    const rules = normalizeDeliveryRules({ enabled: true, fee: 5, freeDeliveryAbove: 50 });
    assert.equal(quoteDelivery(rules, 49.99).fee, 5);
    assert.equal(quoteDelivery(rules, 50).fee, 0);
    assert.equal(quoteDelivery(rules, 50).freeDeliveryApplied, true);
  });

  test('promised_at 由备餐分钟数推出', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    assert.equal(promisedAtFrom(now, 35), '2026-09-10T12:35:00.000Z');
    // 负向对照：不是原样返回，也不是按小时取整
    assert.notEqual(promisedAtFrom(now, 35), now.toISOString());
    assert.notEqual(promisedAtFrom(now, 35), '2026-09-10T13:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 4) 幂等指纹
// ---------------------------------------------------------------------------

describe('delivery backend: idempotency fingerprint', () => {
  const base = {
    items: [{ product_id: 'p2', qty: 1 }, { product_id: 'p1', qty: 2 }],
    subtotal: 30,
    fee: 3,
    addressLine: '1 Main St',
    recipientPhone: '5551234',
  };

  test('与商品顺序无关', () => {
    const reordered = { ...base, items: [base.items[1], base.items[0]] };
    assert.equal(deliveryContentFingerprint(base), deliveryContentFingerprint(reordered));
  });

  test('改了地址就是另一单（外卖没有桌号，地址是内容的一部分）', () => {
    assert.notEqual(
      deliveryContentFingerprint(base),
      deliveryContentFingerprint({ ...base, addressLine: '2 Main St' }),
    );
  });

  test('改了配送费就是另一单', () => {
    assert.notEqual(deliveryContentFingerprint(base), deliveryContentFingerprint({ ...base, fee: 0 }));
  });
});

// ---------------------------------------------------------------------------
// 5) 权限与边界
// ---------------------------------------------------------------------------

describe('delivery backend: permissions', () => {
  test('staff 能接单，但拿不到 orders:write 与 delivery:dispatch', () => {
    assert.equal(hasPermission('staff', 'delivery:claim'), true);
    assert.equal(hasPermission('staff', 'orders:write'), false, '给 staff orders:write 等于允许改任意订单金额');
    assert.equal(hasPermission('staff', 'delivery:dispatch'), false, '指派是管理动作，不是骑手动作');
    assert.equal(hasPermission('staff', 'workforce:manage'), false);
    assert.equal(hasPermission('staff', 'products:read'), true);
  });

  test('manager 能指派，owner 全权', () => {
    assert.equal(hasPermission('manager', 'delivery:dispatch'), true);
    assert.equal(hasPermission('manager', 'delivery:claim'), true);
    assert.equal(hasPermission('owner', 'delivery:dispatch'), true);
  });

  test('负向对照：把 orders:write 加进 staff，第一条断言必须变红', () => {
    const src = read('src/lib/rbac.ts');
    assert.equal(
      /staff:\s*\[[\s\S]*?'orders:write'[\s\S]*?\]/.test(stripComments(src)),
      false,
      'staff 权限列表里出现了 orders:write',
    );
  });

  test('公开路径逐条列出，不含 /api/team 与 /api/staff', async () => {
    const mod = await import('../src/lib/auth-guard');
    const prefixes = mod.PUBLIC_API_PREFIXES as readonly string[];
    assert.ok(prefixes.includes('/api/store/delivery-orders'));
    assert.ok(prefixes.includes('/api/site/config'));
    assert.equal(mod.isPublicApiPath('/api/store/delivery-orders'), true);
    assert.equal(mod.isPublicApiPath('/api/team/delivery'), false, '店长侧接口绝不能是公开路径');
    assert.equal(mod.isPublicApiPath('/api/staff/deliveries'), false, '员工端接口绝不能是公开路径');
    assert.equal(mod.isPublicApiPath('/api/site/domain'), false, '不得因为 /api/site 前缀而整体放行');
  });

  test('员工端身份解析不返回 200 给"账号有效但无档案"的情况', () => {
    const src = stripComments(read('src/lib/workforce.ts'));
    assert.match(src, /status: 409/);
    assert.match(src, /staff_not_linked/);
  });

  test('员工上下文必须校验 workforce:self，越权尝试不得静默通过', () => {
    const src = stripComments(read('src/lib/workforce.ts'));
    assert.match(src, /requirePermission\(context, 'workforce:self'\)/);
    assert.match(src, /status: 403/);
  });

  test('员工端两个写接口走中央守卫，并各自带审计 action', () => {
    const claim = stripComments(read('src/app/api/staff/deliveries/claim/route.ts'));
    const status = stripComments(read('src/app/api/staff/deliveries/[id]/status/route.ts'));
    assert.match(claim, /export const POST = protectBusinessMutation\(/);
    assert.match(claim, /permission: 'delivery:claim'/);
    assert.match(claim, /action: 'delivery\.claim'/);
    assert.match(status, /export const POST = protectBusinessMutation\(/);
    assert.match(status, /action: 'delivery\.status'/);
    // 两个接口都不能只靠权限矩阵 —— 都必须解析出员工档案（越权第二道锁的来源）
    assert.match(claim, /resolveStaffForUser\(/);
    assert.match(status, /resolveStaffForUser\(/);
  });
});

// ---------------------------------------------------------------------------
// 6) 计价只在服务端
// ---------------------------------------------------------------------------

describe('delivery backend: server-side pricing only', () => {
  const route = stripComments(read('src/app/api/store/delivery-orders/route.ts'));

  test('请求体里不读 total / fee / subtotal —— 金额一律服务端算', () => {
    for (const field of ['total', 'fee', 'subtotal']) {
      assert.doesNotMatch(
        route,
        new RegExp(`raw\\.${field}\\b`),
        `路由从请求体读了 ${field}；金额必须由服务端按 products 表计算`,
      );
    }
  });

  test('未达起送价返回 400 且带差额', () => {
    assert.match(route, /order_below_minimum/);
    assert.match(route, /shortfall: quote\.shortfall/);
  });

  test('商家未开外卖返回 409（不是 403/404）', () => {
    assert.match(route, /does not offer delivery' \}, \{ status: 409 \}/);
  });

  test('配送单建失败时不能假装成功：订单要被标记取消', () => {
    assert.match(route, /status: 'cancelled'/);
    assert.match(route, /delivery could not be created/);
  });

  test('配送费与起送价按下单那一刻的快照落库', () => {
    assert.match(route, /fee: quote\.fee/);
    assert.match(route, /min_order_amount: quote\.minOrderAmount/);
  });
});
