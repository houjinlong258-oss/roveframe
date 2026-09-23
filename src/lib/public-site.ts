import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 商户官网（Phase 17）。
 *
 * ## 为什么是这张表而不是"生成一个静态站点"
 *
 * 站点的内容全部来自商家已有的数据（`businesses` / `settings.business` /
 * `products`），而"下单"必须落到**已有的**顾客端 PWA 上。所以这里存的是
 * **渲染参数**，不是一份 HTML：商品、价格、库存改了以后官网自动跟着改，
 * 不存在"官网和后台数据不一致"这一类问题。
 *
 * ## 下单为什么一行都不用改
 *
 * 顾客端 PWA 由 `store_qr_codes.public_token` 定位租户（src/lib/storefront.ts:16），
 * 所以这里给每个商家准备一行 `table_no = 'WEB'` 的桌码，官网"立即下单"就跳到
 * `/{locale}/store?token=<它>`。服务端计价、租户隔离、幂等键全部复用现成实现。
 */

export interface SiteSection {
  id: string;
  kind: 'hero' | 'about' | 'menu' | 'hours' | 'gallery' | 'reviews' | 'contact' | 'cta';
  heading: string;
  body: string;
}

export interface SiteTheme {
  primary: string;
  accent: string;
  surface: string;
  font: 'sans' | 'serif';
}

export interface SiteSeo {
  title: string;
  description: string;
}

export interface SiteContact {
  phone: string;
  email: string;
  address: string;
  hours: string;
}

export interface PublicSiteRow {
  id: string;
  tenant_id: string;
  business_id: string;
  slug: string;
  enabled: boolean;
  tagline: string;
  about: string;
  sections: SiteSection[];
  theme: SiteTheme;
  seo: SiteSeo;
  contact: SiteContact;
  custom_domain: string | null;
  domain_status: DomainStatus;
  domain_error: string | null;
  web_order_token: string | null;
  generated_by: string;
  generated_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export type DomainStatus = 'none' | 'pending_dns' | 'issuing' | 'active' | 'error';

export const SITE_SECTION_KINDS: readonly SiteSection['kind'][] = [
  'hero', 'about', 'menu', 'hours', 'gallery', 'reviews', 'contact', 'cta',
];

export const DEFAULT_THEME: SiteTheme = {
  primary: '#0f766e',
  accent: '#f59e0b',
  surface: '#ffffff',
  font: 'sans',
};

/**
 * slug 是公开 URL 的一部分，因此必须在**写入前**就限定形态：
 * 路径穿越、保留字、超长、Unicode 同形字都会变成边界问题。
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 保留字：这些前缀在应用里已经是别的路由。若允许商家占用，
 * `/site/dashboard` 之类会与真实路由争夺解析权。
 */
export const RESERVED_SLUGS: readonly string[] = [
  'api', 'auth', 'admin', 'site', 'store', 'dashboard', 'agent', 'settings',
  'static', 'public', 'assets', '_next', 'www', 'app', 'mail', 'cdn',
];

export function normalizeSlug(input: string): string | null {
  const slug = String(input ?? '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SLUGS.includes(slug)) return null;
  return slug;
}

/** 由店名派生一个候选 slug（不保证唯一，调用方负责去重）。 */
export function slugify(input: string): string {
  const ascii = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return ascii || 'store';
}

/**
 * 取一个未被占用的 slug：`base`、`base-2`、`base-3` … 上限 50 次。
 * 中文店名 slugify 之后会退化成 `store`，所以这条路径是常态而不是例外。
 */
export async function allocateSlug(base: string, tenantId?: string): Promise<string | null> {
  const root = normalizeSlug(base) ?? slugify(base);
  const client = getSupabaseClient();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    if (!normalizeSlug(candidate)) continue;
    const { data, error } = await client
      .from('public_sites')
      .select('id, tenant_id')
      .eq('slug', candidate)
      .maybeSingle();
    if (error) return null;
    if (!data || data.tenant_id === tenantId) return candidate;
  }
  return null;
}

function coerceSection(raw: unknown): SiteSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind : '';
  if (!SITE_SECTION_KINDS.includes(kind as SiteSection['kind'])) return null;
  return {
    id: typeof row.id === 'string' && row.id ? row.id : kind,
    kind: kind as SiteSection['kind'],
    heading: typeof row.heading === 'string' ? row.heading.slice(0, 160) : '',
    body: typeof row.body === 'string' ? row.body.slice(0, 4000) : '',
  };
}

