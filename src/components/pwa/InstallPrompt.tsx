'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * PWA Install Prompt (C-PWA-1.5)
 *
 * 触发条件:
 * - Android Chrome: 'beforeinstallprompt' 事件(SW 注册 + manifest 通过)
 * - iOS Safari: 检测 standalone 模式 + UA(不能拦截,只给提示)
 *
 * 用户点了"安装"或"关闭"后 30 天内不再弹(localStorage)
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'roveframe:pwa:install-dismissed';
const DISMISS_DAYS = 30;

export function InstallPrompt() {
  const t = useTranslations('pwa');
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iOS, setIOS] = useState(false);

  useEffect(() => {
    // 已装过 → 不弹
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // @ts-expect-error iOS Safari 私有属性
      Boolean(navigator.standalone);
    if (isStandalone) return;

    // 30 天内用户点过关闭 → 不弹
    try {
      const dismissedAt = localStorage.getItem(DISMISS_KEY);
      if (dismissedAt && Date.now() - Number(dismissedAt) < DISMISS_DAYS * 86400000) {
        return;
      }
    } catch {
      // localStorage 不可用,继续
    }

    // Android Chrome / Edge
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // iOS Safari(不能拦截,只给提示)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    if (isIOS && isSafari) {
      setIOS(true);
      setVisible(true);
    }

    // 用户点安装 + 装完
    const onAppInstalled = () => {
      setVisible(false);
      setDeferred(null);
    };
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  async function onInstall() {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
    } else {
      // 关闭:记 30 天
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* noop */ }
    }
    setDeferred(null);
  }

  function onDismiss() {
    setVisible(false);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* noop */ }
  }

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:max-w-sm z-50 bg-card border border-border rounded-lg shadow-lg p-4"
      role="dialog"
      aria-live="polite"
    >
      <p className="text-sm font-semibold mb-1">{t('installTitle')}</p>
      <p className="text-xs text-muted-foreground mb-3">
        {iOS ? t('installIOSBody') : t('installAndroidBody')}
      </p>
      <div className="flex gap-2">
        {!iOS && (
          <button
            onClick={onInstall}
            className="flex-1 px-3 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
          >
            {t('install')}
          </button>
        )}
        <button
          onClick={onDismiss}
          className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('dismiss')}
        </button>
      </div>
    </div>
  );
}
