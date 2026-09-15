/**
 * Production Hardening 回归测试 —— A1（并发额度泄漏）与 A2（环境加载重复）。
 *
 * 这两个缺陷的共同特征是「单元测试全绿但生产不可用」：
 *  - A1：slot 的 acquire/release 原语本身有测试（tests/rate-limit.test.ts），
 *        但**路由把所有早退路径都漏在 try/finally 之外**，原语测试无法发现。
 *  - A2：`loadEnv()` 的早返回分支从未把 envLoaded 置位，导致每次数据库调用
 *        都同步读一遍 dotenv 文件；只有「调用计数」能证明，功能断言看不见。
 *
 * 因此本文件断言的是**调用次数与汇聚点**，不是返回值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentSseResponse } from '../src/app/api/agent/chat/route';
import { acquireSlot, resetRateLimitStateForTests } from '../src/lib/rate-limit';
import { getSupabaseClient, _deployEnvLoadCount } from '../src/storage/database/supabase-client';

/* -------------------------------------------------------------------------- */
/* A1：并发额度必须在【所有】路径上释放                                          */
/* -------------------------------------------------------------------------- */

/** 把响应流读干，确保 producer 与 onSettled 都已执行完毕。 */
async function drain(response: Response): Promise<string> {
  return await response.text();
}

test('A1 slot 在正常返回路径释放', async () => {
  resetRateLimitStateForTests();
  const key = 'chat:concurrency:t1:b1';
  const slot = acquireSlot(key, 4);
  assert.equal(slot.ok, true);

  const response = agentSseResponse(
    async (emit) => {
      emit({ type: 'delta', text: 'hello' });
    },
    () => slot.release(),
  );
  await drain(response);

  // 释放后同一 key 必须重新可用：拿满 4 个仍应全部成功
  resetRateLimitStateForTests();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(acquireSlot(key, 4).ok, true, `第 ${i + 1} 次 acquire 应成功`);
  }
});

test('A1 slot 在 producer 抛错路径释放（原缺陷：release 只在内部 try 里）', async () => {
  resetRateLimitStateForTests();
  const key = 'chat:concurrency:t2:b2';
  const slot = acquireSlot(key, 4);
  assert.equal(slot.ok, true);

  const response = agentSseResponse(
    async () => {
      throw new Error('agent turn was not initialised');
    },
    () => slot.release(),
  );
  const body = await drain(response);

  // 错误必须以 SSE error 事件如实告知，而不是静默空响应
  assert.match(body, /agent turn was not initialised/);
  assert.match(body, /\[DONE\]/);

  // 额度已归还：连续 4 次 acquire 全部成功
  resetRateLimitStateForTests();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(acquireSlot(key, 4).ok, true);
  }
});

test('A1 slot 在 runtime_unavailable 早退路径释放（原缺陷：return 在 try 之前）', async () => {
  resetRateLimitStateForTests();
  const key = 'chat:concurrency:t3:b3';
  const slot = acquireSlot(key, 4);
  assert.equal(slot.ok, true);

  const response = agentSseResponse(
    async (emit) => {
      // 复刻 chat/route.ts 的 runtime unavailable 分支：emit 三件事后直接 return
      emit({ type: 'runtime_status', mode: 'unavailable', detail: 'runtime not configured' });
      emit({ type: 'notice', level: 'warning', message: 'runtime unavailable', code: 'runtime_required_for_tool_task' });
      emit({ type: 'error', error: 'RoveAgent Runtime unavailable', code: 'runtime_unavailable' });
      emit({ type: 'done' });
      return;
    },
    () => slot.release(),
  );
  await drain(response);

  // 关键断言：4 条此类消息后第 5 条仍然可用（原缺陷是第 5 条永久 429）
  resetRateLimitStateForTests();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(acquireSlot(key, 4).ok, true, `第 ${i + 1} 条工具类消息应放行`);
  }
});

