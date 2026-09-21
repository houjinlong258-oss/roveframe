import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 —— 重名商家必须能注册（slug 唯一的处理）。
 *
 * ## 被修的是什么（实测发现，不是推断）
 *
 * `tenants.slug` 有唯一索引，而 slug 由**店名**推出。于是"第二家叫同样名字的店"
 * 注册直接失败，且返回体把数据库约束名透给顾客：
 *
 *     HTTP 500 {"error":"create tenant failed: duplicate key value violates
 *               unique constraint \"tenants_slug_key\""}
 *
 * 触发路径很平常：跑两次注册验证脚本就行（同一个 `business_name`）。
 * 也就是说这不是边界情况 —— **重名是正常输入**（"四川人家"一个城市可以有好几家）。
 *
 * 正确语义只有一种：slug 是**内部标识**，冲突了就换一个；商家的店名不受影响。
 * 拒绝注册是把平台的实现细节变成用户的错误。
 *
 * ## 守住的三件事
 *
 *   1. 冲突（23505）要重试，而不是直接 500；
 *   2. 重试必须**有界**（不能变成无限循环）；
 *   3. 非 23505 的错误必须立刻返回（fail-closed，不掩盖真实故障）。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('createTenantRow：slug 冲突要重试而不是 500', () => {
  const auth = read('src/lib/auth.ts');

  test('冲突时追加后缀并重试', () => {
    assert.match(auth, /const SLUG_RETRY_LIMIT = \d+/);
    assert.match(auth, /error\?\.code !== '23505'/);
    assert.match(auth, /baseSlug\.slice\(0, 40\)/);
  });

  test('重试次数有界（不能是无限循环）', () => {
    const limit = /const SLUG_RETRY_LIMIT = (\d+)/.exec(auth)?.[1];
    assert.ok(limit, '找不到 SLUG_RETRY_LIMIT');
    const n = Number(limit);
    assert.ok(n >= 2 && n <= 10, `重试次数应在 2..10 之间，实际 ${n}`);
    assert.match(auth, /for \(let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt \+= 1\)/);
  });

  test('用尽重试后返回明确错误（不返回成功）', () => {
    assert.match(auth, /could not allocate a unique tenant slug after/);
  });

  test('非 23505 的错误立刻返回（fail-closed）', () => {
    // 这一条防的是"把所有错误都当冲突、无限重试"——
    // 那会把一个真实的数据库故障变成 4 次静默重试后的模糊错误。
    const body = auth.slice(auth.indexOf('export async function createTenantRow'));
    const guardIndex = body.indexOf("error?.code !== '23505'");
    const continueIndex = body.indexOf('for (let attempt = 0');
    assert.ok(guardIndex > 0, '缺少 23505 判定');
    assert.ok(guardIndex < body.indexOf('could not allocate'), '判定必须在最终返回之前');
    assert.ok(continueIndex >= 0);
  });

  test('负向对照：旧的"一次插入、失败即返回"写法不满足重试契约', () => {
    const legacy = `
      export async function createTenantRow(opts) {
        const slug = slugFromName(opts.name);
        const { data, error } = await client.from('tenants').insert({ name: opts.name, slug }).select('id').single();
        if (error || !data) return { ok: false, error: error?.message ?? 'insert tenants failed' };
        return { ok: true, data: { tenantId: data.id } };
      }`;
    assert.doesNotMatch(legacy, /SLUG_RETRY_LIMIT/);
    assert.doesNotMatch(legacy, /23505/);
    assert.match(auth, /23505/);
  });
});
