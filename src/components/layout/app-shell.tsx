'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import { PushSubscribe } from '@/components/pwa/PushSubscribe';
import { redirectToLoginOn401 } from '@/lib/utils';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">{children}</main>
      </div>
      <InstallPrompt />
      <PushSubscribe />
    </div>
  );
}
