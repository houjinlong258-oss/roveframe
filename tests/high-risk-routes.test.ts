import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

/**
 * Phase 15 —— **高危路由的行为测试**（真实调用 handler，不 mock）。
 *
 * ## 为什么写这一批
 *
 * 审计发现：91 个 API 路由文件里，只有 11 个被测试**实际调用**过；
 * 49 个在测试源码里从未出现。未覆盖的恰好包括资金、认证、破坏性操作：
 * `payments/checkout`、`admin/tenants/[id]`、`auth/signup`、`settings/wipe`、
 * `settings/models`。
 *
 * 本轮先覆盖**无需凭据即可判定**的那部分行为 —— 即"handler 在触库之前
 * 自己做的那层校验"。这类断言是真正的行为测试：
 * 删掉校验、改错状态码、放宽长度限制，立刻变红。
 *
 * ## 覆盖范围与**明确的缺口**
 *
 * 覆盖：`/api/auth/signup`、`/api/store/orders` 的入参校验分支。
 * **未覆盖**（需凭据夹具，本轮未做）：这些路由的**鉴权后**行为，
 * 以及 `payments/*`、`admin/*`、`settings/wipe`、`settings/models`。
 * 缺口如实记录，不用"有测试文件了"冒充覆盖。
 */

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/signup — 入参校验（触库之前）', () => {
  test('非法 JSON → 400，且说明是 JSON 问题', async () => {
    const { POST } = await import('../src/app/api/auth/signup/route');
    const res = await POST(jsonRequest('/api/auth/signup', '{not json'));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /invalid JSON/i);
  });

  test('缺字段 → 400，且点名缺哪几个', async () => {
    const { POST } = await import('../src/app/api/auth/signup/route');
    for (const missing of ['email', 'password', 'business_name', 'industry']) {
      const payload: Record<string, string> = {
        email: 'a@example.com',
        password: 'longenough123',
        business_name: 'Test Biz',
        industry: 'restaurant',
      };
      delete payload[missing];
      const res = await POST(jsonRequest('/api/auth/signup', payload));
      assert.equal(res.status, 400, `缺 ${missing} 时应 400`);
      const body = (await res.json()) as { error?: string };
      assert.match(String(body.error), /required/i, `缺 ${missing} 时的报错应说明是必填`);
    }
  });

  test('密码短于 8 位 → 400（只测拒绝侧，不触发建库）', async () => {
    const { POST } = await import('../src/app/api/auth/signup/route');
    const base = { email: 'boundary@example.com', business_name: 'B', industry: 'restaurant' };

    // 边界只测**拒绝**的一侧（7 位）。
    //
    // 为什么不做"恰好 8 位应当通过"的对照：那会真的走完注册，
    // 在真实库里建出一个 tenant + business —— 单元测试不应写业务数据。
    // 7 被拒 + 源码断言 `password.length < 8`（下方）共同确定边界是 <8 而非 <=8，
    // 两者都不产生副作用。
    const seven = await POST(jsonRequest('/api/auth/signup', { ...base, password: 'a'.repeat(7) }));
    assert.equal(seven.status, 400, '7 位密码必须被拒');
    const sevenBody = (await seven.json()) as { error?: string };
    assert.match(String(sevenBody.error), /at least 8/i);
  });

  test('长度边界是 <8 而不是 <=8（源码契约，避免上面测试写虚）', () => {
    // 上一条只证明"7 被拒"。若有人把判断改成 `<= 8`，8 位用户会被误拒而测试仍绿。
    // 这里直接固定比较符，使那种改动立即失败。
    const src = readFileSync(join(process.cwd(), 'src/app/api/auth/signup/route.ts'), 'utf8');
    assert.match(
      src, /password\.length\s*<\s*8/,
      '密码长度判定不再是 `< 8` —— 边界语义已变，请同步更新本测试与产品文档',
    );
    assert.doesNotMatch(
      src, /password\.length\s*<=\s*8/,
      '密码长度判定变成了 `<= 8`，会把 8 位密码误拒',
    );
  });
});

describe('POST /api/store/orders — 公开接口的入参校验（触库之前）', () => {
  test('非法 JSON → 400 Invalid request body', async () => {
    const { POST } = await import('../src/app/api/store/orders/route');
    const res = await POST(jsonRequest('/api/store/orders', '<<not json>>'));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /invalid request body/i);
  });

  test('空对象 → 400 invalid_order，且带字段级 details', async () => {
    const { POST } = await import('../src/app/api/store/orders/route');
    const res = await POST(jsonRequest('/api/store/orders', {}));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; details?: Record<string, unknown> };
    assert.equal(body.error, 'invalid_order');
    assert.ok(body.details && Object.keys(body.details).length > 0,
      '校验失败必须给出字段级 details，否则前端无法提示用户改哪里');
  });

  test('items 为空数组 → 400（不能下空单）', async () => {
    const { POST } = await import('../src/app/api/store/orders/route');
    const res = await POST(jsonRequest('/api/store/orders', { token: 'x', items: [] }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'invalid_order');
  });

  test('items 元素缺 qty → 400（计价必须有数量）', async () => {
    const { POST } = await import('../src/app/api/store/orders/route');
    const res = await POST(jsonRequest('/api/store/orders', {
      token: 'x', items: [{ product_id: 'p1' }],
    }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'invalid_order');
  });
});
