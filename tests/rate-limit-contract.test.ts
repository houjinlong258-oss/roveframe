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
describe('rate-limit deployment contract (Phase 15)', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ROVEFRAME_RATE_LIMIT_SHARED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    else process.env.ROVEFRAME_RATE_LIMIT_SHARED = saved;
  });

  test('默认（未声明共享后端）→ 后端为进程内存，契约成立', async () => {
    delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    const mod = await import('../src/lib/rate-limit');
    assert.equal(mod.rateLimitBackend(), 'process-memory');
    assert.equal(mod.assertRateLimitContract(), null, '单副本是成立的状态，不应报错');
  });

  test('声明了共享后端但实际没有 → 契约不成立，且原因可读', async () => {
    process.env.ROVEFRAME_RATE_LIMIT_SHARED = '1';
    const mod = await import('../src/lib/rate-limit');
    assert.equal(mod.rateLimitBackend(), 'shared');
    const reason = mod.assertRateLimitContract();
    assert.ok(reason, '声明了共享后端却仍是进程内实现时必须报错');
    assert.match(reason, /共享后端|成倍放宽/);
  });

  test('除 "1" 以外的一切取值都不算声明（避免 "true"/"yes" 之类被误读）', async () => {
    const mod = await import('../src/lib/rate-limit');
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
    const mod = await import('../src/lib/rate-limit');
    // 若将来真的接入共享后端，这条会失败，提醒作者同步更新本文件与文档
    delete process.env.ROVEFRAME_RATE_LIMIT_SHARED;
    assert.equal(
      mod.rateLimitBackend(), 'process-memory',
      '限流后端已不再是进程内存 —— 请更新部署文档、ARCHITECTURE.md 与本测试',
    );
  });
});
