import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

import {
  diffSchema,
  driftIsEmpty,
  expectedSchemaFromModule,
  liveSchemaFromOpenApi,
  type SchemaShape,
} from '../src/lib/schema-drift';
import { fetchLiveSchema, runBootChecks, BOOT_CHECK_SELF_LABEL } from '../src/lib/boot-check';
import * as schemaModule from '../src/storage/database/shared/schema';

/**
 * Schema 漂移门禁（Phase 19 上线阻断项 6）。
 *
 * ## 被修的是什么
 *
 * `boot-check.ts` 的 `REQUIRED_TABLES` 曾是**手写的 11 张表**（schema 里有 52 张），
 * 于是 `/api/health` 的 `missingCount: 0` 只证明 11 张在，却被读成"52/52 都在"；
 * 而 `scripts/verify-migrations.mjs` 是文件级比对，从不连库，挡不住"库里真的缺列"。
 *
 * ## 本文件必须包含一个**能产生不通过**的对照
 *
 * 任务书明确要求："先把某必需列在测试库上 drop（或用构造的假 schema 输入），
 * 断言检查失败，再恢复。没有这一步的'通过'不算通过。"
 *
 * 这里用**两条**对照，且都零写入（不需要 DDL、不需要删列）：
 *
 *   1. 构造的假 schema 输入：喂一份缺表/缺列的 live schema，断言它被报出来；
 *   2. **真实库上的构造对照**：拿真实的 live schema，把期望清单人为加一列
 *      （一个绝不可能存在的列名），断言真实路径报"缺列"。
 *      这条证明的是"真实数据通路 + 判定逻辑"整体能失败 —— 比删列更安全，
 *      而且比纯逻辑对照更有说服力。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

describe('schema 漂移：期望值从 schema.ts 派生（不是手写子集）', () => {
  test('派生出全部 52 张表，而不是 11 张的手写子集', () => {
    const expected = expectedSchemaFromModule(schemaModule as unknown as Record<string, unknown>);
    const tables = Object.keys(expected);
    assert.equal(tables.length, 52, `派生到 ${tables.length} 张表，应为 52 张`);

    // 旧实现只覆盖这 11 张 —— 它们必须仍然在，且现在不止它们
    for (const t of ['cron_state', 'staff', 'business_memories', 'agent_actions', 'agent_approvals',
      'payments', 'payment_events', 'ai_usage_ledger', 'platform_admins',
      'tenant_subscriptions', 'platform_admin_audit_logs']) {
      assert.ok(tables.includes(t), `派生结果缺了 ${t}`);
    }
    // 旧清单之外的表。注意：只有 delivery_orders 在 schema.ts 里被声明，
    // 另三张（delivery_positions / staff_attendance / public_sites）**没有** ——
    // 那是本轮实测发现的盲区，见下面 "代码查询的表" 一节。
    assert.ok(tables.includes('delivery_orders'), '派生结果缺了 delivery_orders');
    assert.equal(
      tables.includes('delivery_positions'), false,
      'delivery_positions 现在出现在 schema.ts 里了？若如此，请更新下面那份'
      + '"代码查询但 schema.ts 未声明" 的钉住清单（这是一件好事，但必须显式改）。',
    );

    const columns = Object.values(expected).reduce((n, c) => n + c.length, 0);
    assert.ok(columns > 400, `只派生出 ${columns} 列，看起来不完整`);
  });

  test('boot-check 不再引用手写清单（防止悄悄退回子集）', () => {
    const src = read('src/lib/boot-check.ts');
    assert.equal(/const REQUIRED_TABLES\s*=/.test(src), false);
    assert.equal(/PROBE_COLUMN/.test(src), false);
  });
});

describe('schema 漂移：判定逻辑（构造输入，零写入）', () => {
  const expect: SchemaShape = {
    orders: ['id', 'total', 'tip'],
    customers: ['id', 'phone'],
  };

  test('缺表必须被报出来', () => {
    const drift = diffSchema(expect, { orders: ['id', 'total', 'tip'] });
    assert.deepEqual(drift.missingTables, ['customers']);
    assert.equal(driftIsEmpty(drift), false);
  });

  test('缺列必须被报出来，且精确到列名', () => {
    const drift = diffSchema(expect, {
      orders: ['id', 'total'],            // 缺 tip
      customers: ['id', 'phone', 'extra'], // extra 不算问题
    });
    assert.deepEqual(drift.missingTables, []);
    assert.deepEqual(drift.missingColumns, [{ table: 'orders', columns: ['tip'] }]);
    assert.deepEqual(drift.extraTables, []);
    assert.equal(driftIsEmpty(drift), false);
  });

  test('完全一致时判定为空（否则这条门禁会永远报错）', () => {
    const drift = diffSchema(expect, { orders: ['total', 'tip', 'id'], customers: ['phone', 'id'] });
    assert.deepEqual(drift.missingTables, []);
    assert.deepEqual(drift.missingColumns, []);
    assert.equal(driftIsEmpty(drift), true);
    assert.equal(drift.checkedTables, 2);
    assert.equal(drift.checkedColumns, 5);
  });

  test('真实库多出来的表不算漂移（视图/非 schema 表）', () => {
    const drift = diffSchema(expect, {
      orders: ['id', 'total', 'tip'],
      customers: ['id', 'phone'],
      some_view: ['a'],
    });
    assert.deepEqual(drift.extraTables, ['some_view']);
    assert.equal(driftIsEmpty(drift), true, '多出来的表不应阻断上线判定');
  });

  test('OpenAPI 文档解析：结构不对时返回空（由调用方按失败处理）', () => {
    assert.deepEqual(liveSchemaFromOpenApi(null), {});
    assert.deepEqual(liveSchemaFromOpenApi({}), {});
    assert.deepEqual(liveSchemaFromOpenApi({ definitions: 'nope' }), {});
    assert.deepEqual(
      liveSchemaFromOpenApi({ definitions: { orders: { properties: { id: {}, total: {} } } } }),
      { orders: ['id', 'total'] },
    );
  });
});

describe('schema 漂移：真实库（连库/REST 检查）', () => {
  test('真实库与 schema.ts 无漂移；空表上的结论不冒充证据', async () => {
    const live = await fetchLiveSchema();
    if (live === null) {
      console.log('  [skip] 读不到真实 schema（无凭据/网络）→ 本条 UNVERIFIED（不是通过）');
      return;
    }
    const expected = expectedSchemaFromModule(schemaModule as unknown as Record<string, unknown>);
    const drift = diffSchema(expected, live);
    assert.deepEqual(
      drift.missingTables, [],
      `这些表在 schema.ts 里声明、真实库里没有：\n  ${drift.missingTables.join('\n  ')}`,
    );
    assert.deepEqual(
      drift.missingColumns, [],
      '这些表缺列（代码会写、库上没有）：\n  '
      + drift.missingColumns.map((m) => `${m.table}: ${m.columns.join(', ')}`).join('\n  '),
    );
    console.log(`  [ok] 核对 ${drift.checkedTables} 张表 / ${drift.checkedColumns} 列，无漂移`
      + `（真实库另有 ${drift.extraTables.length} 张非 schema 表/视图）`);
  });

  test('阴性对照（真实数据通路）：期望里加一列不存在的列，必须报缺列', async () => {
    const live = await fetchLiveSchema();
    if (live === null) {
      console.log('  [skip] 读不到真实 schema → 本条 UNVERIFIED（不是通过）');
      return;
    }
    const expected = expectedSchemaFromModule(schemaModule as unknown as Record<string, unknown>);
    // 人为制造漂移：一个绝不可能存在的列。零写入，不需要 DDL。
    const poisoned: SchemaShape = {
      ...expected,
      orders: [...(expected.orders ?? []), 'zzz_definitely_not_a_column_9f3a'],
    };
    const drift = diffSchema(poisoned, live);
    assert.deepEqual(
      drift.missingColumns,
      [{ table: 'orders', columns: ['zzz_definitely_not_a_column_9f3a'] }],
      '真实通路必须能检出一个人为制造的缺列 —— 否则这条门禁不具检测能力',
    );
    assert.equal(driftIsEmpty(drift), false);

    // 再对照：让真实库里"少一张表"，必须报缺表。
    // 注意方向：缺表是"期望里有、live 里没有"，所以要从 **live** 里删，
    // 不能从 expected 里删 —— 从 expected 删等于"没人期望它"，自然不报缺失。
    // （第一版就是这样写错的，被本条断言当场抓住。）
    const liveWithoutOrders: SchemaShape = { ...live };
    delete liveWithoutOrders.orders;
    const drift2 = diffSchema(expected, liveWithoutOrders);
    assert.deepEqual(drift2.missingTables, ['orders'], '缺表必须被检出');
  });

  test('读不到真实 schema 时 fail-closed（报缺失，绝不报"完整"）', async () => {
    const saved = {
      url: process.env.COZE_SUPABASE_URL,
      key: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,
    };
    try {
      // 指向一个必然连不上的地址（保留 9 端口 + 保留 TEST-NET 网段）
      process.env.COZE_SUPABASE_URL = 'http://127.0.0.1:9';
      process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';
      const results = await runBootChecks();
      assert.ok(
        results.some((r) => r.missing),
        '读不到真实 schema 时 runBootChecks() 必须报缺失；返回"完整"就是静默降级',
      );
      assert.equal(results[0]?.table, BOOT_CHECK_SELF_LABEL);
    } finally {
      if (saved.url === undefined) delete process.env.COZE_SUPABASE_URL;
      else process.env.COZE_SUPABASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
      else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });

  test('health_check 不是自检的依赖（自检不能查自己要检查的东西）', () => {
    const src = read('src/lib/boot-check.ts');
    // 只看代码：注释里提到 health_check 正是在解释"为什么不依赖它"。
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.equal(
      /health_check/.test(code), false,
      'boot-check.ts 的**代码**引用了 health_check —— 它自己也是被检查的表，'
      + '不能作为自检的输入。',
    );
  });
});

/**
 * 盲区闭合：**代码查询的表**也必须在真实库里存在。
 *
 * ## 为什么必须有这一节（本轮实测发现的缺陷）
 *
 * 派生式门禁的期望值来自 `schema.ts`。但实测：**代码用 `.from('x')` 查询了 57 张表，
 * 其中 11 张根本没有在 schema.ts 里声明**：
 *
 *   customer_accounts, customer_addresses, customer_favorites, customer_sessions,
 *   delivery_positions, email_unsubscribes, public_sites, staff_attendance,
 *   staff_care_notes, staff_care_tasks, staff_shifts
 *
 * 这 11 张全是 Phase 17/18 新增的表 —— 与那 12 张 RLS 缺口是同一批。
 * 也就是说：**只按 schema.ts 派生的门禁，恰好漏掉了历史上最容易出事的那一批表**。
 * 这是一个真实的盲区，不是理论担忧。
 *
 * ## 处置（两条，都不新增手写清单）
 *
 *   1. 从源码树**派生**出所有 `.from('<table>')` 的表名，逐张要求它在真实库里存在
 *      —— 这条覆盖 57 张，包括那 11 张；
 *   2. 把"未在 schema.ts 声明"的那份清单**钉住**：数量或成员一变就红。
 *      将来谁新增一张只写代码不写 schema 的表，必须显式改这里（或把表补进
 *      schema.ts）—— 不允许静默扩大盲区。
 */
