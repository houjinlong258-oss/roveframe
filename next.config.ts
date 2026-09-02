import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withSerwistInit from '@serwist/next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

// PWA: Serwist 注入 service worker (C-PWA-1.2)
// 当前 disable=true(Sprint 1.4 写完 src/app/sw.ts 后改 false 启用)
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: true,
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

export default withSerwist(withNextIntl(nextConfig));
