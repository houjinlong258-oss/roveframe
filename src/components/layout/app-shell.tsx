'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import { PushSubscribe } from '@/components/pwa/PushSubscribe';
import { redirectToLoginOn401 } from '@/lib/utils';

const SIDEBAR_STORAGE_KEY = 'roveframe.sidebar.collapsed';

/**
 * 应用外壳。
 *
 * 侧边栏支持**折叠为图标栏**（Ctrl/⌘ + B，偏好持久化）—— 工作台页面需要
 * 尽可能多的横向空间，把导航让位给内容比固定占 240px 更合理。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const isStore = /\/store(\/|$)/.test(pathname);
  const isAuth = /\/auth(\/|$)/.test(pathname);

  // 会话守卫：进入管理后台时验证会话，失效即 401 跳登录页
  useEffect(() => {
    if (isStore || isAuth) return;
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => {
        if (!cancelled) redirectToLoginOn401(res.status);
      })
      .catch(() => {
        // 网络故障不强制跳转，避免误踢
      });
    return () => {
      cancelled = true;
    };
  }, [isStore, isAuth]);

  // 折叠偏好：刷新后保持用户习惯
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1');
    } catch {
      // 隐私模式：忽略
    }
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // 忽略存储失败
      }
      return next;
    });
  }, []);

  // Ctrl/⌘ + B 切换侧边栏（在输入框里按不拦截，避免打断打字）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'b') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      event.preventDefault();
      toggleCollapse();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapse]);

  // H5 点餐商城面向顾客，独立全屏，不带管理后台框架
  if (isStore) {
    return (
      <>
        {children}
        <InstallPrompt />
      </>
    );
  }
  // 登录/注册页独立全屏（不带后台框架）
  if (isAuth) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen">
      <Topbar onMenuClick={() => setSidebarOpen(true)} />
      <div className="flex h-[calc(100vh-3.5rem)]">
        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
        />
        <main className="min-w-0 flex-1 overflow-y-auto bg-background p-6">{children}</main>
      </div>
      <InstallPrompt />
      <PushSubscribe />
    </div>
  );
}
