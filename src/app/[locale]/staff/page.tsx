import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { StaffPwa } from '@/components/staff/StaffPwa';
import { routing } from '@/i18n/routing';
import type { StaffTab } from '@/components/staff/StaffShell';

/**
 * 员工端 PWA（`/{locale}/staff`）。
 *
 * ## 为什么这一层是服务端组件
 *
 * 与 `/store` 同一形态：locale 段要在服务端校验（与 `[locale]/layout.tsx` 同一套
 * `hasLocale`，非法段直接 404），`?tab=` 要在服务端收敛成受控枚举再交给客户端。
 * 页面本身不查库 —— 员工身份由 `/api/staff/me` 在客户端按会话 cookie 解析，
 * 服务端渲染时还没有请求上下文可言。
 *
 * ## 已知缺口：后台框架没有旁路 /staff（本次不得修改 app-shell.tsx）
 *
 * `src/components/layout/app-shell.tsx` 的旁路正则只有 `/\/store(\/|$)/`
 * （另加 `/auth`、落地页、`/site`）。任务书里写的"已经为 /staff 旁路"**与实际
 * 代码不符**，实测：
 *
 *     $ Select-String -Path src/components/layout/app-shell.tsx -Pattern 'isStore'
 *     24:  const isStore = /\/store(\/|$)/.test(pathname);
 *
 * 后果有两条，都已确认而非推测：
 *   1. 员工端会渲染在后台的 Topbar + Sidebar 框架**里面**（`<main class="p-6">`），
 *      而不是原型那种全屏 PWA 版式；
 *   2. `AppShell` 的会话守卫会对 `/staff` 生效（`isStore || isAuth || isLanding ||
 *      isPublicSite` 全为 false）—— 未登录访问 `/staff` 会被 `/api/auth/me` 的 401
 *      弹到登录页。
 *
 * 第 2 条对员工端是**正确**的（员工本来就必须先有会话）；第 1 条是版式问题。
 * 修法只有一行（把 `isStaff`/`isTeam` 加进那个正则与守卫条件），但该文件在本次
 * 任务的禁改清单里，因此这里如实记录、不动它。
 */

const TABS: readonly StaffTab[] = ['today', 'clock', 'shifts', 'deliveries', 'reservations', 'me'];

/** searchParams 的值可能是数组（?tab=a&tab=b），只取第一个。 */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 受控枚举收窄：不用 `as`，非法值一律当作未指定（默认 today）。 */
function parseTab(value: string | undefined): StaffTab | undefined {
  if (!value) return undefined;
  return TABS.find((tab) => tab === value);
}

export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const query = await searchParams;

  return <StaffPwa locale={locale} initialTab={parseTab(firstValue(query.tab)) ?? 'today'} />;
}
