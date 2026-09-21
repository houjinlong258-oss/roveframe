import { StaffLoginForm } from '@/components/auth/staff-login-form';

/**
 * 老板/员工登录（`/{locale}/auth/login`）。
 *
 * 表单本身在 `@/components/auth/staff-login-form`：员工端路由
 * `/{locale}/staff/login` 复用**同一个**组件，只换默认入口与是否显示注册链接。
 * 两份登录页面代码必然漂移（这个仓库已经因为"同一件事两条路径"栽过）。
 */
export default function LoginPage() {
  return <StaffLoginForm defaultEntry="owner" showSignupLink />;
}
