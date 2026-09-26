import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * standalone 运行镜像的接线必须完整，且**缺依赖必须让构建失败**。
 *
 * ## 背景（这是记录在案的后续优化项，不是新想法）
 *
 * Dockerfile 原先的注释写着：
 *
 * > The runtime stage keeps the FULL node_modules and .next tree instead of
 * > using Next's `output: 'standalone'` … this image could not be built or
 * > smoke-tested on the authoring machine (the Docker daemon was unavailable).
 * > Shipping the known-complete tree is the honest choice; `output:
 * > 'standalone'` is recorded as a follow-up optimisation rather than an
 * > untested change.
 *
 * 也就是说：**没做这件事的原因是测不了，不是不需要**。本次实现它时同一个阻塞
 * 依然存在（Docker daemon 仍然不可用），所以这里不能靠"应该没问题"，而要把
 * 失败路径显式化 —— 于是有了下面这套断言。
 *
 * ## 为什么单靠 `output: 'standalone'` 会出事
 *
 * 1. standalone 只产出 node_modules 与 server 产物，**不含 `.next/static`**。
 *    漏掉它，页面能出 HTML 但所有 CSS/JS 404。
 * 2. 生产入口必须仍是 `node dist/server.js`（`src/server.ts` 负责
 *    startScheduler / autoMigrate / runBootChecks / 限流契约断言）。
 *    standalone 自带的 `server.js` 会**静默绕过**这些 —— 所以 CMD 不能被改掉。
 * 3. `dist/server.js` 是 **tsup 产物**（npm 依赖 external），它的依赖集合
 *    不在 Next 的追踪图里。实测它有 11 个外部依赖，其中只有 3 个直接出现在
 *    `src/app/**` 下（next 97 处 / coze-coding-dev-sdk 4 处 / nodemailer 1 处），
 *    其余 8 个（pg、drizzle-orm、imapflow、mailparser、web-push、dotenv、
 *    @supabase/supabase-js）经 `src/lib/*` 间接进入 —— **是否能被 nft 追到
 *    无法用静态阅读确定**。所以 Dockerfile 里放了一条构建期断言：它当场从
 *    `dist/server.js` 解析依赖清单并逐个 require.resolve，缺任何一个就让构建失败。
 */

const ROOT = process.cwd();
const DOCKERFILE = join(ROOT, 'Dockerfile');
const ENTRY = join(ROOT, 'dist', 'server.js');

const dockerfile = readFileSync(DOCKERFILE, 'utf8');
const nextConfig = readFileSync(join(ROOT, 'next.config.ts'), 'utf8');

/** 从 CJS 产物里解析出外部（非相对、非内建）依赖，与 Dockerfile 里的断言同源。 */
function externalDeps(entry: string): string[] {
  const src = readFileSync(entry, 'utf8');
  const specs = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  const builtins = createRequire(entry)('node:module').builtinModules as string[];
  return [...new Set(specs)].filter(
    (s) => !/^\./.test(s) && !/^node:/.test(s) && !builtins.includes(s),
  );
}

describe('standalone 运行镜像', () => {
  test('next.config 启用了 standalone 输出', () => {
    assert.match(
      nextConfig,
      /output:\s*'standalone'/,
      'next.config.ts 未启用 output: standalone —— 镜像会退回整包 node_modules',
    );
  });

  test('Dockerfile 从 standalone 树取 node_modules，而不是整包复制', () => {
    assert.match(
      dockerfile,
      /COPY --from=builder \/app\/\.next\/standalone \.\//,
      '未复制 .next/standalone',
    );
    assert.doesNotMatch(
      dockerfile,
      /COPY --from=builder \/app\/node_modules\s+\.\/node_modules/,
      '仍在整包复制 node_modules（本机实测 728 MB）—— standalone 的收益等于 0',
    );
  });

  test('显式补上 standalone 不含的 .next/static 与 public', () => {
    assert.match(
      dockerfile,
      /COPY --from=builder \/app\/\.next\/static\s+\.\/\.next\/static/,
      '未单独复制 .next/static —— 症状是 HTML 能出但静态资源全部 404',
    );
    assert.match(
      dockerfile,
      /COPY --from=builder \/app\/public\s+\.\/public/,
      '未复制 public/',
    );
  });

  test('入口仍是 dist/server.js，没有被换成 standalone 自带的 server.js', () => {
    assert.match(
      dockerfile,
      /CMD \["node", "dist\/server\.js"\]/,
      'CMD 被改动了 —— standalone 自带的 server.js 会绕过 scheduler/migration/boot-check/限流断言',
    );
    assert.ok(
      existsSync(ENTRY),
      `缺少构建产物 ${ENTRY}：先跑 pnpm build（该断言依赖它来推导依赖清单）`,
    );
  });

  test('构建期断言是从产物推导依赖，而不是抄一份会过期的硬编码清单', () => {
    const assertion = dockerfile.match(/RUN node -e "([\s\S]*?)"\n/);
    assert.ok(assertion, 'Dockerfile 里找不到那条构建期断言');
    const js = assertion[1];
    assert.match(js, /dist\/server\.js/, '断言没有读取 dist/server.js');
    assert.match(js, /require\.resolve/, '断言没有真正做解析');
    assert.match(js, /process\.exit\(1\)/, '断言在缺依赖时不会失败 —— 那是静默放行');
    assert.match(js, /builtinModules/, '断言未排除内建模块，会把 fs/path 也当外部依赖');
  });

  test('本地可复核：真实产物的每个外部依赖当下都能解析', () => {
    const deps = externalDeps(ENTRY);
    // 负向对照内建在断言里：正则一旦失效，deps 会变成空数组，这条立刻变红，
    // 从而避免"检查了个寂寞还显示通过"。
    assert.ok(
      deps.length >= 5,
      `只解析出 ${deps.length} 个外部依赖，正则可能已失效（实测应为 11 个）`,
    );
    const anchor = createRequire(ENTRY);
    const missing = deps.filter((d) => {
      try {
        anchor.resolve(d);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(missing, [], `下列外部依赖在本地也解析不到：${missing.join(', ')}`);
  });
});
