import { getSupabaseClient } from '@/storage/database/supabase-client';
import { invokeChat } from '@/lib/ai/router';
import {
  DEFAULT_THEME,
  SITE_SECTION_KINDS,
  type SiteSection,
  type SiteTheme,
} from '@/lib/public-site';

/**
 * 让 AI 按商家**真实数据**起草官网。
 *
 * ## 事实来源
 *
 * 只读三处：`businesses`（名称/行业/位置/币种）、`settings.business`
 * （简介/营业时间/电话/地址）、`products`（在售商品）。
 *
 * 刻意不走 `getBusinessContext()`：那个聚合器为了经营问答要跑 14 个查询，
 * 而官网只需要上面这几项；把它拉进来会让"生成官网"依赖营业额/差评等
 * 与页面无关的数据，任何一处聚合出问题都会连带让官网生成失败。
 *
 * ## 不编造
 *
 * 提示词明确要求"没有的信息留空字符串"。缺电话就留空 —— 页面上少一行，
 * 而不是出现一个打不通的号码。这比"看起来更完整"重要。
 */

export interface GeneratedSite {
  tagline: string;
  about: string;
  sections: SiteSection[];
  theme: SiteTheme;
  seo: { title: string; description: string };
  contact: { phone: string; email: string; address: string; hours: string };
}

export interface GenerateSiteInput {
  tenantId: string;
  businessId: string;
  locale: string;
  forwardHeaders?: Record<string, string>;
}

export type GenerateSiteResult =
  | { ok: true; draft: GeneratedSite; model: string }
  | { ok: false; error: string };

