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

/** 登录入口 = 落点提示。它不是权限，也不是第二套账号体系。 */
type Entry = 'owner' | 'staff';

const ENTRIES: { key: Entry; icon: typeof Store; labelKey: string; hintKey: string }[] = [
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
function homeForRole(role: string | null | undefined, entry: Entry): string {
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

function postLoginTarget(role: string | null | undefined, entry: Entry): string {
  return getNextParam() ?? homeForRole(role, entry);
}

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations('auth');
  const { session, login } = useSession();
  const [entry, setEntry] = useState<Entry>('owner');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        <p className="text-sm text-muted-foreground text-center">
          {t('noAccount')}{' '}
          <Link href="/auth/signup" className="underline text-primary">
            {t('signupLink')}
          </Link>
        </p>
      </form>
    </div>
  );
}
