'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSession } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { Store, CircleUser } from 'lucide-react';

/**
 * 登录表单 —— 老板端与员工端**共用同一个组件**。
 *
 * ## 为什么抽出来（Phase 18）
 *
 * 规格里 `/{locale}/staff/login` 是**独立路由**，而实现只有
 * `/{locale}/auth/login` 一个页面。两条路走同一个表单，差别只有两个：
 *
 *   1. **默认选中的入口**（员工端默认 staff，老板端默认 owner；
 *      深链 `?entry=` 可覆盖）；
 *   2. **是否显示"没有账号？注册"** —— 员工**不能自助注册**：
 *      注册会建一个新租户 + 新商家，员工点了它就会开出一家空店，
 *      而他要的只是加入现有门店。
 *
 * 复制一份页面来改是最省事的做法，但那会让"登录逻辑"出现两份，
 * 后面任何一次改动都要改两处 —— 这个仓库已经因为"同一件事有两条路径"
 * 栽过（UI 判定 vs worker 判定）。所以只有这两处差异用参数表达。
 */

/** 登录入口 = 落点提示。它不是权限，也不是第二套账号体系。 */
export type LoginEntry = 'owner' | 'staff';

const ENTRIES: { key: LoginEntry; icon: typeof Store; labelKey: string; hintKey: string }[] = [
  { key: 'owner', icon: Store, labelKey: 'entryOwner', hintKey: 'entryOwnerHint' },
  { key: 'staff', icon: CircleUser, labelKey: 'entryStaff', hintKey: 'entryStaffHint' },
];

/**
 * 角色 → 该角色自己的主页。
 *
 * **入口是提示，服务端的角色才是事实。** 点「员工」不等于"我是员工"：
 * 标签只是用户对自己的描述，角色由 `public.users.role` 决定（登录接口按会话解析后返回）。
 * 两者不一致时以角色为准 —— 否则一个 owner 点错标签就会被送去员工端，
 * 而员工端点错标签会撞上后台页面里的 403，看起来像"登录坏了"。
 */
function homeForRole(role: string | null | undefined, entry: LoginEntry): string {
  if (role === 'owner' || role === 'manager') return '/dashboard';
  if (role === 'staff') return '/staff';
  // 角色缺失（接口没返回 / 老账号）时才退回入口提示，且明确标注这是兜底而非判定
  return entry === 'staff' ? '/staff' : '/dashboard';
}

/**
 * 登录后回跳：仅接受站内路径（防开放式重定向），事件期读 window 无 hydration 风险。
 *
 * 深链优先于角色主页：AppShell 的 401 守卫跳转时带的是 `?next=<原路径>`，
 * 忽略它会让用户登录后落在仪表盘，而不是他本来要打开的页面。
 */
function getNextParam(): string | null {
  if (typeof window === 'undefined') return null;
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return null;
}

/** 深链 `?entry=staff` 可覆盖默认入口（员工把链接存成书签时用得上）。 */
function getEntryParam(fallback: LoginEntry): LoginEntry {
  if (typeof window === 'undefined') return fallback;
  const value = new URLSearchParams(window.location.search).get('entry');
  return value === 'staff' || value === 'owner' ? value : fallback;
}

function postLoginTarget(role: string | null | undefined, entry: LoginEntry): string {
  return getNextParam() ?? homeForRole(role, entry);
}

export interface LoginFormProps {
  /** 默认选中的入口。员工端路由传 'staff'。 */
  defaultEntry?: LoginEntry;
  /**
   * 是否显示"没有账号？注册"。
   *
   * 员工端必须为 false：注册建的是**新租户 + 新商家**，
   * 员工点进去只会开出一家空店，而他要做的是加入现有门店。
   */
  showSignupLink?: boolean;
}

export function StaffLoginForm({ defaultEntry = 'owner', showSignupLink = true }: LoginFormProps) {
  const router = useRouter();
  const t = useTranslations('auth');
  const { session, login } = useSession();
  const [entry, setEntry] = useState<LoginEntry>(defaultEntry);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 深链 ?entry= 覆盖默认入口。放在 effect 里（不在渲染期读 window）以避免 hydration 不一致。
  useEffect(() => {
    const fromQuery = getEntryParam(defaultEntry);
    if (fromQuery !== defaultEntry) setEntry(fromQuery);
  }, [defaultEntry]);

  // 已登录时直接送走：用会话里的角色而不是当前选中的入口
  useEffect(() => {
    if (session) router.replace(postLoginTarget(session.role, entry));
  }, [session, router, entry]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await login(email, password);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // 用**接口返回的** role 决定去向，而不是刚刚点过的那个标签
    router.replace(postLoginTarget(res.role, entry));
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t('loginTitle')}</h1>

        {/* 身份入口：两个入口共用同一套账号密码（系统里只有一套认证），
            它只决定登录成功后的落点。 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('entryTitle')}</p>
          <div className="grid grid-cols-2 gap-2">
            {ENTRIES.map((option) => {
              const active = entry === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setEntry(option.key)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
                    active
                      ? 'border-primary bg-primary/10 text-on-surface'
                      : 'border-border/40 text-on-surface-variant hover:bg-muted',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <option.icon className="h-3.5 w-3.5" />
                    {t(option.labelKey)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{t(option.hintKey)}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground/70">{t('entryNote')}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{t('email')}</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('password')}</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? t('submitting') : t('login')}
        </Button>
        {showSignupLink && (
          <p className="text-sm text-muted-foreground text-center">
            {t('noAccount')}{' '}
            <Link href="/auth/signup" className="underline text-primary">
              {t('signupLink')}
            </Link>
          </p>
        )}
      </form>
    </div>
  );
}
