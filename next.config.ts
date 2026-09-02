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

// PWA: Serwist 注入 service worker (C-PWA-1.4b)
// 临时 disable=true:Serwist 9.5.12 与 Next.js 16 Turbopack 不兼容
// (issue https://github.com/serwist/serwist/issues/54),build 时 /offline 预渲染失败
// 启用时机: Serwist 官方支持 Turbopack 后改 disable: process.env.NODE_ENV === 'development'
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: true,
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

export default withSerwist(withNextIntl(nextConfig));
