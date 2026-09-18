import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { ThemeProvider } from '@/components/theme/theme-provider';

/**
 * `(marketing)` 路由组的布局（Phase 15）。
 *
 * 与 `[locale]/layout.tsx` 的区别只有一处：**不含 AppShell**。
 *
 * 为什么需要独立布局：`[locale]/layout.tsx` 给所有后台页面套上侧栏 + 顶栏，
 * 而落地页面向的是**还没有账号的访客** —— 给它一个"经营仪表盘侧栏"既无意义，
 * 又会触发会话守卫把人踢去登录页（那正是这次要修的行为）。
 *
 * 路由组 `(...)` 不进入 URL，因此落地页仍然是 `/<locale>`，
 * 与后台仪表盘 `/dashboard` 平级，无需改动任何现有页面。
 *
 * 主题脚本、`html`/`body`、i18n Provider 仍由外层 `[locale]/layout.tsx` 提供，
 * 这里只负责"不带后台框架"这一件事。
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function MarketingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <NextIntlClientProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </NextIntlClientProvider>
  );
}
