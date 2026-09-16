/**
 * Phase 12 / P1-7 — 按 provider 的熔断器。
 *
 * ## 为什么需要
 *
 * 在它之前，一个已经宕机的 provider 会让**每一个**请求都付满重试预算
 * （`maxRetries` 次、指数退避），然后才轮到 failover 换下一条路。代价是
 * 「故障 provider 的延迟 × 全部并发请求数」，并且在故障期间持续向对方
 * 施压 —— 这正是把短暂故障放大成雪崩的经典模式。
 *
 * 熔断器让系统在连续失败后**快速失败**，把请求立刻交给 failover 链，
 * 冷却期后再放一个探针请求确认恢复。
 *
 * ## 状态机
 *
 * ```
 *   CLOSED ──连续失败 ≥ threshold──▶ OPEN
 *     ▲                               │
 *     │                               │ 冷却 cooldownMs
 *     │                          HALF_OPEN（只放 1 个探针）
 *     │                               │
 *     └──────────探针成功─────────────┘
 *                 探针失败 ──▶ OPEN（重新计时）
 * ```
 *
 * ## 刻意保守的默认值
 *
 * `threshold = 5`、`cooldownMs = 30s`。熔断器本身是一种「宁可拒绝也不排队」
 * 的取舍：阈值太低会把偶发抖动升级成整条链路不可用，因此这里偏保守，
 * 且**只对可重试类失败计数**（401/403 这类配置错误不会让 provider 熔断）。
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerSnapshot {
  key: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  /** 距下一次允许试探的毫秒数；非 open 状态为 0。 */
  retryAfterMs: number;
}

export interface CircuitBreakerOptions {
  /** 连续失败多少次后熔断。 */
  failureThreshold?: number;
  /** 熔断后多久放探针（毫秒）。 */
  cooldownMs?: number;
  /** 可注入时钟，供测试确定性推进。 */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

interface Entry {
  consecutiveFailures: number;
  openedAt: number | null;
  /** 是否已有一个进行中的半开探针（防止冷却期结束时并发涌入全部放行）。 */
  probing: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 当前是否允许发起一次调用。
   *
   * 返回 `retryAfterMs > 0` 表示熔断中 —— 调用方应当**快速失败**并把请求
   * 交给 failover 链，而不是在这里等待。
   */
  canAttempt(key: string): { allowed: boolean; retryAfterMs: number } {
    const entry = this.entries.get(key);
    if (!entry || entry.openedAt === null) {
      if (entry) entry.probing = false;
      return { allowed: true, retryAfterMs: 0 };
    }

    const elapsed = this.now() - entry.openedAt;
    if (elapsed < this.cooldownMs) {
      return { allowed: false, retryAfterMs: this.cooldownMs - elapsed };
    }

    // 冷却已过：只放一个探针，其余继续快速失败，避免恢复瞬间的惊群。
    if (entry.probing) {
      return { allowed: false, retryAfterMs: 0 };
    }
    entry.probing = true;
    return { allowed: true, retryAfterMs: 0 };
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? {
      consecutiveFailures: 0,
      openedAt: null,
      probing: false,
    };
    entry.consecutiveFailures += 1;
    entry.probing = false;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.openedAt = this.now();
    }
    this.entries.set(key, entry);
  }

  isOpen(key: string): boolean {
    return !this.canAttempt(key).allowed;
  }

  snapshot(key: string): BreakerSnapshot {
    const entry = this.entries.get(key);
    const { retryAfterMs } = this.canAttempt(key);
    const state: BreakerState = !entry || entry.openedAt === null
      ? 'closed'
      : retryAfterMs > 0
        ? 'open'
        : 'half_open';
    return {
      key,
      state,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
      openedAt: entry?.openedAt ?? null,
      retryAfterMs,
    };
  }

  /** 测试/运维用：清空全部状态。 */
  reset(): void {
    this.entries.clear();
  }
}

/**
 * 进程级共享熔断器。
 *
 * 单实例部署下这已经足够；多实例部署时每个实例各自熔断，效果是"每实例
 * 独立退避"，仍然远好于全量重试。跨实例共享需要外部存储（Redis），
 * 那属于架构变更，不在此处引入。
 *
 * ## 已知限制：模块实例不保证唯一
 *
 * Next.js 的 middleware / proxy / 各 route / instrumentation 可能各自持有
 * 独立的模块实例（本仓库 AGENTS.md 已记录该现象）。因此上面的"进程级共享"
 * 在 Next.js 下应理解为"模块实例级共享"：不同路由可能各自维护一份熔断状态。
 *
 * 这是**有意的降级**：它只是让熔断生效得慢一些（每个实例各自学一遍），
 * 不会让任何请求绕过熔断 —— 每个实例对每个 provider 仍然会独立熔断。
 * 真正的跨实例共享需要一个外部计数器，属于架构变更。
 */
export const providerBreaker = new CircuitBreaker();
