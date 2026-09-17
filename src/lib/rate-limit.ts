import { NextResponse } from 'next/server';

/**
 * P0-1 集中限流（进程内固定窗口 + 指数退避 + 并发门 + 日配额）。
 *
 * ## 部署契约（Phase 15 起显式化，并被测试守住）
 *
 * 本模块的状态在**进程内存**里：三个 `Map`。因此它只在**单副本**部署下成立。
 *
 * 多副本会怎样（算术推论，非实测）：N 个副本 ⇒ 每个副本各记一份计数 ⇒
 * 注册/登录限流实际放宽 N 倍；每商户聊天并发上限从 4 变成 4N。
 * 这不是"可能有问题"，而是"多开副本就失效"。
 *
 * ## 为什么没有直接换成共享后端
 *
 * 本模块的 API 是**同步**的（`checkFixedWindow` / `acquireSlot` 直接返回结果），
 * 而 Redis 之类的共享后端本质是异步的。替换要改动全部调用点（当前 12 处）
 * 并让它们变成 await —— 那是一次跨模块改造，不是一次依赖替换；
 * 而且本仓库约束"零新增依赖"，进程内实现是当时唯一能落地的选择。
 *
 * 因此这里做的是：**把契约写清楚、可被检测、并在违反时出声**，
 * 而不是假装支持多副本。
 *
 * ## 部署方要做的
 *
 * 单副本：什么都不用做（默认）。
 * 多副本：设置 `ROVEFRAME_RATE_LIMIT_SHARED=1` **仅在你确实接入了共享后端之后**。
 * 若设置了它却没有共享后端，启动时会报错 —— 这个变量是声明，不是开关。
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

export interface RateDecision {
  ok: boolean;
  /** 429 时建议的 Retry-After 秒数（≥1） */
  retryAfterSec: number;
  limit: number;
}

export interface FixedWindowOptions {
  limit: number;
  windowMs: number;
  /** 配置后启用指数退避：连续违规使封锁时长翻倍（base → 2× → 4× …，封顶 maxMs） */
  backoff?: { baseMs: number; maxMs: number };
}

export interface SlotTicket {
  ok: boolean;
  retryAfterSec: number;
  release: () => void;
}

interface WindowState {
  startMs: number;
  count: number;
  windowMs: number;
}

interface BackoffState {
  violations: number;
  blockedUntilMs: number;
}

const windowStore = new Map<string, WindowState>();
const backoffStore = new Map<string, BackoffState>();
const slotStore = new Map<string, number>();

const MAX_TRACKED_KEYS = 20_000;
const PRUNE_INTERVAL_MS = 60_000;
let lastPruneAt = 0;

function pruneIfNeeded(now: number): void {
  if (windowStore.size + backoffStore.size < MAX_TRACKED_KEYS) return;
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  for (const [key, state] of windowStore) {
    if (now - state.startMs > state.windowMs * 2) windowStore.delete(key);
  }
  for (const [key, state] of backoffStore) {
    if (now - state.blockedUntilMs > 2 * 60 * 60_000) backoffStore.delete(key);
  }
}

/**
 * 固定窗口检查：每次调用都计入一次尝试（含被拒绝的尝试），
 * 窗口内计数超过 limit 返回 not-ok；配置 backoff 时，退避期内一律 not-ok。
 */
export function checkFixedWindow(key: string, opts: FixedWindowOptions): RateDecision {
  const now = Date.now();

  if (opts.backoff) {
    const bs = backoffStore.get(key);
    if (bs && now < bs.blockedUntilMs) {
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((bs.blockedUntilMs - now) / 1000)),
        limit: opts.limit,
      };
    }
    // 退避期已过且长时间无新违规 → 自然衰减，防止老记录永久封禁。
    if (bs && now > bs.blockedUntilMs + opts.backoff.baseMs * 2) {
      backoffStore.delete(key);
    }
  }

  const state = windowStore.get(key);
  if (!state || now - state.startMs >= opts.windowMs) {
    windowStore.set(key, { startMs: now, count: 1, windowMs: opts.windowMs });
    pruneIfNeeded(now);
    return { ok: true, retryAfterSec: 0, limit: opts.limit };
  }

  state.count += 1;
  if (state.count > opts.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((state.startMs + opts.windowMs - now) / 1000)),
      limit: opts.limit,
    };
  }
  return { ok: true, retryAfterSec: 0, limit: opts.limit };
}

/** 认证失败时记录违规：指数退避封锁（连续失败 → 封锁时长翻倍）。 */
export function noteFailure(key: string, backoff: { baseMs: number; maxMs: number }): void {
  const now = Date.now();
  const previous = backoffStore.get(key);
  const violations = (previous ? previous.violations : 0) + 1;
  const shift = Math.min(violations - 1, 10);
  const blockMs = Math.min(backoff.baseMs * 2 ** shift, backoff.maxMs);
  backoffStore.set(key, { violations, blockedUntilMs: now + blockMs });
}

/** 认证成功时清除退避记录。 */
export function noteSuccess(key: string): void {
  backoffStore.delete(key);
}

/** 并发门：同 key 最多 max 个并发持有者；release 幂等。 */
export function acquireSlot(key: string, max: number): SlotTicket {
  const current = slotStore.get(key) ?? 0;
  if (current >= max) {
    return { ok: false, retryAfterSec: 10, release: () => undefined };
  }
  slotStore.set(key, current + 1);
  let released = false;
  return {
    ok: true,
    retryAfterSec: 0,
    release: () => {
      if (released) return;
      released = true;
      const count = slotStore.get(key) ?? 0;
      if (count <= 1) slotStore.delete(key);
      else slotStore.set(key, count - 1);
    },
  };
}

/** 客户端 IP（经代理时取 x-forwarded-for 首值）。 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real?.trim()) return real.trim();
  return 'unknown';
}

/** 统一 429 响应：JSON 错误 + Retry-After 头。 */
export function rateLimitResponse(decision: RateDecision): NextResponse {
  const response = NextResponse.json(
    { error: 'too_many_requests', retryAfterSec: decision.retryAfterSec },
    { status: 429 },
  );
  response.headers.set('Retry-After', String(decision.retryAfterSec));
  return response;
}

/** 测试辅助：清空进程内限流状态。 */
export function resetRateLimitStateForTests(): void {
  windowStore.clear();
  backoffStore.clear();
  slotStore.clear();
  lastPruneAt = 0;
}
