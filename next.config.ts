import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withSerwistInit from '@serwist/next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.dev.coze.site'],
  // 产出 `.next/standalone/`：由 nft 追踪出的最小 node_modules + server 产物。
  // 动机是实测的体积：runner 阶段原先直接复制整个 `node_modules`（本机实测 728 MB），
  // 其中绝大多数（typescript / vitest / eslint / tailwind / tsup 等）在生产运行时
  // 一个都不会被 require。
  //
  // 注意两点，Dockerfile 里有对应处理：
  // 1. standalone 只含 node_modules 与 server 产物，**不含** `.next/static` 与 `public`，
  //    必须单独拷；漏掉的表现是 HTML 能出但静态资源 404。
  // 2. 生产入口仍是 `node dist/server.js`，**不是** standalone 自带的 server.js
  //    （后者会绕过 src/server.ts 里的 scheduler/migration/boot-check/限流断言）。
  //
  // 若构建时报某个包在 standalone 里解析不到：那是 nft 追踪漏项，用
  // `outputFileTracingIncludes` 补，而不是把整个 node_modules 拷回来
  // （Dockerfile 里有构建期断言会把这种漏项直接打红）。
  output: 'standalone',
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
