/**
 * 订阅与权益门禁 —— **单一事实源**，fail-closed。
 *
 * ## 为什么需要它（Phase 16 任务 2）
 *
 * 实测：`tenant_subscriptions` 表存在、admin 路由能改它，但**没有任何业务代码读它**。
 * 于是欠费、停用、过期的商家仍然全功能可用 —— 平台收不到钱却不停服务。
 *
 * ## 判定表（每一条都有理由，不靠推断）
 *
 * | status | 期内 | 判定 |
 * |---|---|---|
 * | `active` | — | full |
 * | `trialing` | 是 / 无期 | full（无期 = 迁移回填的存量租户，试用不设期限） |
 * | `trialing` | 已过期 | read_only（试用自然到期） |
 * | `past_due` | grace 内 | full（宽限期内不打断营业） |
 * | `past_due` | 宽限已过 / 无宽限 | read_only |
 * | `grace` | grace 内 | full |
 * | `grace` | 已过期 / 无期 | read_only |
 * | `suspended` | — | **suspended**（写操作被拒，读仍可） |
 * | `cancelled` | 期末前 | full（已付费到期末） |
 * | `cancelled` | 期末后 / 无期 | read_only |
 * | `expired` / 未知状态 | — | read_only |
 * | **无订阅行** | — | read_only + `subscription_missing` |
 * | **查库出错** | — | read_only + `lookup_failed`（**fail-closed**） |
 *
 * 关键性质：**不抛错**。任何不确定都降级为 read_only 并把原因写进 `reason`，
 * 于是"为什么这个按钮不能点"在 API 响应里可读，而不是一个没有解释的 500。
 *
 * `read_only` 而非 `blocked` 的理由：商家自己的经营数据不是平台的筹码，
 * 停服不该让老板读不到自己的订单；被限制的是**写**与**对外动作**。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'grace'
  | 'suspended'
  | 'cancelled'
  | 'expired';

export type EntitlementLevel = 'full' | 'read_only' | 'suspended';

export interface EntitlementDecision {
  level: EntitlementLevel;
  status: SubscriptionStatus | 'none';
  /** 机器可读的原因码，供前端与日志使用 */
  reason: string;
  planId: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEnd: string | null;
  /** 写操作是否被允许 */
  writeAllowed: boolean;
  /** 该判定是否来自缓存（可观测性用，不参与判定） */
  cached: boolean;
}

/** 订阅查询缓存 TTL。见下方 forceRefresh 的说明。 */
const CACHE_TTL_MS = 5_000;
const CACHE_MAX = 5_000;

interface CacheEntry { decision: EntitlementDecision; expiresAt: number }
const cache = new Map<string, CacheEntry>();

/** 测试用：清空缓存，避免用例之间互相影响 */
export function _clearEntitlementCache(): void {
  cache.clear();
}

/** 测试用：读取缓存条目数（上限是内存安全属性，需要可观测） */
export function _entitlementCacheSize(): number {
  return cache.size;
}

/**
 * 让某个租户的下一次判定绕过缓存。
 *
 * 平台管理员改了订阅状态之后必须调用它，否则最多 5 秒内商家仍按旧状态放行。
 * 5 秒是一个**刻意的折中**：门禁挂在每个业务请求上，无缓存等于每请求一次跨区查库；
 * 而 5 秒远小于任何人工可见的操作延迟（管理员点完"停用"，商家下一屏就已受限）。
 */
export function invalidateEntitlement(tenantId: string): void {
  cache.delete(tenantId);
}

function readCached(tenantId: string): EntitlementDecision | null {
  const hit = cache.get(tenantId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(tenantId);
    return null;
  }
  return { ...hit.decision, cached: true };
}

