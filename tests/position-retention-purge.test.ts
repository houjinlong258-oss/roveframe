import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { purgeOldPositions, DEFAULT_POSITION_RETENTION_HOURS, normalizeRetentionHours }
  from '../src/lib/delivery-position';
import { getSupabaseClient } from '../src/storage/database/supabase-client';

/**
 * 保留期清理**真的会删行** —— 行为测试，不是读源码文本。
 *
 * ## 为什么需要它
 *
 * 独立审查的记录：「保留期/TTL 的删除任务事实上不执行 —— `purgeOldPositions`
 * 在 `src/lib/scheduler.ts:543`，只在调度器里」。调度器此前从未在生产入口下运行过
 * （`next start` 不加载 `src/server.ts`），所以这段代码**从来没被真正执行过**。
 * Phase 19 把生产入口跑起来后，它在真实库上删掉了 16 行（日志：
 * `[scheduler] purged 16 expired delivery position(s)`），但"跑过一次"不等于
 * "有一条会被回归的测试"。
 *
 * ## 为什么写在一个**隔离命名空间**里
 *
 * `delivery_positions` 只有主键与索引，**没有外键**（见
 * scripts/migrate-delivery-positions.sql），因此可以用一个假的 tenant/business
 * 做探针：真实数据一行都不会被碰到，也不需要构造真实租户。
 * 清理放在 `finally`，失败也不留残留。
 *
 * ## 自带负向对照
 *
 * 三条探针行：两条过期、一条新鲜。**新鲜那条必须活着** ——
 * 如果实现写成"删光这张表"或"忽略 cutoff"，这条会红。
 * 只断言"过期行没了"的实现，在"删得太多"时也会通过。
 */

const PROBE_TENANT = 'phase19-purge-probe-tenant';
const PROBE_BUSINESS = 'phase19-purge-probe-business';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function countProbeRows(): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from('delivery_positions')
    .select('id', { count: 'exact' })
    .eq('tenant_id', PROBE_TENANT)
    .eq('business_id', PROBE_BUSINESS);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function cleanupProbeRows(): Promise<void> {
  await getSupabaseClient()
    .from('delivery_positions')
    .delete()
    .eq('tenant_id', PROBE_TENANT)
    .eq('business_id', PROBE_BUSINESS);
}

