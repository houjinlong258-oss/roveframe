'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // H5 点餐商城面向顾客，独立全屏，不带管理后台框架
  if (/\/store(\/|$)/.test(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen">
      <Topbar onMenuClick={() => setSidebarOpen(true)} />
      <div className="flex h-[calc(100vh-3.5rem)]">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">{children}</main>
      </div>
    </div>
  );
}
