import type { MetadataRoute } from 'next';

/**
 * PWA Manifest (C-PWA-1.3)
 *
 * Next.js 16 自动从 src/app/manifest.ts 生成 /manifest.webmanifest
 * 浏览器通过 <link rel="manifest" href="/manifest.webmanifest"> 引用
 *
 * V1 通用 manifest(单域 app.roveframe.com + path 区分 customer/owner)
 * V2 子域路由上线后改为 /api/manifest/[slug] 动态 endpoint
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RoveFrame AI Business OS',
    short_name: 'RoveFrame',
    description: 'AI Restaurant Operating System for SMBs',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#000000',
    background_color: '#ffffff',
    lang: 'en',
    categories: ['business', 'food', 'productivity'],
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    // V1 i18n 提示(浏览器根据 navigator.language 选)
    // 实际 i18n 通过 start_url 后的页面切
    shortcuts: [
      {
        name: 'Menu',
        short_name: 'Menu',
        description: 'View today menu',
        url: '/store',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Dashboard',
        short_name: 'Dashboard',
        description: 'Owner dashboard',
        url: '/',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
    ],
  };
}
