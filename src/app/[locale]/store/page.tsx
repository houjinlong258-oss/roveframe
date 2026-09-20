import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { CustomerPwa } from '@/components/customer/CustomerPwa';
import { routing } from '@/i18n/routing';
import { resolvePublicStore } from '@/lib/storefront';
import { getSiteForBusiness } from '@/lib/public-site';
import type { CustomerMode } from '@/types';

/**
 * 顾客端 PWA 点餐商城（默认门面）。
 *
 * ## 为什么这一层是服务端组件
 *
 * 顾客的入口是**印在桌上的二维码**：`/{locale}/store?token=<qr-token>`。
 * token 是唯一能定位"哪家店、哪张桌"的东西，而把 token 换成商家上下文需要
 * 服务端能力（`resolvePublicStore` 走的是只读库）。放服务端做三件事：
 *
 *   1. 校验 locale 段（与 layout 同一套 hasLocale，非法段直接 404）；
 *   2. 由 token 反查该商家**已发布**的官网 slug —— 站点配置接口是按 slug 取的，
 *      而顾客 URL 里没有 slug。查不到就不传：客户端会退化成堂食 / 菜单两种模式，
 *      不会因为没有配送规则而显示一个假的"0 元配送费"；
 *   3. 把 `?mode=` 收敛成受控枚举再交给客户端。
 *
 * ## 必须保持兼容的东西
 *
 * `/{locale}/store?token=<qr-token>` 是**已经印出去的**二维码地址，不能改路径、
 * 不能改参数名。`?mode=` 沿用原型语义（dine_in / delivery / booking / menu），
 * 非法值按 dine_in 处理。`/store` 已由 AppShell 正则旁路后台框架。
 *
 * ## 为什么 force-dynamic
 *
 * 页面读了 searchParams、又查了一次库（slug 反查），构建期不该也不需要预渲染它；
 * 否则 `next build` 会在没有请求上下文时打库。
 */
export const dynamic = 'force-dynamic';

const MODES: readonly CustomerMode[] = ['dine_in', 'delivery', 'booking', 'menu'];

/** searchParams 的值可能是数组（?token=a&token=b），只取第一个。 */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 受控枚举收窄：不用 `as`，非法值一律当作未指定。 */
function parseMode(value: string | undefined): CustomerMode | undefined {
  if (!value) return undefined;
  return MODES.find((mode) => mode === value);
}

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const query = await searchParams;
  const token = firstValue(query.token);

  // token → (tenant, business) → 已发布官网 slug。
  // 任一步查不到都只是"没有站点配置"，不是错误：扫码顾客本来就不该被要求
  // 先有一个已发布的官网。`resolvePublicStore` 内部把库错误收敛成 null。
  const store = token ? await resolvePublicStore(token) : null;
  const site = store ? await getSiteForBusiness(store.tenantId, store.businessId) : null;
  const slug = site?.enabled ? site.slug : undefined;

  return (
    <CustomerPwa
      locale={locale}
      token={token}
      slug={slug}
      initialMode={parseMode(firstValue(query.mode)) ?? 'dine_in'}
    />
  );
}