function writeCached(tenantId: string, decision: EntitlementDecision): void {
  cache.delete(tenantId);
  cache.set(tenantId, { decision, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function endedAt(value: string | null | undefined, now: number): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t <= now;
}

/** 纯函数判定：不查库、不抛错。查库只负责把行取出来。 */
export function decideEntitlement(
  row: {
    status?: string | null;
    plan_id?: string | null;
    current_period_end?: string | null;
    grace_period_end?: string | null;
    cancelled_at?: string | null;
  } | null,
  now: number = Date.now(),
): EntitlementDecision {
  const base = {
    planId: null as string | null,
    currentPeriodEnd: null as string | null,
    gracePeriodEnd: null as string | null,
    cached: false,
  };

  if (!row) {
    return {
      ...base,
      level: 'read_only',
      status: 'none',
      reason: 'subscription_missing',
      writeAllowed: false,
    };
  }

  const status = (row.status ?? '') as SubscriptionStatus | '';
  const decision = {
    ...base,
    planId: row.plan_id ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    gracePeriodEnd: row.grace_period_end ?? null,
  };

  switch (status) {
    case 'active':
      return { ...decision, level: 'full', status: 'active', reason: 'active', writeAllowed: true };

    case 'trialing':
      // 无期 = 迁移回填的存量租户，试用不设期限；有期则到期即降级
      if (!row.current_period_end || !endedAt(row.current_period_end, now)) {
        return { ...decision, level: 'full', status: 'trialing', reason: 'trialing', writeAllowed: true };
      }
      return {
        ...decision,
        level: 'read_only',
        status: 'expired',
        reason: 'trial_expired',
        writeAllowed: false,
      };

    case 'past_due':
      if (!endedAt(row.grace_period_end, now) && row.grace_period_end) {
        return { ...decision, level: 'full', status: 'past_due', reason: 'past_due_in_grace', writeAllowed: true };
      }
      return {
        ...decision,
        level: 'read_only',
        status: 'past_due',
        reason: 'past_due_grace_over',
        writeAllowed: false,
      };

    case 'grace':
      if (!endedAt(row.grace_period_end, now) && row.grace_period_end) {
        return { ...decision, level: 'full', status: 'grace', reason: 'in_grace', writeAllowed: true };
      }
      return {
        ...decision,
        level: 'read_only',
        status: 'grace',
        reason: 'grace_expired',
        writeAllowed: false,
      };

    case 'suspended':
      // 与 read_only 语义不同：这是平台的明确处置，前端应显示"已停用"而非"到期"
      return {
        ...decision,
        level: 'suspended',
        status: 'suspended',
        reason: 'suspended',
        writeAllowed: false,
      };

    case 'cancelled':
      if (!endedAt(row.current_period_end, now) && row.current_period_end) {
        return { ...decision, level: 'full', status: 'cancelled', reason: 'cancelled_paid_through', writeAllowed: true };
      }
      return {
        ...decision,
        level: 'read_only',
        status: 'cancelled',
        reason: 'cancelled_period_over',
        writeAllowed: false,
      };

    case 'expired':
      return { ...decision, level: 'read_only', status: 'expired', reason: 'expired', writeAllowed: false };

    default:
      // 未知状态一律不放行（新增状态时必须是显式决定，而不是默认可用）
      return {
        ...decision,
        level: 'read_only',
        status: 'expired',
        reason: `unknown_status:${status || 'empty'}`,
        writeAllowed: false,
      };
  }
}

/** 查库 + 判定。查库出错时返回 read_only/lookup_failed（fail-closed，不抛错）。 */
export async function evaluateEntitlement(tenantId: string): Promise<EntitlementDecision> {
  const cached = readCached(tenantId);
  if (cached) return cached;

  let decision: EntitlementDecision;
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('tenant_subscriptions')
      .select('status, plan_id, current_period_end, grace_period_end, cancelled_at')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) {
      decision = {
        level: 'read_only',
        status: 'none',
        reason: `lookup_failed:${error.message}`,
        planId: null,
        currentPeriodEnd: null,
        gracePeriodEnd: null,
        writeAllowed: false,
        cached: false,
      };
    } else {
      decision = decideEntitlement(data as Record<string, string | null> | null);
    }
  } catch (e) {
    decision = {
      level: 'read_only',
      status: 'none',
      reason: `lookup_failed:${e instanceof Error ? e.message : String(e)}`,
      planId: null,
      currentPeriodEnd: null,
      gracePeriodEnd: null,
      writeAllowed: false,
      cached: false,
    };
  }

  writeCached(tenantId, decision);
  return decision;
}