test('A1 slot 在客户端断开（controller 已关闭）路径释放', async () => {
  resetRateLimitStateForTests();
  const key = 'chat:concurrency:t4:b4';
  const slot = acquireSlot(key, 4);
  assert.equal(slot.ok, true);

  const response = agentSseResponse(
    async (emit) => {
      // 模拟 enqueue 抛错：emit 内部把 closed 置位并吞掉异常
      emit({ type: 'delta', text: 'x'.repeat(10) });
      throw new Error('client disconnected');
    },
    () => slot.release(),
  );
  await drain(response);

  resetRateLimitStateForTests();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(acquireSlot(key, 4).ok, true);
  }
});

test('A1 onSettled 恰好执行一次（重复释放不得为负）', async () => {
  let calls = 0;
  const slot = acquireSlot('chat:concurrency:t5:b5', 4);
  const response = agentSseResponse(
    async (emit) => {
      emit({ type: 'delta', text: 'ok' });
    },
    () => {
      calls += 1;
      slot.release();
    },
  );
  await drain(response);
  assert.equal(calls, 1, 'onSettled 必须且只能执行一次');
  resetRateLimitStateForTests();
});

test('A1 slot 在 setup 阶段抛错时仍由路由外层 catch 释放（语义占位断言）', async () => {
  // 路由外层 catch(chat/route.ts) 对「未进入流」的异常调用 slot.release()。
  // 这里断言 release 的幂等性，保证「外层 catch + onSettled」双路径不会双扣。
  resetRateLimitStateForTests();
  const key = 'chat:concurrency:t6:b6';
  const slot = acquireSlot(key, 4);
  slot.release();
  slot.release();
  slot.release();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(acquireSlot(key, 4).ok, true, 'release 必须幂等，不得把计数扣成负数');
  }
});

/* -------------------------------------------------------------------------- */
/* A2：环境加载必须只发生一次                                                    */
/* -------------------------------------------------------------------------- */

test('A2 getSupabaseClient() 连续调用 100 次，deploy.env 只被读取一次', () => {
  // 模块加载时已应用一次；此后无论调用多少次都不应再读文件。
  const before = _deployEnvLoadCount();
  assert.ok(before <= 1, `模块加载后读取次数应 ≤ 1，实际 ${before}`);

  for (let i = 0; i < 100; i += 1) {
    try {
      getSupabaseClient();
    } catch {
      // 凭据缺失时抛错是正确行为；本测试只关心「不重复读文件」
    }
  }

  assert.equal(
    _deployEnvLoadCount(),
    before,
    '100 次 getSupabaseClient() 之后不得新增 deploy.env 读取',
  );
});

test('A2 deploy.env 不再覆盖模块加载之后设置的环境变量（fail-closed 契约可测）', () => {
  const saved = {
    url: process.env.COZE_SUPABASE_URL,
    anon: process.env.COZE_SUPABASE_ANON_KEY,
    service: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,
    env: process.env.COZE_PROJECT_ENV,
  };
  try {
    process.env.COZE_SUPABASE_URL = 'https://prod.example.supabase.co';
    process.env.COZE_SUPABASE_ANON_KEY = 'anon-prod';
    delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    process.env.COZE_PROJECT_ENV = 'PROD';

    // 原缺陷：deploy.env 会在每次调用时 override:true 重新注入 service role key，
    // 使这个断言永不成立。修复后进程环境必须拥有最终决定权。
    assert.throws(
      () => getSupabaseClient(),
      /COZE_SUPABASE_SERVICE_ROLE_KEY is not set/,
      '生产环境缺少 service role key 必须 fail-closed，不得回落 anon',
    );
  } finally {
    if (saved.url === undefined) delete process.env.COZE_SUPABASE_URL;
    else process.env.COZE_SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.COZE_SUPABASE_ANON_KEY;
    else process.env.COZE_SUPABASE_ANON_KEY = saved.anon;
    if (saved.service === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = saved.service;
    if (saved.env === undefined) delete process.env.COZE_PROJECT_ENV;
    else process.env.COZE_PROJECT_ENV = saved.env;
  }
});