/**
 * 把 jsonb 列收敛成受控形态：库里可能有旧版本或手工写入的数据。
 *
 * 参数是 `unknown` 而不是 `Record<string, unknown>`：supabase-js 的返回类型是一个
 * 联合类型（含 GenericStringError），调用方每次都要写一次 `as` 转换；把收窄
 * 放在这里，调用点就不用各自重复一遍。
 */
export function coerceSiteRow(input: unknown): PublicSiteRow {
  const raw = input as Record<string, unknown>;
  const theme = (raw.theme ?? {}) as Record<string, unknown>;
  const seo = (raw.seo ?? {}) as Record<string, unknown>;
  const contact = (raw.contact ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map(coerceSection).filter((s): s is SiteSection => s !== null)
    : [];
  const status = typeof raw.domain_status === 'string' ? raw.domain_status : 'none';

  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    business_id: String(raw.business_id),
    slug: String(raw.slug),
    enabled: raw.enabled === true,
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    about: typeof raw.about === 'string' ? raw.about : '',
    sections,
    theme: {
      primary: typeof theme.primary === 'string' ? theme.primary : DEFAULT_THEME.primary,
      accent: typeof theme.accent === 'string' ? theme.accent : DEFAULT_THEME.accent,
      surface: typeof theme.surface === 'string' ? theme.surface : DEFAULT_THEME.surface,
      font: theme.font === 'serif' ? 'serif' : 'sans',
    },
    seo: {
      title: typeof seo.title === 'string' ? seo.title : '',
      description: typeof seo.description === 'string' ? seo.description : '',
    },
    contact: {
      phone: typeof contact.phone === 'string' ? contact.phone : '',
      email: typeof contact.email === 'string' ? contact.email : '',
      address: typeof contact.address === 'string' ? contact.address : '',
      hours: typeof contact.hours === 'string' ? contact.hours : '',
    },
    custom_domain: typeof raw.custom_domain === 'string' && raw.custom_domain ? raw.custom_domain : null,
    domain_status: (['none', 'pending_dns', 'issuing', 'active', 'error'] as const).includes(
      status as DomainStatus,
    ) ? (status as DomainStatus) : 'none',
    domain_error: typeof raw.domain_error === 'string' ? raw.domain_error : null,
    web_order_token: typeof raw.web_order_token === 'string' ? raw.web_order_token : null,
    generated_by: typeof raw.generated_by === 'string' ? raw.generated_by : 'agent',
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
    published_at: typeof raw.published_at === 'string' ? raw.published_at : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

const SITE_COLUMNS = [
  'id', 'tenant_id', 'business_id', 'slug', 'enabled', 'tagline', 'about',
  'sections', 'theme', 'seo', 'contact', 'custom_domain', 'domain_status',
  'domain_error', 'web_order_token', 'generated_by', 'generated_at',
  'published_at', 'created_at', 'updated_at',
].join(', ');

export async function getSiteForBusiness(
  tenantId: string,
  businessId: string,
): Promise<PublicSiteRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('public_sites')
    .select(SITE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error || !data) return null;
  return coerceSiteRow(data);
}

/**
 * 公开解析：按 slug 取**已发布**的站点。
 * 未发布一律返回 null（调用方给 404），不泄漏"这里存在一个草稿"。
 */
export async function resolvePublishedSiteBySlug(slug: string): Promise<PublicSiteRow | null> {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;
  const { data, error } = await getSupabaseClient()
    .from('public_sites')
    .select(SITE_COLUMNS)
    .eq('slug', normalized)
    .eq('enabled', true)
    .maybeSingle();
  if (error || !data) return null;
  return coerceSiteRow(data);
}

/**
 * 公开解析：按 Host 取已发布的站点（商家自带域名）。
 * Host 先归一化：去端口、小写、去尾部点。
 */
export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const value = String(host).trim().toLowerCase().replace(/\.$/, '').split(':')[0];
  if (!/^[a-z0-9.-]{1,253}$/.test(value)) return null;
  return value || null;
}

