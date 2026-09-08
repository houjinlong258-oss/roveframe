/**
 * Phase 5 — AI Customization Engine（NL 定制引擎 v2）
 *
 * 设计原则（遵循目标简报）：Template + Component + AI Configuration，
 * 不随机生成项目代码。
 *
 * 双通道意图识别：
 *   1. AI 通道：LLM 从模板目录中选择模板并抽取参数（严格 JSON 输出，
 *      参数按 paramSpec 强制收敛/夹取）；
 *   2. 降级通道：AI 不可用或输出非法时回退关键词匹配（v1 行为，
 *      同步方法 parseAndApplyNLIntent 保持不变，既有测试兼容）。
 *
 * 安全：所有模板输出的是配置与 Workflow 定义，不产生任意代码；
 * 应用入口统一走 updateActiveCustomization。
 */

import { updateActiveCustomization, TenantCustomizationBundle } from '../../custom/loader';
import { pluginRegistry } from '../plugins/registry';
import { PluginPermission } from '../plugins/types';
import { invokeChat, PLATFORM_AI_SCOPE } from '../ai/router';

// ---------------------------------------------------------------------------
// 模板参数规格：AI 抽取的参数按键名收敛，数值夹取到 [min,max]
// ---------------------------------------------------------------------------

export interface ParamSpec {
  key: string;
  type: 'number' | 'boolean' | 'string';
  min?: number;
  max?: number;
  default: unknown;
  description: string;
}

export interface CustomizationTemplate {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  components: string[];
  defaultConfig: Record<string, unknown>;
  paramSpec: ParamSpec[];
  requiredPermissions: string[];
  applyToCustomization: (config: Record<string, unknown>) => Partial<TenantCustomizationBundle>;
}

// ---------------------------------------------------------------------------
// 模板目录（10 个）
// ---------------------------------------------------------------------------

const BASE_RULES = {
  inventoryLowStockThreshold: 10,
  revenueDropAlertPercent: 20,
  reviewWinBackHours: 24,
};

function wf(
  id: string,
  name: string,
  description: string,
  triggerEvent: string,
  actionType: string,
  config: Record<string, unknown>
) {
  return {
    id,
    name,
    description,
    triggerEvent,
    steps: [
      {
        id: `${id}_step_1`,
        name: description.slice(0, 40),
        actionType,
        enabled: true,
        config,
      },
    ],
  };
}

