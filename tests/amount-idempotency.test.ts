import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_ORDER_ITEMS,
  MAX_ORDER_TOTAL,
  MAX_TIP_AMOUNT,
  storeOrderSchema,
} from '../src/lib/store-order';

const read = (path: string): string => readFileSync(path, 'utf8');

const validOrder = {
  token: 'a'.repeat(40),
  items: [{ product_id: 'p-1', qty: 2 }],
};

describe('P0-6 store order schema', () => {
  test('合法载荷通过；缺省 tip 为 0', () => {
    const parsed = storeOrderSchema.safeParse(validOrder);
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.tip_amount, 0);
  });

  test('items 超过 50 拒绝', () => {
    const items = Array.from({ length: MAX_ORDER_ITEMS + 1 }, (_, i) => ({ product_id: `p-${i}`, qty: 1 }));
    assert.equal(storeOrderSchema.safeParse({ items }).success, false);
  });

  test('qty 越界（0 / 100 / 非整数）拒绝', () => {
    assert.equal(storeOrderSchema.safeParse({ items: [{ product_id: 'p', qty: 0 }] }).success, false);
    assert.equal(storeOrderSchema.safeParse({ items: [{ product_id: 'p', qty: 100 }] }).success, false);
    assert.equal(storeOrderSchema.safeParse({ items: [{ product_id: 'p', qty: 1.5 }] }).success, false);
  });

  test('tip 超上限与 note 超长拒绝', () => {
    assert.equal(
      storeOrderSchema.safeParse({ ...validOrder, tip_amount: MAX_TIP_AMOUNT + 1 }).success,
      false,
    );
    assert.equal(
      storeOrderSchema.safeParse({ ...validOrder, note: 'x'.repeat(501) }).success,
      false,
    );
    assert.ok(MAX_ORDER_TOTAL > 0);
  });
});

describe('P0-6 金额/幂等源码契约', () => {
  test('store/orders 23505 冲突回读既有订单（并发同 key 只落一行）', () => {
    const src = read('src/app/api/store/orders/route.ts');
    assert.match(src, /insertError\.code === '23505'/);
    assert.match(src, /idempotent: true/);
    assert.match(src, /from\('orders'\)[\s\S]{0,300}eq\('external_id', idempotencyKey\)/);
  });

  test('订单幂等部分唯一索引由迁移 SQL 单一事实源提供', () => {
    for (const file of ['scripts/migrate.sql']) {
      const sql = read(file);
      assert.match(
        sql,
        /orders_qr_idempotency_idx[\s\S]{0,200}\(tenant_id, business_id, external_id\)[\s\S]{0,120}where source = 'qr' and external_id is not null/,
        `${file} 缺少订单幂等部分唯一索引`,
      );
    }
    // P0-14：migration.ts 不再内嵌第二份 SQL 副本，改为执行磁盘上的迁移文件
    const runner = read('src/lib/migration.ts');
    assert.match(runner, /scripts\/migrate\.sql/);
    assert.match(runner, /scripts\/migrate-pilot-ready\.sql/);
    assert.ok(!runner.includes('orders_qr_idempotency_idx'), 'migration.ts 禁止再内嵌 DDL 副本');
  });

  test('checkout reservation 分支按权威 due_amount 比对，无权威价拒绝', () => {
    const src = read('src/app/api/payments/checkout/route.ts');
    assert.match(src, /'reservations', 'id, due_amount'/);
    assert.match(src, /no authoritative due amount/);
    assert.match(src, /does not match the scoped reservation due amount/);
  });

  test('reservations.due_amount 在 schema 与迁移 SQL 中定义', () => {
    assert.match(read('src/storage/database/shared/schema.ts'), /due_amount: numeric\("due_amount", \{ precision: 10, scale: 2 \}\)/);
    assert.match(read('scripts/migrate.sql'), /add column if not exists due_amount numeric\(10,2\)/);
    assert.match(read('scripts/migrate-business-tables.sql'), /due_amount numeric\(10,2\),/);
  });

  test('wipe 双 scope + 一次性令牌 + dry-run，跨门店不清除', () => {
    const src = read('src/app/api/settings/wipe/route.ts');
    assert.match(src, /\.eq\('tenant_id', context\.tenantId\)/);
    assert.match(src, /\.eq\('business_id', context\.businessId\)/);
    assert.match(src, /confirmation token required/);
    assert.match(src, /dryRun/);
    assert.match(src, /issued\.businessId !== context\.businessId/);
  });

  test('settings/overview 按 tenant+business 双 scope 计数', () => {
    const src = read('src/app/api/settings/overview/route.ts');
    assert.match(src, /\.eq\('tenant_id', context\.tenantId\)/);
    assert.match(src, /\.eq\('business_id', context\.businessId\)/);
  });
});
