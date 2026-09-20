import { notFound } from 'next/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublishedSiteBySlug, type PublicSiteRow } from '@/lib/public-site';
import { fmtCurrency } from '@/lib/format';
import { SiteBookingForm } from '@/components/site/site-booking-form';

/**
 * 商户官网（公开页面，无会话）。
 *
 * ## 为什么是服务端渲染而不是一张静态页
 *
 * 页面上的商品、价格、营业时间全部读**当前**数据库。商家在后台改一个价格，
 * 官网立刻跟着变 —— 不存在"官网和后台两套数据"这个经典问题，也不需要
 * 生成/发布流水线。代价是每次访问要查两次库，对这个规模完全划算。
 *
 * ## 未发布 = 404
 *
 * `resolvePublishedSiteBySlug` 只返回 enabled=true 的行。草稿对外**不存在**，
 * 而不是"能看到但没内容"。
 */

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

interface SiteProduct {
  id: string;
  name: string;
  category: string;
  price: string | number;
  description: string | null;
  image_url: string | null;
}

async function loadProducts(site: PublicSiteRow): Promise<{ products: SiteProduct[]; currency: string }> {
  const client = getSupabaseClient();
  const [productsRes, settingsRes] = await Promise.all([
    client.from('products')
      .select('id, name, category, price, description, image_url')
      .eq('tenant_id', site.tenant_id)
      .eq('business_id', site.business_id)
      .eq('status', 'active')
      .order('sales_count', { ascending: false })
      .limit(60),
    client.from('settings').select('locale')
      .eq('tenant_id', site.tenant_id)
      .eq('business_id', site.business_id)
      .maybeSingle(),
  ]);
  const localeSettings = (settingsRes.data?.locale ?? {}) as Record<string, string>;
  return {
    products: (productsRes.data ?? []) as SiteProduct[],
    // 币种随商家配置，不用常量：菜单/点餐 H5 也是这么做的（api/store/menu/route.ts:48）。
    currency: localeSettings.currency ?? 'USD',
  };
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) return { title: 'Not found' };
  return {
    title: site.seo.title || site.slug,
    description: site.seo.description || site.tagline,
  };
}

