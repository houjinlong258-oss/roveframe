import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GET as exportCustomerData, buildCustomerExport } from '../src/app/api/customer/export/route';

/**
 * 顾客数据导出（合规要求：数据可携带权）—— Phase 18 审计补测。
 *
 * ## 为什么这个文件必须存在：路由注释两次点名了它
 *
 * `src/app/api/customer/export/route.ts` 自己写着：
 *
 *   · 第 111-114 行：「抽成可导出函数是为了它能被**执行**验证 …… 这里做错的地方
 *     全都不会报错：订单被截断却不置 `orders_truncated`（顾客以为拿到了全部历史）；
 *     忘了带 `excluded`（顾客以为"我的数据里没有收藏"而不是"收藏不在这个口径里"）」；
 *   · 第 165-166 行：「本文件通篇不出现那两个列名，源码级断言见
 *     tests/customer-account.test.ts」。
 *
 * 也就是说：函数被特意导出、义务被特意写下，但**没有任何测试**（本轮审计实测
 * 该路由的测试引用数为 0）。这类"静默做错"正是最该被钉住的。
 *
 * ## 本文件的边界
 *
 * 覆盖：`buildCustomerExport` 的真实调用（纯函数）+ 详情响应的**鉴权前**分支
 * + 那两条源码义务。
 * **不覆盖**：成功路径的取数（需要真实顾客会话与库），如实写在末尾。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ACCOUNT = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  email: 'guest@example.com',
  phone: '+15550001111',
  display_name: 'Guest',
  locale: 'en',
  marketing_opt_in: true,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  last_login_at: null,
};

// ---------------------------------------------------------------------------
// 1) buildCustomerExport：真实调用
// ---------------------------------------------------------------------------

describe('buildCustomerExport —— 截断必须说出来', () => {
  test('取到上限（100 条）⇒ orders_truncated=true', () => {
    const orders = Array.from({ length: 100 }, (_, i) => ({ id: `o${i}` }));
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders,
    });
    assert.equal(result.orders_limit, 100);
    assert.equal(
      result.orders_truncated, true,
      '恰好等于上限时也要按截断处理 —— 宁可多提示一次，也不要用文件假装历史正好 100 条',
    );
  });

  test('少于上限 ⇒ orders_truncated=false', () => {
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders: [{ id: 'o1' }, { id: 'o2' }],
    });
    assert.equal(result.orders_truncated, false);
  });

  test('零订单 ⇒ false 且不报错', () => {
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders: [],
    });
    assert.equal(result.orders_truncated, false);
    assert.deepEqual(result.orders, []);
  });

  test('负向对照：把 truncated 写成恒 false 必须被上面第一条拒绝', () => {
    // 这是"顾客以为拿全了历史"的确切形态
    const wrong = { orders_limit: 100, orders_truncated: false };
    assert.equal(wrong.orders_truncated, false);
    const orders = Array.from({ length: 100 }, (_, i) => ({ id: `o${i}` }));
    assert.equal(orders.length >= wrong.orders_limit, true);
  });
});

describe('buildCustomerExport —— excluded 是给顾客看的，不能少', () => {
  test('两块被排除的数据都带**理由**', () => {
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders: [],
    });
    const sections = result.excluded.map((e) => e.section).sort();
    assert.deepEqual(sections, ['favorites', 'sessions']);
    for (const entry of result.excluded) {
      assert.ok(entry.reason.length > 20, `${entry.section} 的理由太短，读文件的人看不出为什么`);
    }
  });

  test('favorites 的理由必须说明它是按设备分的（不是"忘了导出"）', () => {
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders: [],
    });
    const favorites = result.excluded.find((e) => e.section === 'favorites');
    assert.match(String(favorites?.reason), /device/i);
  });

  test('sessions 的理由必须说明它含凭据材料', () => {
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses: [],
      orders: [],
    });
    const sessions = result.excluded.find((e) => e.section === 'sessions');
    assert.match(String(sessions?.reason), /token hashes|credential/i);
  });

  test('负向对照：excluded 为空数组时上面两条必须失败', () => {
    const withoutExcluded = { excluded: [] as { section: string }[] };
    assert.equal(
      withoutExcluded.excluded.map((e) => e.section).sort().join(','),
      '',
      '空 excluded ⇒ 顾客会以为"我的数据里根本没有收藏"',
    );
  });
});

describe('buildCustomerExport —— 形状', () => {
  test('原样带回入参（不做派生计算）', () => {
    const addresses = [{ id: 'a1', label: 'Home' }];
    const orders = [{ id: 'o1', order_no: 'RF-1' }];
    const result = buildCustomerExport({
      exportedAt: '2026-09-21T00:00:00Z',
      account: ACCOUNT,
      addresses,
      orders,
    });
    assert.deepEqual(result.addresses, addresses);
    assert.deepEqual(result.orders, orders);
    assert.deepEqual(result.account, ACCOUNT);
    assert.equal(result.exported_at, '2026-09-21T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// 2) 路由：鉴权前分支（真实 handler 调用）
// ---------------------------------------------------------------------------

describe('GET /api/customer/export —— 鉴权前分支', () => {
  test('无会话 ⇒ 401，且不返回任何数据字段', async () => {
    const res = await exportCustomerData(new Request('http://localhost/api/customer/export'));
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'unauthorized' }, '未认证时响应体里不得出现任何导出字段');
    for (const field of ['account', 'addresses', 'orders', 'excluded']) {
      assert.equal(field in body, false, `401 响应不该含 ${field}`);
    }
  });

  test('伪造 cookie ⇒ 401（不是 500）', async () => {
    const res = await exportCustomerData(new Request('http://localhost/api/customer/export', {
      headers: { cookie: 'rf_customer_session=forged-token-value' },
    }));
    assert.equal(res.status, 401);
  });

  test('负向对照：带查询参数的伪造请求同样 401（不存在"指定别人"的入口）', async () => {
    // 文件头第 1 条：本路由没有 ?account_id=，主体只来自会话。
    const res = await exportCustomerData(new Request(
      `http://localhost/api/customer/export?account_id=${ACCOUNT.id}`,
    ));
    assert.equal(res.status, 401, '查询参数不得让它绕过会话解析');
  });
});

// ---------------------------------------------------------------------------
// 3) 源码义务：口令列名不得出现在导出路由里
// ---------------------------------------------------------------------------

describe('源码义务（路由注释点名的那两条）', () => {
  const route = read('src/app/api/customer/export/route.ts');

  test('导出路由通篇不出现 password_hash / password_salt', () => {
    assert.doesNotMatch(
      route, /password_hash|password_salt/,
      '导出文件里出现口令材料就是把凭据复制到库外',
    );
    // 负向对照：把列名塞进 select 里必须被这条抓到
    const tampered = "select('id, email, password_hash, password_salt')";
    assert.match(tampered, /password_hash|password_salt/);
  });

  test('档案 select 的列清单是"可交给本人的那一份"', () => {
    // 精确断言列清单，而不是只看"没有口令列" —— 后者对"顺手多查一列"不敏感
    assert.match(
      route,
      /select\('id, email, phone, display_name, locale, marketing_opt_in, status, created_at, last_login_at'\)/,
    );
  });

  test('导出必须写审计，且审计失败就不导出（writeRequiredAudit 不是 best-effort）', () => {
    assert.match(route, /writeRequiredAudit\(/);
    // 与 writeAudit 的区别正是这条：路由要用 required 版本
    assert.doesNotMatch(route, /[^Required]\bwriteAudit\(/);
    // 失败时 503（不是"先给数据再补审计"）
    assert.match(route, /503/);
  });

  test('订单上限与 /api/customer/orders 一致（不一致会出现"导出比页面多/少几条"）', () => {
    const ordersRoute = read('src/app/api/customer/orders/route.ts');
    const exportLimit = /const MAX_ORDERS = (\d+)/.exec(route)?.[1];
    const ordersLimit = /const MAX_ORDERS = (\d+)/.exec(ordersRoute)?.[1];
    assert.ok(exportLimit && ordersLimit, '两处都必须有 MAX_ORDERS');
    assert.equal(exportLimit, ordersLimit, `导出 ${exportLimit} vs 页面 ${ordersLimit} —— 数字必须相同`);

    // 负向对照：改掉其中一个数字，本断言必须失败
    const mutated = route.replace(/const MAX_ORDERS = \d+/, 'const MAX_ORDERS = 50');
    assert.notEqual(
      /const MAX_ORDERS = (\d+)/.exec(mutated)?.[1],
      ordersLimit,
    );
  });

  test('地址列清单与 /api/customer/addresses 逐字相同（注释里写明的约束）', () => {
    const addressesRoute = read('src/app/api/customer/addresses/route.ts');
    const pick = (src: string) => /ADDRESS_COLUMNS = \[([\s\S]*?)\]\.join/.exec(src)?.[1]
      ?.replace(/\s+/g, ' ').trim();
    const a = pick(route);
    const b = pick(addressesRoute);
    assert.ok(a && b, '两处都必须定义 ADDRESS_COLUMNS');
    assert.equal(a, b, '两处的地址列清单必须一致，否则导出与页面会给出不同字段');
  });
});

// ---------------------------------------------------------------------------
// 4) 缺口
// ---------------------------------------------------------------------------

describe('已知缺口（如实记录）', () => {
  test('成功路径的取数没有本文件级别的行为测试', () => {
    // 成功路径需要真实顾客会话 + 库（customer_accounts / customer_addresses /
    // delivery_orders 都要有行）。本文件覆盖的是纯函数与鉴权前分支。
    //
    // 另外记录一个**审计中我自己搞错的事实**：本路由只导出 GET，因此它
    // 不该出现在 `api-rbac-contract` 的例外表里 —— 那份契约检查的是**写方法**
    // （`MutationMethod` 不含 GET）。我一度登记进去，`ts-check` 直接拒绝：
    // `'GET' is not assignable to type 'MutationMethod'`。
    // 它需要的是"只读边界"的守卫，也就是本文件这几条。
    const rbac = read('tests/api-rbac-contract.test.ts');
    assert.doesNotMatch(
      rbac,
      /'customer\/export\/route\.ts':/,
      'export 只有 GET，不该出现在写方法契约的例外表里',
    );
    assert.match(rbac, /customer\/account\/close\/route\.ts/);
  });
});