const TEMPLATE_CATALOGUE: CustomizationTemplate[] = [
  {
    id: 'birthday_discount',
    name: 'Birthday Discount Feature Template',
    description: '会员生日自动折扣与祝福邮件流程',
    keywords: ['生日', 'birthday', '折扣', '优惠', '会员生日'],
    components: ['BirthdayDiscountBanner', 'BirthdayEmailAction'],
    defaultConfig: { discountPercent: 20, validDays: 7, autoEmailEnabled: true },
    paramSpec: [
      { key: 'discountPercent', type: 'number', min: 1, max: 90, default: 20, description: '折扣百分比' },
      { key: 'validDays', type: 'number', min: 1, max: 30, default: 7, description: '券有效天数' },
      { key: 'autoEmailEnabled', type: 'boolean', default: true, description: '是否自动发邮件' },
    ],
    requiredPermissions: ['customers.read', 'orders.read', 'marketing.write'],
    applyToCustomization: (config) => ({
      rules: {
        ...BASE_RULES,
        customRuleFlags: { enableBirthdayDiscount: true, enableAutoWinBackEmailDraft: true },
      },
      workflows: [
        wf(
          'wf_birthday_discount_notification',
          'Birthday Customer Automated Offer Workflow',
          `Automatically sends a ${config.discountPercent ?? 20}% discount coupon ${config.validDays ?? 7} days before customer birthday.`,
          'CUSTOMER_BIRTHDAY_UPCOMING',
          'marketing.create_draft_campaign',
          config
        ),
      ],
    }),
  },
  {
    id: 'low_stock_alert',
    name: 'Low Stock Auto Alert & Purchase Draft Workflow',
    description: '库存低于安全阈值时自动生成补货采购草稿',
    keywords: ['低库存', 'stock', '库存提醒', '补货', 'inventory'],
    components: ['LowStockBadge', 'PurchaseDraftDialog'],
    defaultConfig: { safetyStockThreshold: 15, autoDraftPurchaseOrder: true },
    paramSpec: [
      { key: 'safetyStockThreshold', type: 'number', min: 1, max: 500, default: 15, description: '安全库存阈值' },
      { key: 'autoDraftPurchaseOrder', type: 'boolean', default: true, description: '自动生成采购草稿' },
    ],
    requiredPermissions: ['inventory.read', 'orders.read'],
    applyToCustomization: (config) => ({
      rules: {
        ...BASE_RULES,
        inventoryLowStockThreshold: Number(config.safetyStockThreshold ?? 15),
        customRuleFlags: { enableInventoryRestockApproval: true },
      },
      workflows: [
        wf(
          'wf_low_stock_purchase_draft',
          'Low Stock Purchase Order Draft Workflow',
          'Enqueues purchase draft when stock drops below threshold.',
          'INVENTORY_ALERT',
          'purchase.create_draft',
          config
        ),
      ],
    }),
  },
  {
    id: 'membership_day',
    name: 'Membership Day Campaign',
    description: '每周/每月会员日：会员专属折扣 + 提前通知邮件',
    keywords: ['会员日', 'member day', 'membership', '会员专享'],
    components: ['MembershipDayBanner'],
    defaultConfig: { dayOfWeek: 2, discountPercent: 15, notifyDaysBefore: 2 },
    paramSpec: [
      { key: 'dayOfWeek', type: 'number', min: 0, max: 6, default: 2, description: '星期几（0=周日）' },
      { key: 'discountPercent', type: 'number', min: 1, max: 90, default: 15, description: '会员日折扣百分比' },
      { key: 'notifyDaysBefore', type: 'number', min: 0, max: 7, default: 2, description: '提前几天通知' },
    ],
    requiredPermissions: ['customers.read', 'marketing.write'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableMembershipDay: true } },
      workflows: [
        wf(
          'wf_membership_day_notify',
          'Membership Day Notify Workflow',
          `Notifies members ${config.notifyDaysBefore ?? 2} days before membership day with ${config.discountPercent ?? 15}% offer.`,
          'MEMBERSHIP_DAY_UPCOMING',
          'marketing.create_draft_campaign',
          config
        ),
      ],
    }),
  },
  {
    id: 'happy_hour',
    name: 'Happy Hour Time-based Pricing',
    description: '低谷时段特价：按时间段自动启用折扣价',
    keywords: ['happy hour', '时段特价', '下午茶', '闲时', '低谷'],
    components: ['HappyHourBadge', 'HappyHourMenuSection'],
    defaultConfig: { startHour: 14, endHour: 17, discountPercent: 20 },
    paramSpec: [
      { key: 'startHour', type: 'number', min: 0, max: 23, default: 14, description: '开始小时' },
      { key: 'endHour', type: 'number', min: 0, max: 23, default: 17, description: '结束小时' },
      { key: 'discountPercent', type: 'number', min: 1, max: 90, default: 20, description: '折扣百分比' },
    ],
    requiredPermissions: ['orders.read', 'products.write'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableHappyHour: true } },
      workflows: [
        wf(
          'wf_happy_hour_pricing',
          'Happy Hour Pricing Workflow',
          `Applies ${config.discountPercent ?? 20}% discount between ${config.startHour ?? 14}:00 and ${config.endHour ?? 17}:00.`,
          'HAPPY_HOUR_WINDOW_START',
          'pricing.apply_time_discount',
          config
        ),
      ],
    }),
  },
  {
    id: 'win_back_lapsed',
    name: 'Lapsed Customer Win-back',
    description: '超过 N 天未到店的客户自动进入召回流程',
    keywords: ['召回', '流失', 'win back', 'winback', '回头客', '沉睡'],
    components: ['WinBackCampaignCard'],
    defaultConfig: { lapsedDays: 30, offerPercent: 25, maxPerDay: 20 },
    paramSpec: [
      { key: 'lapsedDays', type: 'number', min: 7, max: 365, default: 30, description: '多少天未消费判定流失' },
      { key: 'offerPercent', type: 'number', min: 1, max: 90, default: 25, description: '召回优惠百分比' },
      { key: 'maxPerDay', type: 'number', min: 1, max: 500, default: 20, description: '每日召回上限' },
    ],
    requiredPermissions: ['customers.read', 'marketing.write'],
    applyToCustomization: (config) => ({
      rules: {
        ...BASE_RULES,
        reviewWinBackHours: Math.min(720, Number(config.lapsedDays ?? 30) * 24),
        customRuleFlags: { enableAutoWinBackEmailDraft: true },
      },
      workflows: [
        wf(
          'wf_win_back_lapsed',
          'Lapsed Customer Win-back Workflow',
          `Drafts a ${config.offerPercent ?? 25}% win-back offer for customers lapsed ${config.lapsedDays ?? 30}+ days.`,
          'CUSTOMER_LAPSED',
          'marketing.create_draft_campaign',
          config
        ),
      ],
    }),
  },
  {
    id: 'review_auto_reply',
    name: 'Negative Review Auto-response Draft',
    description: '差评出现 N 小时内自动生成安抚回复草稿',
    keywords: ['差评', 'review', '评论', '回复', '舆情'],
    components: ['ReviewReplyDraftCard'],
    defaultConfig: { responseHours: 24, tone: 'apologetic' },
    paramSpec: [
      { key: 'responseHours', type: 'number', min: 1, max: 168, default: 24, description: '多少小时内响应' },
      { key: 'tone', type: 'string', default: 'apologetic', description: '回复语气' },
    ],
    requiredPermissions: ['reviews.read', 'reviews.write'],
    applyToCustomization: (config) => ({
      rules: {
        ...BASE_RULES,
        reviewWinBackHours: Number(config.responseHours ?? 24),
        customRuleFlags: { enableReviewAutoReplyDraft: true },
      },
      workflows: [
        wf(
          'wf_review_auto_reply',
          'Negative Review Auto-response Workflow',
          'Drafts an apology response for new negative reviews.',
          'NEGATIVE_REVIEW_RECEIVED',
          'reviews.create_reply_draft',
          config
        ),
      ],
    }),
  },
  {
    id: 'new_dish_launch',
    name: 'New Dish Launch Campaign',
    description: '新品上市：向活跃客户推送新品预告与首周优惠',
    keywords: ['新品', '新菜', '上市', 'launch', '新餐品'],
    components: ['NewDishBanner', 'LaunchCampaignCard'],
    defaultConfig: { firstWeekDiscount: 15, targetSegment: 'active_90d' },
    paramSpec: [
      { key: 'firstWeekDiscount', type: 'number', min: 0, max: 90, default: 15, description: '首周折扣百分比' },
      { key: 'targetSegment', type: 'string', default: 'active_90d', description: '目标客群分群' },
    ],
    requiredPermissions: ['customers.read', 'marketing.write', 'products.read'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableNewDishLaunch: true } },
      workflows: [
        wf(
          'wf_new_dish_launch',
          'New Dish Launch Workflow',
          'Announces new dishes to active customers with a first-week offer.',
          'NEW_PRODUCT_PUBLISHED',
          'marketing.create_draft_campaign',
          config
        ),
      ],
    }),
  },
  {
    id: 'holiday_campaign',
    name: 'Holiday Marketing Campaign',
    description: '节日前 N 天自动起草节日营销邮件',
    keywords: ['节日', 'holiday', '圣诞', '情人节', '活动营销'],
    components: ['HolidayCampaignCard'],
    defaultConfig: { daysBefore: 7, offerPercent: 20 },
    paramSpec: [
      { key: 'daysBefore', type: 'number', min: 1, max: 30, default: 7, description: '提前几天启动' },
      { key: 'offerPercent', type: 'number', min: 0, max: 90, default: 20, description: '节日优惠百分比' },
    ],
    requiredPermissions: ['marketing.write'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableHolidayCampaign: true } },
      workflows: [
        wf(
          'wf_holiday_campaign',
          'Holiday Campaign Workflow',
          `Drafts holiday campaign ${config.daysBefore ?? 7} days ahead.`,
          'HOLIDAY_UPCOMING',
          'marketing.create_draft_campaign',
          config
        ),
      ],
    }),
  },
  {
    id: 'reservation_reminder',
    name: 'Reservation Reminder',
    description: '预约前 N 小时自动发送提醒，降低爽约率',
    keywords: ['预约', '提醒', 'reservation', 'reminder', '爽约'],
    components: ['ReservationReminderBadge'],
    defaultConfig: { remindHoursBefore: 3, channel: 'email' },
    paramSpec: [
      { key: 'remindHoursBefore', type: 'number', min: 1, max: 72, default: 3, description: '提前几小时提醒' },
      { key: 'channel', type: 'string', default: 'email', description: '提醒渠道' },
    ],
    requiredPermissions: ['reservations.read'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableReservationReminder: true } },
      workflows: [
        wf(
          'wf_reservation_reminder',
          'Reservation Reminder Workflow',
          `Sends reminder ${config.remindHoursBefore ?? 3}h before reservation.`,
          'RESERVATION_UPCOMING',
          'notifications.send_reminder',
          config
        ),
      ],
    }),
  },
  {
    id: 'vip_upgrade',
    name: 'VIP Upgrade Care',
    description: '消费达到阈值的高价值客户自动触发升级关怀',
    keywords: ['vip', '高价值', '升级', '大客户', '忠诚'],
    components: ['VipUpgradeCard'],
    defaultConfig: { spendThreshold: 500, giftDescription: 'Free dessert' },
    paramSpec: [
      { key: 'spendThreshold', type: 'number', min: 50, max: 100000, default: 500, description: '累计消费门槛' },
      { key: 'giftDescription', type: 'string', default: 'Free dessert', description: '升级赠礼描述' },
    ],
    requiredPermissions: ['customers.read', 'marketing.write'],
    applyToCustomization: (config) => ({
      rules: { ...BASE_RULES, customRuleFlags: { enableVipUpgrade: true } },
      workflows: [
        wf(
          'wf_vip_upgrade',
          'VIP Upgrade Care Workflow',
          `Flags customers with lifetime spend over ${config.spendThreshold ?? 500} for VIP care.`,
          'CUSTOMER_SPEND_THRESHOLD_REACHED',
          'customers.flag_vip',
          config
        ),
      ],
    }),
  },
];

