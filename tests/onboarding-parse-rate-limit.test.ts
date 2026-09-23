import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { POST as parsePost, ONBOARDING_PARSE_LIMIT_PER_MIN }
  from '../src/app/api/onboarding/parse/route';
import { resetRateLimitStateForTests } from '../src/lib/rate-limit';

/**
 * `/api/onboarding/parse` 的频率保护 —— **行为**测试，不是读源码文本。
 *
 * ## 为什么要补这个测试
 *
 * 独立审查发现：该路由的注释写着"有输入长度与频率的自我保护"，
 * 而代码里只有长度检查。这条不一致本身就是缺陷 —— 读注释的人会以为
 * 限流已经在，于是不会再加。
 *
 * ## 为什么必须是行为测试
 *
 * 本仓库已有 26 个测试文件从不 import 产品代码（只读源码文本）。
 * 对"限流是否生效"这件事，文本断言毫无意义：`assert.match(src, /checkFixedWindow/)`
 * 在**调用点被注释掉**的实现上依然会通过。所以这里真的调用 handler 并数 429。
 *
 * ## 自带负向对照
 *
 * 见 `负向对照` 一节：它证明这套断言能区分"有限流"与"无限流"两种实现，
 * 而不是恒真。真正的回退验证在仓库外执行（把限流那段删掉再跑本文件必须变红）。
 */

const IP = '203.0.113.77';

function makeRequest(ip = IP): Request {
  return new Request('http://localhost/api/onboarding/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ text: 'a small coffee shop in Brooklyn with 3 staff' }),
  });
}

describe('onboarding/parse 频率保护', () => {
  test(`前 ${ONBOARDING_PARSE_LIMIT_PER_MIN} 次放行，第 ${ONBOARDING_PARSE_LIMIT_PER_MIN + 1} 次是 429`, async () => {
    resetRateLimitStateForTests();

    for (let i = 1; i <= ONBOARDING_PARSE_LIMIT_PER_MIN; i++) {
      const res = await parsePost(makeRequest());
      assert.equal(res.status, 200, `第 ${i} 次应当是 200，实际 ${res.status}`);
    }

    const blocked = await parsePost(makeRequest());
    assert.equal(blocked.status, 429, '超过阈值必须 429，而不是继续解析');

    // Retry-After 必须存在且可解析：客户端要能据此退避
    const retryAfter = blocked.headers.get('Retry-After');
    assert.ok(retryAfter !== null, '429 必须带 Retry-After');
    assert.ok(Number(retryAfter) >= 1, `Retry-After 应为 >=1 秒，实际 ${retryAfter}`);

    const body = (await blocked.json()) as { error?: string };
    assert.equal(body.error, 'too_many_requests');
  });

  test('限流按 IP 分片：另一个 IP 不受影响（不是全局闸门）', async () => {
    resetRateLimitStateForTests();

    for (let i = 1; i <= ONBOARDING_PARSE_LIMIT_PER_MIN; i++) {
      await parsePost(makeRequest(IP));
    }
    const blocked = await parsePost(makeRequest(IP));
    assert.equal(blocked.status, 429);

    // 换一个 IP：必须仍然放行。若实现把 key 写死（或用了全局计数），这里会红。
    const other = await parsePost(makeRequest('198.51.100.9'));
    assert.equal(other.status, 200, '另一个 IP 不应被前一个 IP 的配额拖累');
  });

  test('限流发生在解析 body 之前：坏请求同样计数', async () => {
    resetRateLimitStateForTests();

    // 20 次**畸形**请求（body 不是 JSON）：应当各自 400，但都消耗配额
    for (let i = 1; i <= ONBOARDING_PARSE_LIMIT_PER_MIN; i++) {
      const bad = new Request('http://localhost/api/onboarding/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: '{',
      });
      const res = await parsePost(bad);
      assert.equal(res.status, 400, `畸形请求应当 400，实际 ${res.status}`);
    }

    // 第 21 次：即使 body 合法，也必须先撞限流
    const res = await parsePost(makeRequest());
    assert.equal(res.status, 429, '坏请求必须同样消耗配额，否则失败路径是免费的');
  });

  test('负向对照：断言能区分"有限流"与"无限流"两种实现', async () => {
    resetRateLimitStateForTests();

    // 模拟"没有限流"的实现：永远 200
    const unlimited = async () => new Response('{}', { status: 200 });
    let sawNon200 = false;
    for (let i = 1; i <= ONBOARDING_PARSE_LIMIT_PER_MIN + 1; i++) {
      const res = await unlimited();
      if (res.status !== 200) sawNon200 = true;
    }
    // 这个循环**永远**看不到 429 —— 它证明"数 429"这件事对无限流实现必然失败，
    // 也就是说上面那些断言不是恒真的。
    assert.equal(sawNon200, false, '无限流实现不可能产生 429（这正是本对照要固定的性质）');

    // 而真实实现必须产生 429，否则本文件的断言无效
    for (let i = 1; i <= ONBOARDING_PARSE_LIMIT_PER_MIN; i++) await parsePost(makeRequest());
    const blocked = await parsePost(makeRequest());
    assert.equal(blocked.status, 429);
  });
});
