'use client';

import React, { useEffect, useState } from 'react';
import { Download, X, Share, PlusSquare } from 'lucide-react';

/**
 * Phase 18 三端 PWA 的安装引导条。
 *
 * 为什么叫 `TierInstallPrompt` 而不是沿用原型的 `InstallPrompt`：
 * 仓库里已经有一个同名组件（`@/components/pwa/InstallPrompt`，走 next-intl +
 * localStorage 的 30 天静默期）。两者用途不同，同名导出在同一个目录下迟早
 * 会被 import 错，所以把"三端 PWA 专用"写进名字。
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface TierInstallPromptProps {
  appName?: string;
  className?: string;
}

export const TierInstallPrompt: React.FC<TierInstallPromptProps> = ({
  appName = 'RoveFrame',
  className = '',
}) => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSModal, setShowIOSModal] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Detect standalone mode (already installed)
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);

    // Detect iOS
    const ua = window.navigator.userAgent.toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod/.test(ua);
    setIsIOS(isAppleDevice);

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  if (isStandalone || dismissed) {
    return null;
  }

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    } else if (isIOS) {
      setShowIOSModal(true);
    } else {
      // Desktop / Other: prompt explanation
      alert(`To install ${appName} PWA, click the install icon (⊕) on your browser address bar.`);
    }
  };

  return (
    <>
      <div
        className={`flex items-center justify-between gap-3 bg-teal-900 text-teal-50 px-3.5 py-2.5 rounded-xl shadow-md text-xs font-medium ${className}`}
        id="pwa-install-banner"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-teal-800 flex items-center justify-center shrink-0 text-amber-300">
            <Download className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-white">安装 {appName} PWA</div>
            <div className="text-teal-200 text-[11px]">添加到手机主屏，离线可访问且操作更流畅</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleInstallClick}
            className="px-2.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold rounded-lg shadow transition text-[11px]"
            id="pwa-install-button"
          >
            立即安装
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 hover:bg-teal-800 text-teal-300 rounded-md transition"
            aria-label="Dismiss install prompt"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* iOS Safari Guided Modal */}
      {showIOSModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setShowIOSModal(false)}
        >
          <div
            className="bg-white text-slate-900 w-full max-w-xs rounded-2xl p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-semibold text-sm">在 iPhone / iPad 上安装</h3>
              <button
                onClick={() => setShowIOSModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-full"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ol className="text-xs text-slate-600 space-y-3">
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-800 font-bold flex items-center justify-center shrink-0 text-[11px]">1</span>
                <div>
                  在 Safari 底部工具栏点击 <Share className="w-3.5 h-3.5 inline text-teal-600 mx-0.5" /> <strong>分享</strong> 按钮。
                </div>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-800 font-bold flex items-center justify-center shrink-0 text-[11px]">2</span>
                <div>
                  向下滚动并轻点 <PlusSquare className="w-3.5 h-3.5 inline text-teal-600 mx-0.5" /> <strong>添加到主屏幕</strong>。
                </div>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-800 font-bold flex items-center justify-center shrink-0 text-[11px]">3</span>
                <div>轻点右上角 <strong>添加</strong> 即可在主屏幕随时开启。</div>
              </li>
            </ol>

            <button
              onClick={() => setShowIOSModal(false)}
              className="w-full py-2 bg-teal-700 text-white rounded-xl text-xs font-medium hover:bg-teal-800 transition"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
};