describe('保留期清理：过期行真的被删（隔离命名空间 + 新鲜行对照）', () => {
  let reachable = false;

  before(async () => {
    try {
      // 先确认库可达；不可达时本组整组记为 UNVERIFIED（不是通过）
      await countProbeRows();
      reachable = true;
      await cleanupProbeRows(); // 上一轮万一残留，先清干净
    } catch (error) {
      console.log(`  [skip] 数据库不可达：${error instanceof Error ? error.message : String(error)}`
        + ' → 本组 UNVERIFIED（不是通过）');
      reachable = false;
    }
  });

  after(async () => {
    if (reachable) await cleanupProbeRows();
  });

  test('过期行被删、新鲜行保留（默认 24 小时保留期）', async (t) => {
    if (!reachable) {
      console.log('  [skip] 无数据库连接 → UNVERIFIED');
      t.skip('no database');
      return;
    }

    await cleanupProbeRows();

    // 两条过期（30h / 72h，都超过 24h 保留期）、一条新鲜（1h）
    const rows = [
      { tenant_id: PROBE_TENANT, business_id: PROBE_BUSINESS, delivery_id: 'probe-old-72h', staff_id: 'probe-staff', lat: 40.1, lng: -73.1, recorded_at: hoursAgo(72) },
      { tenant_id: PROBE_TENANT, business_id: PROBE_BUSINESS, delivery_id: 'probe-old-30h', staff_id: 'probe-staff', lat: 40.2, lng: -73.2, recorded_at: hoursAgo(30) },
      { tenant_id: PROBE_TENANT, business_id: PROBE_BUSINESS, delivery_id: 'probe-fresh-1h', staff_id: 'probe-staff', lat: 40.3, lng: -73.3, recorded_at: hoursAgo(1) },
    ];
    const ins = await getSupabaseClient().from('delivery_positions').insert(rows);
    assert.equal(ins.error, null, `插入探针行失败：${ins.error?.message}`);
    assert.equal(await countProbeRows(), 3, '前置条件：应有 3 行探针数据');

    // 被测函数：默认保留期 24 小时
    const deleted = await purgeOldPositions(PROBE_TENANT, PROBE_BUSINESS, DEFAULT_POSITION_RETENTION_HOURS);
    assert.equal(deleted, 2, `应当删掉 2 行过期数据，实际返回 ${deleted}`);

    const remaining = await getSupabaseClient()
      .from('delivery_positions')
      .select('delivery_id, recorded_at')
      .eq('tenant_id', PROBE_TENANT)
      .eq('business_id', PROBE_BUSINESS);
    assert.equal(remaining.error, null);
    const ids = (remaining.data ?? []).map((r) => (r as { delivery_id: string }).delivery_id).sort();
    assert.deepEqual(
      ids, ['probe-fresh-1h'],
      '**负向对照**：保留期内的新鲜行必须活着。若它也被删了，说明实现忽略了 cutoff，'
      + `那会把"保留 24 小时"变成"立刻删除"。实际剩下：${JSON.stringify(ids)}`,
    );

    // 再跑一次：没有过期行时应删 0 行（幂等，不误删）
    const second = await purgeOldPositions(PROBE_TENANT, PROBE_BUSINESS, DEFAULT_POSITION_RETENTION_HOURS);
    assert.equal(second, 0, '第二次调用应当删除 0 行');
    assert.equal(await countProbeRows(), 1, '新鲜行在第二次调用后仍应存在');
  });

  test('保留期参数生效：窗口收窄后同一行才会被删', async (t) => {
    if (!reachable) {
      console.log('  [skip] 无数据库连接 → UNVERIFIED');
      t.skip('no database');
      return;
    }

    await cleanupProbeRows();
    // 2 小时前的行。
    //
    // ⚠️ 两次都踩过坑，两次都是**我的测试**写错而不是代码错，如实留在这里：
    //   1. 第一版贴边界测（"正好 1 小时前 + 1 小时窗口"）：cutoff 在调用时才算，
    //      插入与调用之间流过几毫秒，那一行必然"严格早于 cutoff"而被删 ——
    //      断言了一个物理上不成立的前提。
    //   2. 第二版用 0.25 小时窗口：`normalizeRetentionHours` 有
    //      MIN_RETENTION_HOURS = 1 的下限保护，0.25 会被收敛成 1，
    //      所以"收窄到 0.25"根本没生效。
    // 现在两侧都在合法区间内且留足余量：窗口 3h 时它在窗口内，窗口 1h 时它在窗口外。
    const ins = await getSupabaseClient().from('delivery_positions').insert([
      { tenant_id: PROBE_TENANT, business_id: PROBE_BUSINESS, delivery_id: 'probe-two-hours', staff_id: 'probe-staff', lat: 40.4, lng: -73.4, recorded_at: hoursAgo(2) },
    ]);
    assert.equal(ins.error, null, `插入失败：${ins.error?.message}`);

    // 3 小时窗口：2 小时前的行在保留期内，不应被删
    const inWindow = await purgeOldPositions(PROBE_TENANT, PROBE_BUSINESS, 3);
    assert.equal(inWindow, 0, '保留期内的行不应被删');
    assert.equal(await countProbeRows(), 1, '保留期内的行必须还在');

    // 收窄到 1 小时（合法区间内的最小值）：同一行现在过期了，必须被删 ——
    // 证明保留期参数真的参与判定，而不是恒定用默认 24 小时
    const narrower = await purgeOldPositions(PROBE_TENANT, PROBE_BUSINESS, 1);
    assert.equal(narrower, 1, '收窄保留期后同一行应当被删 —— 否则参数没生效');
    assert.equal(await countProbeRows(), 0);
  });

  test('normalizeRetentionHours 对非法输入 fail-safe 到默认值（纯逻辑）', () => {
    assert.equal(normalizeRetentionHours(undefined), DEFAULT_POSITION_RETENTION_HOURS);
    assert.equal(normalizeRetentionHours('nonsense'), DEFAULT_POSITION_RETENTION_HOURS);
    assert.equal(normalizeRetentionHours(-5), DEFAULT_POSITION_RETENTION_HOURS);
    assert.equal(normalizeRetentionHours(0), DEFAULT_POSITION_RETENTION_HOURS);
    // 上限 30 天：避免一个错误的配置把保留期变成"永不删除"
    assert.equal(normalizeRetentionHours(24 * 365), 24 * 30);
    assert.equal(normalizeRetentionHours(6), 6);
  });
});
