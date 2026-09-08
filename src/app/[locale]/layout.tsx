import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Inspector } from 'react-dev-inspector';
import { routing } from '@/i18n/routing';
import { AppShell } from '@/components/layout/app-shell';
import { ThemeProvider } from '@/components/theme/theme-provider';
import '../globals.css';

// 首屏防闪烁： hydration 前按 localStorage 偏好 / 本地时间（06:00–18:00 为昼）解析主题
// 顾客端 H5 点餐商城（/store）保持品牌固定样式，不随主题切换
const THEME_INIT_SCRIPT = `(function(){try{if(/\\/store(\\/|$)/.test(location.pathname))return;var m=localStorage.getItem('roveframe-theme')||'system';var h=new Date().getHours();var r=m==='system'?(h>=6&&h<18?'light':'dark'):m;var d=document.documentElement;if(r==='dark'){d.classList.add('dark')}else{d.classList.remove('dark')}}catch(e){}})();`;

export const metadata: Metadata = {
  title: {
    default: 'RoveFrame | AI Business OS',
    template: '%s | RoveFrame',
  },
  description: 'AI COO platform for SMBs — 24/7 intelligent operations assistant.',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
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
    <html lang={locale} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Inspector />
        <NextIntlClientProvider>
          <ThemeProvider>
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