// ---------------------------------------------------------------------------
// 参数收敛：按 paramSpec 夹取 AI 抽取的参数
// ---------------------------------------------------------------------------

export function coerceParams(
  template: Pick<CustomizationTemplate, 'defaultConfig' | 'paramSpec'>,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...template.defaultConfig };
  for (const spec of template.paramSpec) {
    const value = raw[spec.key];
    if (value === undefined || value === null) continue;
    if (spec.type === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        config[spec.key] = Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
      }
    } else if (spec.type === 'boolean') {
      if (typeof value === 'boolean') config[spec.key] = value;
    } else if (typeof value === 'string' && value.length <= 200) {
      config[spec.key] = value;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface NLParseResult {
  success: boolean;
  templateId?: string;
  templateName?: string;
  generatedConfig?: Record<string, unknown>;
  appliedBundle?: TenantCustomizationBundle;
  /** 意图识别通道：ai = LLM 识别；keyword = 关键词降级 */
  channel?: 'ai' | 'keyword';
  errors?: string[];
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export class NLCustomizationEngine {
  /** 应用模板（注册插件表示 + 写入定制 bundle）。 */
  private applyTemplate(
    template: CustomizationTemplate,
    config: Record<string, unknown>,
    channel: 'ai' | 'keyword'
  ): NLParseResult {
    pluginRegistry.registerPlugin({
      id: `plugin_nl_${template.id}`,
      name: template.name,
      version: '1.0.0',
      type: 'business_feature',
      description: template.description,
      permissions: template.requiredPermissions as PluginPermission[],
      files: template.components.map((c) => `custom/components/${c}.tsx`),
      config,
    });

    const customizationPartial = template.applyToCustomization(config);
    const updatedBundle = updateActiveCustomization(customizationPartial);

    return {
      success: true,
      templateId: template.id,
      templateName: template.name,
      generatedConfig: config,
      appliedBundle: updatedBundle,
      channel,
    };
  }

  /** 关键词降级匹配（v1 行为，保持同步签名兼容既有调用与测试）。 */
  public parseAndApplyNLIntent(userPrompt: string): NLParseResult {
    if (!userPrompt || !userPrompt.trim()) {
      return { success: false, errors: ['Prompt cannot be empty'] };
    }

    const matchedTemplate = this.matchByKeywords(userPrompt);
    if (!matchedTemplate) {
      return this.noMatchResult();
    }
    return this.applyTemplate(matchedTemplate, matchedTemplate.defaultConfig, 'keyword');
  }

  /**
   * AI 通道：LLM 选择模板 + 抽取参数 → 参数收敛 → 应用。
   * AI 不可用 / 输出非法时自动降级关键词匹配。
   */
  public async parseAndApplyNLIntentAsync(
    userPrompt: string,
    forwardHeaders?: Record<string, string>
  ): Promise<NLParseResult> {
    if (!userPrompt || !userPrompt.trim()) {
      return { success: false, errors: ['Prompt cannot be empty'] };
    }

    try {
      const aiResult = await this.classifyWithAI(userPrompt, forwardHeaders);
      if (aiResult) {
        const template = TEMPLATE_CATALOGUE.find((t) => t.id === aiResult.templateId);
        if (template) {
          const config = coerceParams(template, aiResult.params);
          return this.applyTemplate(template, config, 'ai');
        }
      }
    } catch {
      // AI 通道失败 —— 降级关键词
    }

    const matchedTemplate = this.matchByKeywords(userPrompt);
    if (!matchedTemplate) {
      return this.noMatchResult();
    }
    return this.applyTemplate(matchedTemplate, matchedTemplate.defaultConfig, 'keyword');
  }

  private matchByKeywords(userPrompt: string): CustomizationTemplate | undefined {
    const lower = userPrompt.toLowerCase();
    let best: { template: CustomizationTemplate; score: number; longest: number } | undefined;
    for (const tmpl of TEMPLATE_CATALOGUE) {
      const hits = tmpl.keywords.filter((kw) => lower.includes(kw.toLowerCase()));
      if (hits.length === 0) continue;
      const longest = Math.max(...hits.map((h) => h.length));
      const score = hits.length;
      // 命中数优先；并列时最长关键词优先（'会员日' 胜过泛化的 '折扣'）
      if (!best || score > best.score || (score === best.score && longest > best.longest)) {
        best = { template: tmpl, score, longest };
      }
    }
    return best?.template;
  }

  private noMatchResult(): NLParseResult {
    return {
      success: false,
      errors: [
        `Could not match intent to a verified safe template. Available templates: ${TEMPLATE_CATALOGUE.map((t) => t.id).join(', ')}`,
      ],
    };
  }

  /** LLM 分类：从目录中选模板并抽取参数，输出严格 JSON。 */
  private async classifyWithAI(
    userPrompt: string,
    forwardHeaders?: Record<string, string>
  ): Promise<{ templateId: string; params: Record<string, unknown> } | null> {
    const catalogueDesc = TEMPLATE_CATALOGUE.map(
      (t) =>
        `- id="${t.id}" | ${t.name} | ${t.description} | params: ${t.paramSpec
          .map((p) => `${p.key}(${p.type},default=${String(p.default)})`)
          .join(', ')}`
    ).join('\n');

    const raw = await invokeChat(
      'light',
      [
        {
          role: 'system',
          content:
            'You are an intent classifier for a restaurant business customization engine. ' +
            'Pick exactly ONE template from the catalogue and extract parameters from the user request. ' +
            'Return ONLY valid JSON: {"templateId":"<id>","params":{...}}. ' +
            'If nothing matches, return {"templateId":"none","params":{}}.\n\nCatalogue:\n' +
            catalogueDesc,
        },
        { role: 'user', content: userPrompt.slice(0, 1000) },
      ],
      // 平台级定制引擎：显式平台 scope（PLATFORM_AI_SCOPE）——只允许平台内置模型，
      // 路由层绝不读取任何租户的 settings/model_configs（跨租户凭据滥用防线）
      forwardHeaders,
      PLATFORM_AI_SCOPE,
      { agent: 'customization:nl-engine' }
    );

    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { templateId?: unknown; params?: unknown };
    if (typeof parsed.templateId !== 'string' || parsed.templateId === 'none') return null;
    return {
      templateId: parsed.templateId,
      params:
        typeof parsed.params === 'object' && parsed.params !== null
          ? (parsed.params as Record<string, unknown>)
          : {},
    };
  }

  /** List available NL customization templates. */
  public listTemplates(): { id: string; name: string; description: string; keywords: string[] }[] {
    return TEMPLATE_CATALOGUE.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      keywords: t.keywords,
    }));
  }
}

export const nlCustomizationEngine = new NLCustomizationEngine();
