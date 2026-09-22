import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import { GET as authorizeHost } from '../src/app/api/site/authorize/route';
import { isHostAuthorizedForCertificate, normalizeHost } from '../src/lib/public-site';

/**
 * 证书签发闸门（Caddy `on_demand_tls.ask`）—— Phase 18 审计补测。
 *
 * ## 为什么这是本仓库最该有测试的 27 行之一
 *
 * 这个路由决定**要不要为本机签一张 Let's Encrypt 证书**。它的失败方向只有两种：
 *
 *   · 过宽 ⇒ 任何把域名解析到本服务器的人，都能让本机替他申请证书。
 *     既是滥用，也会把签发的速率配额耗光，让**真正的商家签不出来**
 *     （Let's Encrypt 的失败限额是按注册域名算的，耗光后当天无法再签）。
 *   · 过窄 ⇒ 商家自带域名打不开 HTTPS。
 *
 * 而在本轮审计之前，`isHostAuthorizedForCertificate` 与 `normalizeHost`
 * 的测试引用数是 **0** —— 也就是说这道闸门只被"读代码"确认过。
 *
 * ## 它必须是 fail-closed
 *
 * 不是"查不到就拒绝"，而是**任何异常、任何解析失败、任何非 active 状态都拒绝**。
 * 因为这里的调用方是 Caddy：它把非 2xx 当作"不要签"，那正是我们想要的结果。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 路由读 `request.nextUrl.searchParams`，那是 **NextRequest 专有**的
 * （原生 Request 上不存在）。第一版传了原生 Request，6 条用例全红在
 * `Cannot read properties of undefined (reading 'searchParams')` ——
 * 看起来像实现有问题，实际是夹具用错了类型。
 */
function authorizeRequest(query: string, hostHeader?: string): NextRequest {
  const headers = new Headers();
  if (hostHeader) headers.set('host', hostHeader);
  return new NextRequest(`http://localhost/api/site/authorize${query}`, { headers });
}

// ---------------------------------------------------------------------------
// 1) normalizeHost：纯函数，安全关键
// ---------------------------------------------------------------------------

describe('normalizeHost —— 归一化与拒绝形状', () => {
  test('去端口、小写、去尾部点', () => {
    assert.equal(normalizeHost('Shop.Example.COM:8443'), 'shop.example.com');
    assert.equal(normalizeHost('shop.example.com.'), 'shop.example.com');
    assert.equal(normalizeHost('  shop.example.com  '), 'shop.example.com');
    assert.equal(normalizeHost('SHOP.EXAMPLE.COM'), 'shop.example.com');
  });

  test('空值与纯空白 ⇒ null（不是空字符串）', () => {
    assert.equal(normalizeHost(''), null);
    assert.equal(normalizeHost('   '), null);
    assert.equal(normalizeHost(null), null);
    assert.equal(normalizeHost(undefined), null);
  });

  test('只允许 [a-z0-9.-]：任何其它字符一律 null', () => {
    for (const bad of [
      'shop example.com',      // 空格
      'shop_example.com',      // 下划线
      'shop/example.com',      // 路径（无端口）
      '<script>alert(1)</script>',
      'café.example.com',      // 非 ASCII
      "shop'--.example.com",
    ]) {
      assert.equal(normalizeHost(bad), null, `${JSON.stringify(bad)} 必须被拒绝`);
    }
  });

  test('带端口时先切端口再判定（所以 "host:port/path" 会拒绝）', () => {
    // 实现是 `.split(':')[0]`，因此 `shop.example.com:80/path` 先变成
    // `shop.example.com`（端口之后的内容一起被切掉）—— 结果是**合法域名**。
    // 第一版把它列进"必须拒绝"，是期望写错，不是实现有问题。
    assert.equal(
      normalizeHost('shop.example.com:80/path'),
      'shop.example.com',
      '端口之后的内容随端口一起被切掉，留下的是合法域名',
    );
    // 而"没有端口但带路径"确实会被字符白名单拒绝（见上一条的 shop/example.com）。
    assert.equal(normalizeHost('shop.example.com/path'), null);
  });

  test('超长（> 253）⇒ null', () => {
    assert.equal(normalizeHost(`${'a'.repeat(254)}.com`), null);
    assert.notEqual(normalizeHost(`${'a'.repeat(200)}.com`), null);
  });

  test('负向对照：同一组正则必须能放行合法域名', () => {
    // 如果上面那条只是"永远返回 null"，这些会变红
    assert.equal(normalizeHost('a-b.example.co.uk'), 'a-b.example.co.uk');
    assert.equal(normalizeHost('xn--bcher-kva.example'), 'xn--bcher-kva.example');
  });
});

