import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 15 —— 限流的**部署契约**守卫。
 *
 * ## 背景
 *
 * `src/lib/rate-limit.ts` 的状态在进程内存（三个 Map）。因此它只在**单副本**
 * 下成立。多副本的后果是算术推论：N 个副本 ⇒ 注册/登录限流放宽 N 倍，
 * 每商户聊天并发上限从 4 变成 4N。
 *
 * 没有直接换共享后端的原因：本模块 API 是**同步**的，而共享后端本质异步；
 * 替换要改动全部 12 处调用点并让它们 await，是一次跨模块改造，
 * 且受"零新增依赖"约束。
 *
 * 所以这里守的是"契约必须被声明且可检测"，而不是假装支持多副本：
 *   · 默认单副本 → 放行，但启动时打印告警；
 *   · 声明已接入共享后端而实际没有 → 启动时报错级别。
 */
/**
 * 去掉注释，避免"注释里解释了某个导入"被误判成"真的导入了它"。
 *
 * 这不是洁癖：本仓库大量注释在解释坑本身（包括 server.ts 与本文件），
 * 第一版守卫正是被自己的注释触发假阳性。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
describe('rate-limit deployment contract (Phase 15)', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ROVEFRAME_RATE_LIMIT_SHARED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    else process.env.ROVEFRAME_RATE_LIMIT_SHARED = saved;
  });

  test('默认（未声明共享后端）→ 后端为进程内存，契约成立', async () => {
    delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    const mod = await import('../src/lib/rate-limit-contract');
    assert.equal(mod.rateLimitBackend(), 'process-memory');
    assert.equal(mod.assertRateLimitContract(), null, '单副本是成立的状态，不应报错');
  });

  test('声明了共享后端但实际没有 → 契约不成立，且原因可读', async () => {
    process.env.ROVEFRAME_RATE_LIMIT_SHARED = '1';
    const mod = await import('../src/lib/rate-limit-contract');
    assert.equal(mod.rateLimitBackend(), 'shared');
    const reason = mod.assertRateLimitContract();
    assert.ok(reason, '声明了共享后端却仍是进程内实现时必须报错');
    assert.match(reason, /共享后端|成倍放宽/);
  });

  test('除 "1" 以外的一切取值都不算声明（避免 "true"/"yes" 之类被误读）', async () => {
    const mod = await import('../src/lib/rate-limit-contract');
    for (const v of ['true', 'yes', 'on', '0', '']) {
      process.env.ROVEFRAME_RATE_LIMIT_SHARED = v;
      assert.equal(
        mod.rateLimitBackend(), 'process-memory',
        `ROVEFRAME_RATE_LIMIT_SHARED=${JSON.stringify(v)} 不应被当作"已接入共享后端"`,
      );
      assert.equal(mod.assertRateLimitContract(), null);
    }
  });

  test('server.ts 在启动时检查该契约（否则声明形同虚设）', () => {
    const src = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
    assert.match(
      src, /assertRateLimitContract\(\)/,
      'server.ts 没有调用 assertRateLimitContract —— 部署契约不会被检测，'
      + '多副本部署会静默地把限流放宽 N 倍',
    );
    assert.match(
      src, /process-memory/,
      'server.ts 未对"进程内限流 = 必须单副本"给出告警',
    );
  });

  test('文档化的契约与实现一致（内存实现不得自称 shared）', async () => {
    const mod = await import('../src/lib/rate-limit-contract');
    // 若将来真的接入共享后端，这条会失败，提醒作者同步更新本文件与文档
    delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    assert.equal(
      mod.rateLimitBackend(), 'process-memory',
      '限流后端已不再是进程内存 —— 请更新部署文档、ARCHITECTURE.md 与本测试',
    );
  });

  /**
   * 这条守的是一个**真实踩过的坑**，不是理论洁癖。
   *
   * 把契约检查放进 `rate-limit.ts` 后，`src/server.ts` 的依赖图多出
   * `→ next/server`，于是 Next 的请求上下文机器在 bundle 加载期被求值，
   * 容器启动即崩、crash-loop：
   *
   *   Error: Invariant: AsyncLocalStorage accessed in runtime where it is not available
   *
   * 镜像构建是**通过**的（`next build` 与 `tsc` 都不报错），
   * 只有真跑起来才会暴露 —— 所以必须有一条静态守卫在这里。
   */
  test('server.ts 的依赖图不得包含 next/server（否则容器启动即崩）', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const root = process.cwd();
    const readSrc = (rel: string) => stripComments(readFileSync(join(root, rel), 'utf8'));

    /**
     * 解析 `@/lib/x` 或 `./x` 形式的相对导入，返回仓库相对路径。
     *
     * ⚠️ `@/*` 映射到 `./src/*`（见 tsconfig.json 的 paths）。
     * 第一版漏了这一步，把 `@/lib/rate-limit-contract` 当成仓库根的
     * `lib/rate-limit-contract` 去找，结果**只有入口文件被检查**、
     * 整个依赖图从未被遍历 —— 那个守卫当时不具备检测能力。
     * 是负向对照（把正确的 import 换回会崩的那个）把它暴露出来的。
     */
    const resolveLocal = (spec: string, fromDir: string): string | null => {
      const base = spec.startsWith('@/')
        ? join('src', spec.slice(2))
        : spec.startsWith('.')
          ? join(fromDir, spec)
          : null;
      if (base === null) return null;
      const normalized = base.replace(/\\/g, '/').replace(/^\.\//, '');
      for (const candidate of [`${normalized}.ts`, `${normalized}/index.ts`]) {
        if (existsSync(join(root, candidate))) return candidate;
      }
      return null;
    };

    // 从 server.ts 出发做 BFS，只跟本地导入
    const seen = new Set<string>();
    const queue: string[] = ['src/server.ts'];
    const offenders: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);

      const src = readSrc(file);
      if (/from\s+['"]next\/server['"]/.test(src)) offenders.push(file);

      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const target = resolveLocal(m[1], dir);
        if (target && !seen.has(target)) queue.push(target);
      }
    }

    assert.deepEqual(
      offenders, [],
      'src/server.ts 的依赖图里出现了 next/server：\n  ' + offenders.join('\n  ')
      + '\n\n这会加载 Next 的请求上下文机器，导致容器启动即崩'
      + '（Invariant: AsyncLocalStorage accessed in runtime where it is not available）。'
      + '\n启动期需要的纯逻辑请放到无依赖模块（如 src/lib/rate-limit-contract.ts）。',
    );
  });

  test('守卫本身有效：能识别真实的 next/server 导入，且不被注释误报（阳性对照）', () => {
    // 不能失败的守卫毫无价值。这里用一个**确实**从 next/server 导入的模块
    // （rate-limit.ts 是 HTTP 层）验证检测逻辑，并验证注释不会造成误报 ——
    // 第一版守卫正是因为匹配到注释里的示例文本而假阳性。
    const withImport = stripComments(
      readFileSync(join(process.cwd(), 'src/lib/rate-limit.ts'), 'utf8'),
    );
    assert.match(
      withImport, /from\s+['"]next\/server['"]/,
      'rate-limit.ts 应当从 next/server 导入（它是 HTTP 层）；若已不再如此，请更新本对照',
    );

    // 纯契约模块的注释里**故意**引用了 `from 'next/server'` 作为反例，
    // 去掉注释后必须不再匹配 —— 这一步同时验证了 stripComments 有效。
    const contractRaw = readFileSync(join(process.cwd(), 'src/lib/rate-limit-contract.ts'), 'utf8');
    assert.match(contractRaw, /next\/server/, '对照前提失效：该文件注释里已不再提及 next/server');
    assert.doesNotMatch(
      stripComments(contractRaw), /from\s+['"]next\//,
      '去掉注释后仍匹配 —— 说明该模块真的引入了 next/*，或 stripComments 失效',
    );
  });

  test('纯契约模块自身不引入 next/server（保证启动期可安全加载）', () => {
    const src = stripComments(
      readFileSync(join(process.cwd(), 'src/lib/rate-limit-contract.ts'), 'utf8'),
    );
    assert.doesNotMatch(
      src, /from\s+['"]next\//,
      'rate-limit-contract.ts 引入了 next/* —— 它存在的全部意义就是零依赖、启动期可加载',
    );
  });
});