export default async function PublicSitePage({ params }: PageProps) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) notFound();

  const [productsResult, t] = await Promise.all([
    loadProducts(site),
    getTranslations('site'),
  ]);
  const { products, currency } = productsResult;

  const orderHref = site.web_order_token
    ? `/${locale}/store?token=${encodeURIComponent(site.web_order_token)}`
    : null;
  const backendHref = `/${locale}/dashboard`;
  const theme = site.theme;
  const fontFamily = theme.font === 'serif'
    ? 'Georgia, "Times New Roman", serif'
    : 'system-ui, -apple-system, "Segoe UI", sans-serif';

  const has = (kind: string) => site.sections.some((s) => s.kind === kind);

  return (
    <div
      className="min-h-screen"
      style={{
        background: theme.surface,
        color: '#1c1917',
        fontFamily,
      }}
    >
      <header className="border-b" style={{ borderColor: `${theme.primary}22` }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
          <span className="text-lg font-semibold" style={{ color: theme.primary }}>
            {site.seo.title || site.slug}
          </span>
          <nav className="flex items-center gap-2 text-sm">
            <a
              className="rounded-full border px-4 py-1.5"
              style={{ borderColor: `${theme.primary}44`, color: theme.primary }}
              href={backendHref}
            >
              {t('backend')}
            </a>
            {orderHref && (
              <a
                className="rounded-full px-4 py-1.5 font-medium text-white"
                style={{ background: theme.primary }}
                href={orderHref}
              >
                {t('order')}
              </a>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24">
        <section className="py-14 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl" style={{ color: theme.primary }}>
            {site.seo.title || site.slug}
          </h1>
          {site.tagline && (
            <p className="mx-auto mt-4 max-w-2xl text-lg text-stone-600">{site.tagline}</p>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {orderHref && (
              <a
                className="rounded-full px-7 py-3 text-base font-medium text-white shadow-sm"
                style={{ background: theme.primary }}
                href={orderHref}
              >
                {t('order')}
              </a>
            )}
            <a
              className="rounded-full border px-7 py-3 text-base font-medium"
              style={{ borderColor: theme.accent, color: theme.accent }}
              href="#reserve"
            >
              {t('reserve')}
            </a>
          </div>
        </section>

        {site.about && (
          <section className="border-t py-12" style={{ borderColor: `${theme.primary}22` }}>
            <h2 className="text-2xl font-semibold" style={{ color: theme.primary }}>{t('about')}</h2>
            <p className="mt-4 whitespace-pre-line leading-relaxed text-stone-700">{site.about}</p>
          </section>
        )}

        {products.length > 0 && has('menu') && (
          <section className="border-t py-12" style={{ borderColor: `${theme.primary}22` }}>
            <h2 className="text-2xl font-semibold" style={{ color: theme.primary }}>
              {site.sections.find((s) => s.kind === 'menu')?.heading || t('menu')}
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <article
                  key={product.id}
                  className="overflow-hidden rounded-2xl border bg-white"
                  style={{ borderColor: `${theme.primary}22` }}
                >
                  {product.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={product.image_url}
                      alt={product.name}
                      className="h-40 w-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium">{product.name}</h3>
                      <span className="shrink-0 font-semibold" style={{ color: theme.primary }}>
                        {fmtCurrency(Number(product.price), currency, locale)}
                      </span>
                    </div>
                    {product.description && (
                      <p className="mt-2 line-clamp-3 text-sm text-stone-600">{product.description}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {orderHref && (
              <a
                className="mt-6 inline-block rounded-full px-6 py-2.5 font-medium text-white"
                style={{ background: theme.primary }}
                href={orderHref}
              >
                {t('orderFull')}
              </a>
            )}
          </section>
        )}

        {site.sections
          .filter((section) => !['hero', 'about', 'menu', 'cta'].includes(section.kind))
          .map((section) => (
            <section
              key={section.id}
              className="border-t py-12"
              style={{ borderColor: `${theme.primary}22` }}
            >
              <h2 className="text-2xl font-semibold" style={{ color: theme.primary }}>{section.heading}</h2>
              <p className="mt-4 whitespace-pre-line leading-relaxed text-stone-700">{section.body}</p>
            </section>
          ))}

        <section
          id="reserve"
          className="mt-4 rounded-3xl border p-6 sm:p-10"
          style={{ borderColor: `${theme.primary}33`, background: `${theme.primary}08` }}
        >
          <h2 className="text-2xl font-semibold" style={{ color: theme.primary }}>{t('reserve')}</h2>
          <p className="mt-2 text-stone-600">{t('reserveHint')}</p>
          <SiteBookingForm slug={site.slug} primary={theme.primary} />
        </section>

        {(site.contact.phone || site.contact.address || site.contact.hours || site.contact.email) && (
          <section className="border-t py-12" style={{ borderColor: `${theme.primary}22` }}>
            <h2 className="text-2xl font-semibold" style={{ color: theme.primary }}>{t('contact')}</h2>
            <dl className="mt-4 grid gap-3 text-stone-700 sm:grid-cols-2">
              {site.contact.hours && (
                <div><dt className="text-sm text-stone-500">{t('hours')}</dt><dd>{site.contact.hours}</dd></div>
              )}
              {site.contact.phone && (
                <div>
                  <dt className="text-sm text-stone-500">{t('phone')}</dt>
                  <dd><a href={`tel:${site.contact.phone}`}>{site.contact.phone}</a></dd>
                </div>
              )}
              {site.contact.email && (
                <div>
                  <dt className="text-sm text-stone-500">{t('email')}</dt>
                  <dd><a href={`mailto:${site.contact.email}`}>{site.contact.email}</a></dd>
                </div>
              )}
              {site.contact.address && (
                <div><dt className="text-sm text-stone-500">{t('address')}</dt><dd>{site.contact.address}</dd></div>
              )}
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}