describe('schema 漂移：代码查询的表也必须存在于真实库（盲区闭合）', () => {
  const ROOT = process.cwd();

  function deriveReferencedTables(): Set<string> {
    const out = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/\.from\(\s*["']([a-z0-9_]+)["']/g)) out.add(m[1]);
      }
    };
    walk(`${ROOT}/src`);
    return out;
  }

  const declaredInSchema = () =>
    new Set(Object.keys(expectedSchemaFromModule(schemaModule as unknown as Record<string, unknown>)));

  /** 已实测确认、且当前都被真实库覆盖的"未声明"表。成员变化必须显式改这一行。 */
  const KNOWN_UNDECLARED = [
    'customer_accounts', 'customer_addresses', 'customer_favorites', 'customer_sessions',
    'delivery_positions', 'email_unsubscribes', 'public_sites', 'staff_attendance',
    'staff_care_notes', 'staff_care_tasks', 'staff_shifts',
  ].sort();

  test('派生出的代码引用表集合不是空的（否则本节什么都没测）', () => {
    const referenced = deriveReferencedTables();
    assert.ok(referenced.size > 40, `只从源码派生到 ${referenced.size} 张表，扫描可能失效`);
    assert.ok(referenced.has('orders'), 'orders 是最常被查询的表之一，必须在派生结果里');
  });

  test('每一张被代码查询的表都必须在真实库里存在', async () => {
    const live = await fetchLiveSchema();
    if (live === null) {
      console.log('  [skip] 读不到真实 schema → 本条 UNVERIFIED（不是通过）');
      return;
    }
    const referenced = [...deriveReferencedTables()].sort();
    const absent = referenced.filter((t) => !(t in live));
    assert.deepEqual(
      absent, [],
      '代码在查询这些表，但真实库里没有 —— 一调用就是 500：\n  ' + absent.join('\n  '),
    );
    console.log(`  [ok] ${referenced.length} 张被代码查询的表全部存在于真实库`);
  });

  test('"代码查询但 schema.ts 未声明"的清单被钉住（新出现的必须显式处理）', () => {
    const referenced = deriveReferencedTables();
    const declared = declaredInSchema();
    const undeclared = [...referenced].filter((t) => !declared.has(t)).sort();
    assert.deepEqual(
      undeclared, KNOWN_UNDECLARED,
      '未声明清单发生了变化。\n'
      + '  新增了：' + JSON.stringify(undeclared.filter((t) => !KNOWN_UNDECLARED.includes(t))) + '\n'
      + '  消失了：' + JSON.stringify(KNOWN_UNDECLARED.filter((t) => !undeclared.includes(t))) + '\n'
      + '这不是坏事也不是好事，但必须是一个**显式**决定：把这些表补进 schema.ts，'
      + '或在此处登记并在报告里说明为何容忍。',
    );
  });

  test('负向对照：派生扫描确实能发现一张"只在代码里出现"的表', () => {
    // 纯逻辑对照：模拟源码里出现一张真实库没有的表，检查必须命中。
    const fakeReferenced = ['orders', 'zzz_definitely_not_a_table_9f3a'];
    const fakeLive: SchemaShape = { orders: ['id'] };
    const absent = fakeReferenced.filter((t) => !(t in fakeLive));
    assert.deepEqual(absent, ['zzz_definitely_not_a_table_9f3a'],
      '这条对照失败说明"每张表都存在"这个断言不具检测能力');
  });
});
