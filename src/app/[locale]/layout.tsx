import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Inspector } from 'react-dev-inspector';
import { routing } from '@/i18n/routing';
import { AppShell } from '@/components/layout/app-shell';
import '../globals.css';

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
    <html lang={locale}>
      <body>
        <Inspector />
        <NextIntlClientProvider>
          <AppShell>{children}</AppShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
