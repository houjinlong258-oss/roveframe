'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * PWA Offline Fallback Page (C-PWA-1.7)
 *
 * Service Worker (src/app/sw.ts) 在 navigation 失败时 fallback 到此页
 * 用户断网时看到此页 + 重连后 Retry
 */
export default function OfflinePage() {
  const t = useTranslations('pwa');
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  function onRetry() {
    if (isOnline) {
      window.location.reload();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center space-y-4">
        <div className="text-6xl">📡</div>
        <h1 className="text-2xl font-semibold">
          {isOnline ? t('somethingWrong') : t('offlineTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isOnline ? t('retryBody') : t('offlineBody')}
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <button
            onClick={onRetry}
            disabled={!isOnline}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('retry')}
          </button>
          <a
            href="/"
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('goHome')}
          </a>
        </div>
        <p className="text-xs text-muted-foreground/60 pt-4">
          {t('cacheHint')}
        </p>
      </div>
    </div>
  );
}