/** 写操作被订阅状态拒绝时抛出。`status` 让 api-helpers 的 errorResponse 保留 402。 */
export class SubscriptionError extends Error {
  readonly status = 402;
  readonly code: string;
  readonly subscriptionStatus: string;

  constructor(decision: EntitlementDecision) {
    super(
      `subscription does not allow this action: ${decision.reason} ` +
      `(status=${decision.status}). Read-only access; contact the platform to renew.`,
    );
    this.code = decision.reason;
    this.subscriptionStatus = decision.status;
  }
}

/** 写方法集合（读方法一律放行 —— 商家必须能读到自己的数据） */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* 门禁覆盖范围（**显式清单**，不是"所有写"）                            */
/* ------------------------------------------------------------------ */

/**
 * 订阅门禁管的是**对外可见 / 要花钱**的动作，不是所有写操作。
 *
 * 为什么不做成"所有写方法都拦" —— 初版就是这样，被实测打回：
 *
 *   1. **会被自己的治理动作卡死**。欠费商家要更新账单资料、运维要改配置、
 *      自愈与定制这类内部动作都不是"平台出售的服务"；拦它们没有商业理由，
 *      还会把"客户想付钱"的路径一起堵上。
 *   2. **拒绝范围远大于商业边界**。实测证据：本仓库既有测试用非 UUID 的
 *      假租户（`tenant_phase8`）调用真实 handler，初版把它们全部变成拒绝
 *      （`tests/phase8-approval-ui.test.ts` 8 例变红）。测试只是暴露者 ——
 *      真正的问题是"拦了什么"没有反映"卖的是什么"。
 *   3. 与任务 7 的口径一致：**对外可见的动作**才需要层层把关；
 *      内部草稿写入有 RBAC 与审计就够。
 *
 * 判定按请求**路径前缀**匹配，因此路由不需要各自接线。
 * 清单完整性由 `tests/subscription-entitlements.test.ts` 的守卫钉住：
 * 新增"对外可见"的路由必须显式登记。
 */
export const ENTITLEMENT_GATED_PREFIXES: readonly string[] = [
  // 钱
  '/api/payments/',
  // 发给顾客的东西
  '/api/marketing/send/',
  '/api/channels/send/',
  '/api/emails/send/',
  // 对外发布出来的内容
  '/api/store/qr-codes/',
  '/api/reviews/reply/',
];

/** 该请求是否落在门禁范围内。读方法永远返回 false。 */
export function isEntitlementGatedRequest(method: string, pathname: string): boolean {
  if (!isWriteMethod(method)) return false;
  return ENTITLEMENT_GATED_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
}

/**
 * 请求级门禁：**仅对清单内的路径** + 写方法 + 订阅不允许 ⇒ 抛 `SubscriptionError`。
 *
 * 只读方法永远放行。返回值是判定结果，供路由在响应里带上状态说明。
 */
export async function assertWriteEntitlement(
  tenantId: string,
  method: string,
  pathname?: string,
): Promise<EntitlementDecision> {
  const decision = await evaluateEntitlement(tenantId);
  // 没有路径信息时（直接调用本函数）按"在范围内"处理：fail-closed。
  const inScope = pathname === undefined
    ? isWriteMethod(method)
    : isEntitlementGatedRequest(method, pathname);
  if (inScope && !decision.writeAllowed) {
    throw new SubscriptionError(decision);
  }
  return decision;
}
