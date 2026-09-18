/**
 * 限流的**部署契约**（Phase 15）。
 *
 * ## 为什么单独一个模块
 *
 * 这些函数需要在 `src/server.ts` 启动时调用，而 `src/lib/rate-limit.ts`
 * 顶部 `import { NextResponse } from 'next/server'`。
 *
 * 把契约检查放进 `rate-limit.ts` 会让 `server.ts` 的依赖图多出一条
 * `→ next/server`，于是 **Next 的请求上下文机器在 bundle 加载期就被求值**。
 * 实测后果：容器启动即崩，`Error: Invariant: AsyncLocalStorage accessed in
 * runtime where it is not available`，crash-loop。
 *
 * 此前 `server.ts` 只 import scheduler / boot-check / migration，
 * 这三个都不碰 `next/server` —— 所以那个错误从未出现过。
 *
 * 因此把"纯逻辑"与"依赖 Next 运行时的逻辑"分开：
 *   · 本模块：零依赖，任何上下文都能加载（启动期安全）；
 *   · `rate-limit.ts`：保留 NextResponse 等 HTTP 相关实现，仅服务端路由用。
 *
 * 这是一条**真实踩过的坑**，不是理论洁癖：改动前请确认 server.ts 的依赖图里
 * 没有 `next/server`。
 */

/** 当前限流状态所在的存储类型 */
export type RateLimitBackend = 'process-memory' | 'shared';

/**
 * 当前的限流后端。
 *
 * 只有真的接入了共享后端才应返回 `'shared'`。
 * 环境变量 `ROVEFRAME_RATE_LIMIT_SHARED=1` 是**部署方的声明**：
 * 声明了却仍是进程内实现时，`assertRateLimitContract()` 会失败。
 */
export function rateLimitBackend(): RateLimitBackend {
  return process.env.ROVEFRAME_RATE_LIMIT_SHARED === '1' ? 'shared' : 'process-memory';
}

/** 本进程内是否已是共享后端（当前实现恒为 false，接入后改为 true） */
function hasSharedBackend(): boolean {
  // 进程内 Map 就是当前唯一实现；接入 Redis 等之后这里改为探测连接。
  return false;
}

/**
 * 校验部署契约。**在启动时调用**（`src/server.ts`）。
 *
 * 返回 null 表示契约成立；返回字符串表示违反，调用方应记录为错误级别。
 * 之所以做成"返回原因"而不是抛错：限流状态不对不应阻止服务启动
 * （那会把一个降级问题升级成不可用），但必须大声说出来。
 */
export function assertRateLimitContract(): string | null {
  const backend = rateLimitBackend();
  if (backend === 'shared' && !hasSharedBackend()) {
    return 'ROVEFRAME_RATE_LIMIT_SHARED=1 已设置，但当前实现仍是进程内 Map。'
      + '该变量是"已接入共享后端"的声明，不是开关 —— 现在多副本下限流会成倍放宽。'
      + '要么接入共享后端，要么去掉这个变量。';
  }
  return null;
}