// ---------------------------------------------------------------------------
// 2) 路由：真实调用 handler（拒绝方向）
// ---------------------------------------------------------------------------

describe('GET /api/site/authorize —— 拒绝方向（真实 handler 调用）', () => {
  test('没有 domain 也没有 Host ⇒ 404', async () => {
    const res = await authorizeHost(authorizeRequest(''));
    assert.equal(res.status, 404, '没有域名就没有理由签发');
  });

  test('空 domain 参数 ⇒ 404', async () => {
    const res = await authorizeHost(authorizeRequest('?domain='));
    assert.equal(res.status, 404);
  });

  test('未在 public_sites 注册的域名 ⇒ 404', async () => {
    const res = await authorizeHost(
      authorizeRequest('?domain=definitely-not-registered-9f3a.example'),
    );
    assert.equal(res.status, 404, '未注册域名不得触发签发');
  });

  test('非法字符的 domain ⇒ 404（在查库之前就被形状检查挡住）', async () => {
    const res = await authorizeHost(authorizeRequest('?domain=bad_host%20with%20space') );
    assert.equal(res.status, 404);
  });

  test('响应是**空体**：只以状态码回答（Caddy 只关心 2xx/非 2xx）', async () => {
    const res = await authorizeHost(authorizeRequest('?domain=nope.example') );
    assert.equal(await res.text(), '', '不应泄漏任何关于该域名是否存在的细节');
  });

  test('负向对照：拒绝时不得返回 200（否则任何人都能触发签发）', async () => {
    const res = await authorizeHost(authorizeRequest('?domain=nope.example') );
    assert.notEqual(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 3) fail-closed：查库异常必须变成拒绝
// ---------------------------------------------------------------------------

describe('isHostAuthorizedForCertificate —— 异常也必须拒绝', () => {
  test('查库失败 ⇒ false（不是抛出、更不是 true）', async () => {
    // 用一个确定会让 PostgREST 报错的形状：超长域名（列宽 varchar 之外）
    // 仍然应该是 false 而不是异常冒泡。
    const result = await isHostAuthorizedForCertificate(`${'x'.repeat(300)}`);
    assert.equal(result, false);
  });

  test('空 host ⇒ false', async () => {
    assert.equal(await isHostAuthorizedForCertificate(''), false);
  });

  test('负向对照：合法但未注册的域名也必须是 false', async () => {
    assert.equal(await isHostAuthorizedForCertificate('not-registered-4b7c.example'), false);
  });
});

// ---------------------------------------------------------------------------
// 4) 接线契约：路由必须是公开的、且不能放宽
// ---------------------------------------------------------------------------

describe('接线契约', () => {
  test('该路由在公开路径白名单里（Caddy 没有站内会话）', () => {
    const guard = read('src/lib/auth-guard.ts');
    assert.match(guard, /'\/api\/site\/authorize'/);
  });

  test('路由里 catch 之后保持拒绝，而不是改判为允许', () => {
    const route = read('src/app/api/site/authorize/route.ts');
    // 关键形状：catch 里把 allowed 置回 false
    assert.match(route, /catch\s*\{[\s\S]{0,200}?allowed = false;/);
    assert.match(route, /status: allowed \? 200 : 404/);
    // 负向对照：任何"异常时允许"的写法都必须被这条拒绝
    assert.doesNotMatch(route, /catch\s*\{[\s\S]{0,120}?allowed = true;/);
  });

  test('放行条件是三个同时成立（active + enabled + 域名匹配）', () => {
    const lib = read('src/lib/public-site.ts');
    const fn = lib.slice(lib.indexOf('export async function isHostAuthorizedForCertificate'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /\.eq\('custom_domain', normalized\)/);
    assert.match(body, /\.eq\('domain_status', 'active'\)/);
    assert.match(body, /\.eq\('enabled', true\)/);
    // 负向对照：删掉任一条件都应让这条失败
    for (const condition of ["custom_domain", "domain_status", "enabled"]) {
      const mutated = body.replace(new RegExp(`\\.eq\\('${condition}'[^)]*\\)`), '');
      assert.ok(
        !/\.eq\('custom_domain'/.test(mutated)
          || !/\.eq\('domain_status'/.test(mutated)
          || !/\.eq\('enabled'/.test(mutated),
        `删掉 ${condition} 条件后，本断言必须能察觉`,
      );
    }
  });
});
