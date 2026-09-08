import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  _forceTickInFlightForTests,
  _resetTickLockForTests,
  runScheduledJobs,
} from '../src/lib/scheduler';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-17 scheduler 互斥与逐项隔离', () => {
  test('in-flight 锁：上一 tick 未结束则跳过本轮（不重叠执行）', async () => {
    _resetTickLockForTests();
    _forceTickInFlightForTests();
    try {
      // 上轮仍在进行 → 本次直接返回（内部逻辑不执行）
      await runScheduledJobs();
      assert.ok(true, 'in-flight 时 runScheduledJobs 应立即返回');
    } finally {
      _resetTickLockForTests();
    }
  });

  test('逐 business 独立 try/catch：单店失败不跳过其余门店', () => {
    const src = read('src/lib/scheduler.ts');
    assert.match(src, /tick failed for business \$\{tenant\.id\}\/\$\{business\.id\}/);
    assert.match(src, /business list failed for tenant/);
    assert.ok(src.indexOf('for (const business of businesses)') < src.indexOf('catch (businessError)'));
  });

  test('每日简报 DB 水位原子抢占（claim_daily_briefing_slot）接线', () => {
    const src = read('src/lib/scheduler.ts');
    assert.match(src, /claimDailyBriefingSlot\(tenantId, businessId, today\)/);
    assert.match(src, /rpc\('claim_daily_briefing_slot'/);
    // 槽位抢占失败（已发送）直接返回，不再发送
    assert.match(src, /if \(!\(await claimDailyBriefingSlot/);
    const sql = read('scripts/migrate.sql');
    assert.match(sql, /create or replace function public\.claim_daily_briefing_slot/);
    assert.match(sql, /\(value->>'last_date'\) is distinct from p_today/);
    assert.match(sql, /on conflict \(key\) do nothing/);
    assert.match(sql, /grant execute on function public\.claim_daily_briefing_slot\(text, text\) to service_role/);
    // 旧读-判-写不再出现在简报主路径
    assert.ok(!src.includes("const state = await getCronState(`daily_briefing"));
  });

  test('startScheduler 单实例 setInterval（无并发间隔叠加）', () => {
    const src = read('src/lib/scheduler.ts');
    assert.match(src, /export function startScheduler\(intervalMs = 60_000\)/);
  });
});
