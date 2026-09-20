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
  /**
   * 落地页（`/<locale>`）也不带后台框架（Phase 15）。
   *
   * 为什么在这里判断而不是靠 `(marketing)` 路由组：Next 的嵌套布局是**叠加**的，
   * 路由组只能"加"，不能把父级 `[locale]/layout.tsx` 里的 AppShell 去掉。
   * 落地页面向还没有账号的访客，给它一个经营仪表盘侧栏既无意义，
   * 又会触发下面的会话守卫把人踢去登录页 —— 那正是要修的行为。
   *
   * 匹配两种形态：`usePathname()` 在本项目里可能返回带 locale 的
   * `/en`，也可能是去掉 locale 的 `/`（next-intl 的导航包装会影响它）。
   * 只认一种会漏判 —— 实测漏判的后果是首屏仍带侧栏。
   */
  const isLanding = pathname === '/' || /^\/(en|zh|es)\/?$/.test(pathname);
  /**
   * 商户官网（`/<locale>/site/<slug>`）同样是公开页面（Phase 17）。
   *
   * 它由搜索引擎、名片、二维码进入，访客没有会话。不旁路的话下面的守卫会
   * 把每一个官网访客弹到登录页 —— 那等于官网不存在。
   */
  const isPublicSite = /\/site(\/|$)/.test(pathname);
  /**
   * 员工端（`/<locale>/staff`）是**独立的 PWA**，不复用后台外壳（Phase 18）。
   *
   * 订正：施工简报里写过"app-shell 已经旁路了 /staff" —— 那是错的。
   * 实测（从源码提取正则逐个求值，阳性对照 `/en/store` → BYPASSED）显示
   * `/en/staff` 会落进后台框架并触发会话守卫。此前加的是 `/site`（Phase 17 官网），
   * 两者记串了。
   *
   * 为什么连**守卫**一起旁路，而不只是外壳：员工 PWA 自带登录界面。
   * 守卫先跳商家登录页的话，员工永远看不到自己那个入口。
   * 这不是放宽安全边界 —— 真正的边界在 API 侧
   * （`staffRequestContext` 返回 401/403/409，见 src/lib/workforce.ts），
   * 本文件头部也写明"proxy 是网络边界而非唯一鉴权点"。
   */
  const isStaff = /\/staff(\/|$)/.test(pathname);

  // 会话守卫：进入管理后台时验证会话，失效即 401 跳登录页
  useEffect(() => {
    if (isStore || isAuth || isLanding || isPublicSite || isStaff) return;
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
  }, [isStore, isAuth, isLanding, isPublicSite, isStaff]);

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
  // 落地页独立全屏：面向未登录访客，不套后台侧栏（Phase 15）
  if (isLanding) {
    return <>{children}</>;
  }
  // 商户官网独立全屏：公开页面，无会话（Phase 17）
  if (isPublicSite) {
    return <>{children}</>;
  }
  // 员工端独立全屏：自带登录界面与底部导航，不复用后台外壳（Phase 18）
  if (isStaff) {
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
