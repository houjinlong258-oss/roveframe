/**
 * 外部集成能力表 —— **单一事实源**。
 *
 * ## 为什么需要它（Phase 15）
 *
 * 此前"集成是否可用"这件事在三处各写了一遍，彼此不一致：
 *
 * | 位置 | 它认为的 |
 * |---|---|
 * | `/api/integrations` 的 `connectIntegration` | 保存配置即 `status: 'connected'` |
 * | 设置页的徽章 | `status === 'connected'` ⇒ 显示 "Connected" |
 * | `/api/integrations/[provider]/sync` | 只支持 square，其余返回 400 |
 *
 * 三者叠加的后果：老板为 ERPNext 填好地址与密钥并点"测试连接"，
 * ping 成功 → 徽章变 "Connected" → 页面还显示条目数与"最近同步"时间。
 * 而 **ERPNext 的同步端点根本没有实现**，库存 Tab 显示的是种子/本地数据。
 *
 * 这不是崩溃，是**误导**：老板会据此做采购决策。比报错更危险。
 *
 * ## 现在的不变量
 *
 * 1. 只有 `syncable: true` 的 provider 才可能显示为已连接；
 * 2. 不可同步的 provider 显示"仅连通性已验证"，并说明数据不会同步；
 * 3. `last_sync_at` **只在真的同步过之后**才写入，不再在保存配置时伪造。
 *
 * 三处都从这里读，因此不会再漂移。
 */

/** provider → 是否具备真实的数据同步实现 */
export const INTEGRATION_SYNCABLE: Readonly<Record<string, boolean>> = {
  // 有真实同步编排：orders / products / customers / inventory，带游标与水位持久化
  square: true,
  // 本节其余 provider 均无同步实现；加进来时必须同时实现同步路径，否则把 UI 变成谎言
  erpnext: false,
  shopify: false,
  stripe: false,
  paypal: false,
};

export type IntegrationStatus = 'connected' | 'disconnected' | 'connectivity_only';

export function isSyncable(provider: string): boolean {
  return INTEGRATION_SYNCABLE[provider] === true;
}

/** 该 provider 是否在能力表里有记录（未登记的一律按不可同步处理） */
export function isKnownProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_SYNCABLE, provider);
}

/**
 * 保存配置后应写入的状态。
 *
 * 关键点：**不可同步的 provider 不得写成 `connected`** ——
 * 那正是误导的来源。"仅连通性已验证"是当时唯一为真的说法。
 */
export function statusAfterConnect(provider: string): IntegrationStatus {
  return isSyncable(provider) ? 'connected' : 'connectivity_only';
}

/** 面向用户的说明，供 API 返回给 UI 直接展示（三语文案由调用方决定，这里给结构与英文兜底） */
export function capabilityNotice(provider: string): string | null {
  if (isSyncable(provider)) return null;
  return `Connected for reachability only — data sync is not implemented for ${provider}. `
    + 'Inventory shown for this business comes from local data, not from this system.';
}
