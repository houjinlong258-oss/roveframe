import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { OwnerPortal } from '@/components/owner/OwnerPortal';
import { routing } from '@/i18n/routing';

/**
 * 老板端「团队 / 考勤 / 关怀」（`/{locale}/team`）。
 *
 * ## 这里挂的是什么，不是什么
 *
 * 原型的 `OwnerPortal` 是一个 7 Tab 门户，其中 dashboard / analytics /
 * simulations 三个 Tab 全是写死的演示数字（固定的日期、六位数月营业额、
 * 12 条柱状高度数组、热门菜品榜单等），config Tab 走的是按演示 slug
 * 取站点配置的老接口。
 * **本次只挂 team + 考勤 + care**，另外四个 Tab 在
 * `@/components/owner/OwnerPortal` 里被整块移除（理由写在那个文件头上），
 * 所以这一层不需要额外的"薄包装"—— 挂上去的就只有那三个面。
 *
 * ## 后台既有的 20 个管理页一个都没动
 *
 * 这个路由是**新增**的（`src/app/[locale]/` 下原本没有 team/ 目录），
 * 侧边栏也没有指向它的入口。它不会替换、也不会遮挡 `/dashboard`、`/business`
 * 等既有页面 —— 老板端真正的经营与配置能力仍然在那 20 个页面上。
 *
 * ## 与 /staff 相同的已知缺口
 *
 * `app-shell.tsx` 的旁路正则只覆盖 `/store`，因此 `/team` 同样渲染在后台框架
 * 之内，并受会话守卫保护。对"店长/店东"这一角色来说会话守卫是必须的，
 * 版式的差异见 `src/app/[locale]/staff/page.tsx` 的同一段说明。
 */
export default async function TeamPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <OwnerPortal locale={locale} />;
}
