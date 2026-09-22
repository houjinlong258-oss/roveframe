import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { GET as adminOverview } from '../src/app/api/admin/overview/route';

/**
 * 平台管理面（`/api/admin/*`）的授权一致性 —— Phase 18 审计补测。
 *
 * ## 为什么需要它
 *
 * 审计实测：`/api/admin/*` 下 9 个路由文件里 8 个用 `adminHandler`，
 * 1 个例外（`admin/auth` 是**登录入口**，不能用它自己的守卫）。
 *
 * 而 `proxy.ts` 对 `/api/admin/*` **整体跳过**边界检查，全部依赖路由内
 * `requirePlatformAdmin`（Phase 15 §3.6 记为"只有一层"）。也就是说：
 * **任何一个新加的 admin 路由只要忘了包 `adminHandler`，它就是完全开放的。**
 * 那不是"少了一层防御"，是零层。
 *
 * 这类缺口靠人盯不出来（新路由是独立文件），因此用结构守卫钉住：
 * 凡是在 `admin/` 下**导出写方法**的路由，必须走 `adminHandler` 或在白名单里。
 *
 * ## 白名单只有一条，且要求它自带守卫
 *
 * `admin/auth` 是登录/登出/会话查询：它必须能在没有管理员会话时被调用，
 * 否则谁都登不进去。因此它不能包 `adminHandler` —— 但它的 verify 断言
 * **自己解析会话并显式拒绝**，而不是"什么都没做"。
 */

const ROOT = process.cwd();
const ADMIN_DIR = join(ROOT, 'src', 'app', 'api', 'admin');

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const WRITE_METHODS: readonly WriteMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** 登录边界：唯一允许不用 adminHandler 的地方。 */
const EXCEPTIONS: Readonly<Record<string, { reason: string; verify: (src: string) => boolean }>> = {
  'auth/route.ts': {
    reason: 'platform-admin login/logout/session boundary — it runs BEFORE an admin session exists',
    verify: (src) => src.includes('loginPlatformAdmin')
      && src.includes('logoutPlatformAdmin')
      && src.includes('writePlatformAudit'),
  },
};

function adminRouteFiles(dir = ADMIN_DIR, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) adminRouteFiles(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

function exportedWriteMethods(src: string): WriteMethod[] {
  const found: WriteMethod[] = [];
  for (const m of src.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    const method = m[1] as WriteMethod;
    if (WRITE_METHODS.includes(method)) found.push(method);
  }
  return found;
}

describe('平台管理面：写方法必须走 adminHandler', () => {
  const files = adminRouteFiles();

  test('至少扫到 8 个 admin 路由（防止 glob 写错导致空扫描）', () => {
    assert.ok(files.length >= 8, `只扫到 ${files.length} 个 admin 路由，扫描逻辑可能有问题`);
  });

  test('每个导出写方法的 admin 路由都包了 adminHandler，或在白名单里', () => {
    const uncovered: string[] = [];
    for (const abs of files) {
      const rel = relative(ADMIN_DIR, abs).replace(/\\/g, '/');
      const src = readFileSync(abs, 'utf8');
      const methods = exportedWriteMethods(src);
      if (methods.length === 0) continue;
      if (src.includes('adminHandler(')) continue;
      const exception = EXCEPTIONS[rel];
      if (exception && exception.verify(src)) continue;
      uncovered.push(`${rel} [${methods.join(',')}]`);
    }
    assert.deepEqual(
      uncovered, [],
      '这些 admin 路由导出了写方法，却既没包 adminHandler、也不在白名单里。\n'
      + 'proxy.ts 对 /api/admin/* 整体跳过边界检查 ⇒ 它们**完全没有授权**：\n  '
      + uncovered.join('\n  '),
    );
  });

  test('adminHandler 本身做了三件事（守卫 / 状态映射 / 审计）', () => {
    const src = readFileSync(join(ROOT, 'src', 'lib', 'admin-api.ts'), 'utf8');
    assert.match(src, /await requirePlatformAdmin\(request, options\.roles\)/);
    assert.match(src, /PlatformAuthError[\s\S]{0,200}?status: 401/);
    assert.match(src, /PlatformForbiddenError[\s\S]{0,200}?status: 403/);
    assert.match(src, /await writePlatformAudit\(/);
    // 负向对照：把守卫那一行删掉，第一条断言必须失败
    const withoutGuard = src.replace(/await requirePlatformAdmin\(request, options\.roles\)/, '');
    assert.doesNotMatch(withoutGuard, /await requirePlatformAdmin\(request, options\.roles\)/);
  });

  test('白名单里的例外确实自带守卫（不是"什么都没做"）', () => {
    for (const [rel, exception] of Object.entries(EXCEPTIONS)) {
      const src = readFileSync(join(ADMIN_DIR, rel), 'utf8');
      assert.ok(
        exception.verify(src),
        `${rel} 的例外条件不成立 —— 它既没走 adminHandler，也没自己做守卫`,
      );
    }
  });

  test('白名单没有腐烂（每条都对应真实存在的文件）', () => {
    for (const rel of Object.keys(EXCEPTIONS)) {
      const exists = files.some((f) => relative(ADMIN_DIR, f).replace(/\\/g, '/') === rel);
      assert.ok(exists, `EXCEPTIONS 里的 ${rel} 已不存在 —— 白名单必须随代码一起清理`);
    }
  });
});

describe('未认证的管理面请求必须被拒（真实 handler 调用）', () => {
  test('/api/admin/overview 无管理员会话 ⇒ 401', async () => {
    const res = await adminOverview(new Request('http://localhost/api/admin/overview'));
    assert.equal(res.status, 401, '未认证访问平台管理面必须 401，而不是返回数据');
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok('error' in body);
    // 不得泄漏任何业务数据字段
    for (const field of ['tenants', 'businesses', 'usage', 'revenue']) {
      assert.equal(field in body, false, `401 响应不该含 ${field}`);
    }
  });

  test('负向对照：伪造的管理员 cookie 同样 401（不是 500）', async () => {
    const res = await adminOverview(new Request('http://localhost/api/admin/overview', {
      headers: { cookie: 'rf_admin_session=forged' },
    }));
    assert.equal(res.status, 401);
  });
});
