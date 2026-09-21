import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { StaffLoginForm } from '@/components/auth/staff-login-form';
import { routing } from '@/i18n/routing';

/**
 * 员工登录（`/{locale}/staff/login`）—— 规格里要求的独立路由。
 *
 * ## 与 `/{locale}/auth/login` 的关系
 *
 * 同一套账号、同一个表单组件（`StaffLoginForm`），差别只有两点：
 *
 *   1. **默认选中「员工」入口**：员工从门店群里点开的链接应该一进来就是员工侧；
 *   2. **不显示"注册"链接**：注册会建一个新租户 + 新商家，员工点了它只会
 *      开出一家空店，而他要做的是加入**现有**门店。给他注册入口是把他引到错误的方向。
 *
 * 为什么不复制一份页面：见组件文件头。这个仓库的"两条路径"缺陷
 * （UI 判定 vs worker 判定）已经修过两次，不打算再制造第三处。
 *
 * ## 为什么这一层是服务端组件
 *
 * 与 `/staff` 同一形态：locale 段要在服务端校验（沿用 `[locale]/layout.tsx`
 * 同一套 `hasLocale`，非法段 404），页面本身不查库 —— 身份由会话 cookie
 * 在客户端解析。
 */
export default async function StaffLoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <StaffLoginForm defaultEntry="staff" showSignupLink={false} />;
}
