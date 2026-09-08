/**
 * 自然语言业务 Onboarding —— 解析器（确定性优先，无副作用）。
 *
 * 原则：
 * - 输入先解析成严格 schema，再由用户确认；确认前不得有任何业务写操作。
 * - 解析失败使用确定性 fallback，并标明缺失字段。
 * - 输入长度、控制字符、prompt injection 与未知行业全部受限。
 * - 绝不根据一句话生成任意代码或 workflow 定义。
 */

import { z } from 'zod';

export const MAX_ONBOARDING_INPUT = 2000;

const INDUSTRIES = ['restaurant', 'retail', 'hotel', 'healthcare', 'beauty', 'fitness', 'other'] as const;
const POS_SYSTEMS = ['square', 'toast', 'clover', 'shopify', 'lightspeed', 'none', 'unknown'] as const;
const LANGUAGES = ['en', 'zh', 'es'] as const;

export const onboardingDraftSchema = z.object({
  businessName: z.string().min(1).max(120),
  industry: z.enum(INDUSTRIES),
  location: z.string().max(120).nullable(),
  timezone: z.string().max(60).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  language: z.enum(LANGUAGES),
  goals: z.array(z.string().max(200)).max(10),
  existingSoftware: z.array(z.string().max(60)).max(10),
  posSystem: z.enum(POS_SYSTEMS),
  openingHours: z.string().max(120).nullable(),
  staffRoles: z.array(z.string().max(40)).max(10),
  knowledgeSources: z.array(z.string().max(120)).max(10),
  missingFields: z.array(z.string()),
  parseSource: z.enum(['deterministic', 'ai', 'fallback']),
});

export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;

const INDUSTRY_KEYWORDS: Array<[RegExp, (typeof INDUSTRIES)[number]]> = [
  [/restaurant|sushi|ramen|pizza|cafe|coffee|bakery|bistro|diner|bbq|taco|noodle|hotpot|餐|寿司|咖啡|面馆|火锅|烧烤/i, 'restaurant'],
  [/retail|shop|store|boutique|grocery|market|便利店|零售|超市|服装/i, 'retail'],
  [/hotel|hostel|inn|motel|bnb|民宿|酒店|旅馆/i, 'hotel'],
  [/clinic|dental|healthcare|pharmacy|诊所|药房/i, 'healthcare'],
  [/salon|barber|spa|nail|beauty|美发|美甲|美容/i, 'beauty'],
  [/gym|fitness|yoga|pilates|健身|瑜伽/i, 'fitness'],
];

const POS_KEYWORDS: Array<[RegExp, (typeof POS_SYSTEMS)[number]]> = [
  [/square/i, 'square'],
  [/toast/i, 'toast'],
  [/clover/i, 'clover'],
  [/shopify/i, 'shopify'],
  [/lightspeed/i, 'lightspeed'],
];

const GOAL_KEYWORDS: Array<[RegExp, string]> = [
  [/repeat|retention|loyal|回头客|复购/i, 'improve customer retention'],
  [/review|rating|差评|评价/i, 'improve review ratings'],
  [/revenue|sales|profit|营收|收入/i, 'grow revenue'],
  [/market|promot|营销|推广/i, 'strengthen marketing'],
  [/inventory|stock|库存/i, 'optimize inventory'],
  [/labor|staff|schedul|人力|排班/i, 'optimize staffing'],
];

const CURRENCY_BY_LOCALE: Array<[RegExp, string]> = [
  [/new york|los angeles|san francisco|chicago|boston|seattle|miami|usa|america|纽约|洛杉矶|旧金山|芝加哥|波士顿|西雅图|迈阿密|美国/i, 'USD'],
  [/london|manchester|uk|britain|伦敦|英国/i, 'GBP'],
  [/tokyo|osaka|japan|东京|大阪|日本/i, 'JPY'],
  [/beijing|shanghai|shenzhen|guangzhou|chengdu|hangzhou|china|北京|上海|深圳|广州|成都|杭州|中国/i, 'CNY'],
  [/madrid|barcelona|spain|mexico|西班牙|墨西哥/i, 'EUR'],
];

const TIMEZONE_BY_CITY: Array<[RegExp, string]> = [
  [/new york|boston|miami|纽约|波士顿|迈阿密/i, 'America/New_York'],
  [/los angeles|san francisco|seattle|洛杉矶|旧金山|西雅图/i, 'America/Los_Angeles'],
  [/chicago|芝加哥/i, 'America/Chicago'],
  [/london|伦敦/i, 'Europe/London'],
  [/tokyo|osaka|东京|大阪/i, 'Asia/Tokyo'],
  [/beijing|shanghai|shenzhen|guangzhou|chengdu|hangzhou|北京|上海|深圳|广州|成都|杭州/i, 'Asia/Shanghai'],
  [/madrid|barcelona|马德里|巴塞罗那/i, 'Europe/Madrid'],
];

