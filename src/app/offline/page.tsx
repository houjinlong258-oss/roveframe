import { getTranslations } from 'next-intl/server';

/**
 * PWA Offline Fallback Page (C-PWA-1.7 简化版)
 *
 * Serwist fallbacks 指向 /offline 在 navigation 失败时
 *
 * V1 简化: server component(避免 'use client' + useEffect 在 Next.js 16 Turbopack
 * 预渲染时的兼容问题)。客户端状态(online/offline)由 page 内的 <script>
 * 标签运行时检测,刷新按钮用原生 form action="reload"。
 */
export default async function OfflinePage() {
  const t = await getTranslations('pwa');

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center space-y-4">
        <div className="text-6xl">📡</div>
        <h1 className="text-2xl font-semibold" id="offline-title">
          {t('offlineTitle')}
        </h1>
        <p className="text-sm text-muted-foreground" id="offline-body">
          {t('offlineBody')}
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <form>
            <button
              type="submit"
              className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
            >
              {t('retry')}
            </button>
          </form>
          <a
            href="/"
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('goHome')}
          </a>
        </div>
        <p className="text-xs text-muted-foreground/60 pt-4">{t('cacheHint')}</p>
      </div>
    </div>
  );
}