export async function resolvePublishedSiteByHost(host: string): Promise<PublicSiteRow | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const { data, error } = await getSupabaseClient()
    .from('public_sites')
    .select(SITE_COLUMNS)
    .eq('custom_domain', normalized)
    .eq('enabled', true)
    .maybeSingle();
  if (error || !data) return null;
  return coerceSiteRow(data);
}

/**
 * 证书签发的放行判断（Caddy `on_demand_tls.ask`）。
 *
 * **fail-closed**：只有
 *   1. Host 是平台自己的域名（SITE_DOMAIN），且本站已配置；或
 *   2. Host 命中一条 custom_domain **且** domain_status='active'
 * 才放行。其余一律 false —— 任何人都能把 evil.example 解析到这台服务器，
 * 若不加限制，本机就成了替别人签证书的工具（同时消耗 Let's Encrypt 配额）。
 */
export async function isHostAuthorizedForCertificate(host: string): Promise<boolean> {
  const normalized = normalizeHost(host);
  if (!normalized) return false;

  const platformDomain = normalizeHost(process.env.SITE_DOMAIN ?? '');
  if (platformDomain && normalized === platformDomain) return true;

  // ⚠️ fail-closed 必须覆盖"客户端根本建不起来"这一种失败。
  //
  // 此前只有 `if (error || !data) return false` —— 那覆盖的是**查询失败**；
  // 而 `getSupabaseClient()` 在凭据缺失/环境不完整时会**直接抛错**，
  // 于是这个函数抛而不是返回 false。
  //
  // 这是被测试逼出来的：`tests/site-certificate-authorization.test.ts` 的
  // describe 就叫「异常也必须拒绝」，它在本地（有凭据、查询正常返回空）通过，
  // 在 CI（无凭据、客户端构造即抛）变红 —— 也就是说它此前**因为错误的原因通过**。
  //
  // 影响面：本函数是 Caddy on-demand TLS 的授权判断。路由侧另有 catch 保持拒绝
  // （见该测试的"接线契约"一节），所以线上并未敞开；但"函数契约是返回 false、
  // 而不是抛"这一点必须由函数自己保证，不能依赖调用方兜底。
  try {
    const { data, error } = await getSupabaseClient()
      .from('public_sites')
      .select('id')
      .eq('custom_domain', normalized)
      .eq('domain_status', 'active')
      .eq('enabled', true)
      .maybeSingle();
    if (error || !data) return false;
    return true;
  } catch (error) {
    console.error(
      '[public-site] certificate host lookup failed, denying:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** 公开站点入口用的"网页桌号"。约定 table_no='WEB'，与堂食桌码并列可见。 */
export const WEB_ORDER_TABLE_NO = 'WEB';

/**
 * 取（必要时创建）该商家的网页点单 token。
 *
 * 复用 `store_qr_codes` 而不是新造一套：顾客端 PWA、服务端计价、幂等键、
 * 桌码管理页全部已经按这张表实现，新造一张表就等于重写一遍落单链路。
 */
export async function ensureWebOrderToken(
  tenantId: string,
  businessId: string,
): Promise<string | null> {
  const client = getSupabaseClient();
  const { data: existing, error: readError } = await client
    .from('store_qr_codes')
    .select('public_token, is_active')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('table_no', WEB_ORDER_TABLE_NO)
    .maybeSingle();
  if (readError) return null;
  if (existing?.public_token && existing.is_active !== false) return existing.public_token as string;

  const { data: upserted, error: upsertError } = await client
    .from('store_qr_codes')
    .upsert({
      tenant_id: tenantId,
      business_id: businessId,
      table_no: WEB_ORDER_TABLE_NO,
      remark: 'Online ordering (website)',
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,business_id,table_no' })
    .select('public_token')
    .single();
  if (upsertError || !upserted?.public_token) return null;
  return upserted.public_token as string;
}