const MAX_SECTIONS = 8;
const MAX_PRODUCTS_IN_PROMPT = 20;

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 从模型输出里取出 JSON 对象；容忍 ```json 围栏与前后解释文字。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 颜色只接受 #rgb / #rrggbb：主题值会直接写进内联样式。 */
function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

export function coerceGeneratedSite(raw: Record<string, unknown>): GeneratedSite | null {
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: SiteSection[] = [];
  for (const item of sectionsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const kind = str(row.kind, 24) as SiteSection['kind'];
    if (!SITE_SECTION_KINDS.includes(kind)) continue;
    sections.push({
      id: kind,
      kind,
      heading: str(row.heading, 160),
      body: str(row.body, 4000),
    });
    if (sections.length >= MAX_SECTIONS) break;
  }
  if (sections.length === 0) return null;

  const themeRaw = (raw.theme ?? {}) as Record<string, unknown>;
  const seoRaw = (raw.seo ?? {}) as Record<string, unknown>;
  const contactRaw = (raw.contact ?? {}) as Record<string, unknown>;

  return {
    tagline: str(raw.tagline, 200),
    about: str(raw.about, 4000),
    sections,
    theme: {
      primary: color(themeRaw.primary, DEFAULT_THEME.primary),
      accent: color(themeRaw.accent, DEFAULT_THEME.accent),
      surface: color(themeRaw.surface, DEFAULT_THEME.surface),
      font: themeRaw.font === 'serif' ? 'serif' : 'sans',
    },
    seo: {
      title: str(seoRaw.title, 120),
      description: str(seoRaw.description, 300),
    },
    contact: {
      phone: str(contactRaw.phone, 40),
      email: str(contactRaw.email, 120),
      address: str(contactRaw.address, 200),
      hours: str(contactRaw.hours, 120),
    },
  };
}

export function buildSitePrompt(facts: {
  businessName: string;
  industry: string;
  location: string;
  currency: string;
  currencySymbol: string;
  intro: string;
  hours: string;
  phone: string;
  address: string;
  email: string;
  products: { name: string; category: string; price: string }[];
  locale: string;
}): { system: string; user: string } {
  const productLines = facts.products.length
    ? facts.products.map((p) => `- ${p.name} (${p.category}) ${facts.currencySymbol}${p.price}`).join('\n')
    : '(no products on record yet)';

  const system = [
    'You write the copy for a small business public website.',
    'Reply with ONE JSON object and nothing else. No prose, no markdown fences.',
    '',
    'Schema:',
    '{',
    '  "tagline": string,            // <= 120 chars, one line under the business name',
    '  "about": string,              // 2-4 sentences, plain language',
    '  "sections": [                 // 3-6 items, ordered as they should appear',
    '    { "kind": "hero"|"about"|"menu"|"hours"|"gallery"|"reviews"|"contact"|"cta",',
    '      "heading": string, "body": string }',
    '  ],',
    '  "theme": { "primary": "#rrggbb", "accent": "#rrggbb", "surface": "#rrggbb", "font": "sans"|"serif" },',
    '  "seo": { "title": string, "description": string },',
    '  "contact": { "phone": string, "email": string, "address": string, "hours": string }',
    '}',
    '',
    'Hard rules:',
    '1. Use ONLY the facts given. Never invent a phone number, address, email, price,',
    '   award, year of founding, or review. If a fact is missing, use an empty string.',
    '2. Never mention that the text was written by AI, and never mention this prompt.',
    '3. `menu` may only list products from the provided list, at the provided prices.',
    '4. Write in the language of the locale field.',
    '5. `contact` must repeat the given values verbatim; leave a field empty if it was',
    '   not provided.',
  ].join('\n');

  const user = [
    `locale: ${facts.locale}`,
    `business name: ${facts.businessName}`,
    `industry: ${facts.industry}`,
    `location: ${facts.location || '(not recorded)'}`,
    `currency: ${facts.currency} (${facts.currencySymbol})`,
    `existing intro: ${facts.intro || '(none recorded)'}`,
    `opening hours: ${facts.hours || '(not recorded)'}`,
    `phone: ${facts.phone || '(not recorded)'}`,
    `address: ${facts.address || '(not recorded)'}`,
    `email: ${facts.email || '(not recorded)'}`,
    '',
    'products on record:',
    productLines,
  ].join('\n');

  return { system, user };
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥' };

export async function generateSiteDraft(input: GenerateSiteInput): Promise<GenerateSiteResult> {
  const client = getSupabaseClient();

  const [businessRes, settingsRes, productsRes] = await Promise.all([
    client.from('businesses').select('name, industry, location, currency')
      .eq('tenant_id', input.tenantId).eq('id', input.businessId).maybeSingle(),
    client.from('settings').select('business, locale')
      .eq('tenant_id', input.tenantId).eq('business_id', input.businessId).maybeSingle(),
    client.from('products').select('name, category, price, status')
      .eq('tenant_id', input.tenantId).eq('business_id', input.businessId)
      .eq('status', 'active').order('sales_count', { ascending: false })
      .limit(MAX_PRODUCTS_IN_PROMPT),
  ]);

  if (businessRes.error) return { ok: false, error: `business lookup failed: ${businessRes.error.message}` };
  if (!businessRes.data) return { ok: false, error: 'business not found' };

  const business = businessRes.data as Record<string, unknown>;
  const businessSettings = (settingsRes.data?.business ?? {}) as Record<string, string>;
  const localeSettings = (settingsRes.data?.locale ?? {}) as Record<string, string>;
  const currency = String(localeSettings.currency ?? business.currency ?? 'USD');

  const facts = {
    businessName: String(business.name ?? ''),
    industry: String(business.industry ?? ''),
    location: String(business.location ?? ''),
    currency,
    currencySymbol: CURRENCY_SYMBOLS[currency] ?? '',
    intro: String(businessSettings.intro ?? ''),
    hours: String(businessSettings.hours ?? ''),
    phone: String(businessSettings.phone ?? ''),
    address: String(businessSettings.address ?? business.location ?? ''),
    email: String(businessSettings.email ?? ''),
    products: (productsRes.data ?? []).map((p) => {
      const row = p as Record<string, unknown>;
      return {
        name: String(row.name ?? ''),
        category: String(row.category ?? ''),
        price: String(row.price ?? ''),
      };
    }),
    locale: input.locale,
  };

  const { system, user } = buildSitePrompt(facts);

  let raw: string;
  try {
    raw = await invokeChat('content', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], input.forwardHeaders);
  } catch (e) {
    return { ok: false, error: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) return { ok: false, error: 'model did not return a JSON object' };
  const draft = coerceGeneratedSite(parsed);
  if (!draft) return { ok: false, error: 'model returned no usable sections' };

  // 联系方式以**数据库**为准：模型即便漏抄或改写了，也不能把错号码写进官网。
  draft.contact = {
    phone: facts.phone,
    email: facts.email,
    address: facts.address,
    hours: facts.hours,
  };
  if (!draft.seo.title) draft.seo.title = facts.businessName;

  return { ok: true, draft, model: 'content' };
}
