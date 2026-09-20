/**
 * 套餐标识与试用期的**单一事实源**。
 *
 * 这些 id 与 `scripts/migrate-subscriptions-seed.sql` 里 `insert` 的值必须一致；
 * `tests/subscription-entitlements.test.ts` 有一条断言把两处钉在一起 ——
 * 迁移改了而这里没改，测试会变红（反之亦然）。
 *
 * 为什么不查库拿 id：注册流程在"刚建完租户"的路径上，任何一次多余查询都是
 * 注册延迟；而且套餐是**平台配置**，不是用户数据，没有理由每次动态解析。
 */
export const PLAN_IDS = {
  free: '00000000-0000-4000-8000-00000000f001',
  starter: '00000000-0000-4000-8000-00000000f002',
  growth: '00000000-0000-4000-8000-00000000f003',
  internal: '00000000-0000-4000-8000-00000000f004',
} as const;

export type PlanSlug = keyof typeof PLAN_IDS;

/** 新注册商家的试用期（天）。到期后门禁降为只读，由平台改状态或离线收款续期。 */
export const TRIAL_DAYS = 14;

/** 新注册商家默认落在哪个套餐（试用期结束前不扣费） */
export const SIGNUP_TRIAL_PLAN: PlanSlug = 'starter';

/** 从"现在"起算的试用到期时刻（ISO 字符串，写进 current_period_end） */
export function trialPeriodEnd(now: Date = new Date(), days: number = TRIAL_DAYS): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
