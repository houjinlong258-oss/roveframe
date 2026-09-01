import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'zh', 'es'],
  defaultLocale: 'en',
  localePrefix: 'always',
});
