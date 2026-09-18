'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useSession } from '@/hooks/use-session';
import { LandingPage } from '@/components/marketing/landing-page';

/**
 * 落地页（公开可见）。
 *
 * ## 背景（Phase 15）
 *
 * 此前 `/` 就是仪表盘，未登录访客会被 AppShell 的会话守卫 `401 → 跳登录页`。
 * 结果是**产品对外没有一句话介绍** —— 访客打开域名直接被要求登录，
 * 不知道这是什么、给谁用、值多少钱。对一个要卖出去的 SaaS 这是明确缺口。
 *
 * ## 现在
 *
 * | 访问者 | 行为 |
 * |---|---|
 * | 未登录访客 | 直接看到落地页（无需登录，无后台框架） |
 * | 已登录商家 | 自动进入 `/dashboard`（经营仪表盘） |
 *
 * 后台页面（仪表盘及其余 19 页）保留在 `[locale]` 布局里，仍由 AppShell
 * 提供侧栏与顶栏 —— 落地页放在 `(marketing)` 路由组，因此**不带**后台框架。
 * 这样两种界面的外壳天然分离，不需要在 AppShell 里加"当前是不是落地页"的判断。
 */
export default function HomePage() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading && session) router.replace('/dashboard');
  }, [loading, session, router]);

  // 已登录时正在跳转：留白避免闪一下落地页
  if (loading || session) {
    return <div className="min-h-screen bg-background" aria-busy="true" />;
  }
  return <LandingPage />;
}