/** 去掉控制字符与明显注入指令，限制长度 */
export function sanitizeOnboardingInput(raw: string): string {
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  // 常见 prompt injection 指令整段剔除（不改变正常业务描述）
  text = text.replace(/ignore (all |any )?(previous|above|prior) instructions?/gi, ' ');
  text = text.replace(/(system prompt|jailbreak|DAN mode|开发者模式)/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_ONBOARDING_INPUT);
}

function detectLanguage(text: string): (typeof LANGUAGES)[number] {
  if (/[一-龥]/.test(text)) return 'zh';
  if (/[áéíóúñ¿¡]/i.test(text)) return 'es';
  return 'en';
}

function extractLocation(text: string): string | null {
  const m =
    /(New York|Los Angeles|San Francisco|Chicago|Boston|Seattle|Miami|London|Tokyo|Osaka|Beijing|Shanghai|Shenzhen|Guangzhou|Chengdu|Hangzhou|Madrid|Barcelona)/i.exec(text) ??
    /(纽约|洛杉矶|旧金山|芝加哥|波士顿|西雅图|迈阿密|伦敦|东京|大阪|北京|上海|深圳|广州|成都|杭州)/.exec(text) ??
    /(?:in|at|located in|based in|在)\s+([A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+){0,3}|[一-龥]{2,10})(?=\s*[.,;:!?)]|\s+(?:and|we|with|that|using|use|想|，|。|、)|$)/.exec(text);
  if (!m) return null;
  return m[1].trim().replace(/[.,;:]$/, '');
}

function extractBusinessName(text: string, industry: (typeof INDUSTRIES)[number], location: string | null): string {
  // "I own/ run / have a sushi restaurant" → 用描述合成默认名；显式 "called/named X" 优先
  const named = /(?:called|named|叫|名为)\s*["“']?([A-Za-z0-9一-龥 '&.-]{2,40})["”']?/i.exec(text);
  if (named) return named[1].trim();
  const parts: string[] = [];
  if (location) parts.push(location);
  parts.push(industry === 'other' ? 'Business' : `${industry[0].toUpperCase()}${industry.slice(1)}`);
  return parts.join(' ');
}

/**
 * 确定性解析自然语言业务描述 → 严格 schema 草稿。
 * 无任何副作用；缺失字段明确列出，供确认步骤补充。
 */
export function parseBusinessDescription(rawInput: string): OnboardingDraft {
  const text = sanitizeOnboardingInput(rawInput);
  const language = detectLanguage(text);

  const industry = INDUSTRY_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'other';
  const location = extractLocation(text);
  const posSystem = POS_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? (/no pos|没有 pos/i.test(text) ? 'none' : 'unknown');

  const goals = GOAL_KEYWORDS.filter(([re]) => re.test(text)).map(([, goal]) => goal);
  const existingSoftware = POS_KEYWORDS.filter(([re]) => re.test(text)).map(([, pos]) => pos);

  const currency = CURRENCY_BY_LOCALE.find(([re]) => re.test(text))?.[1] ?? null;
  const timezone = TIMEZONE_BY_CITY.find(([re]) => re.test(text))?.[1] ?? null;

  const missingFields: string[] = [];
  if (industry === 'other') missingFields.push('industry');
  if (!location) missingFields.push('location');
  if (posSystem === 'unknown') missingFields.push('posSystem');
  if (!currency) missingFields.push('currency');
  if (!timezone) missingFields.push('timezone');

  return onboardingDraftSchema.parse({
    businessName: extractBusinessName(text, industry, location),
    industry,
    location,
    timezone,
    currency,
    language,
    goals: goals.length ? goals : ['improve customer retention'],
    existingSoftware,
    posSystem,
    openingHours: null,
    staffRoles: [],
    knowledgeSources: [],
    missingFields,
    parseSource: 'deterministic',
  });
}

/**
 * 工作区创建计划的幂等键：同一租户 + 同一规范化业务名 → 同一工作区。
 * 重复提交（网络重试/双击）不得产生重复 business。
 */
export function onboardingIdempotencyKey(tenantId: string, businessName: string): string {
  const normalized = businessName.trim().toLowerCase().replace(/\s+/g, ' ');
  return `onboarding:${tenantId}:${normalized}`;
}
