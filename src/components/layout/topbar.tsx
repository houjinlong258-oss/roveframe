'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { Bell, Bot, Menu, Check, Globe, LogOut, CircleUser, TriangleAlert } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RoveFrameLogo } from '@/components/layout/brand-logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { useTheme } from '@/components/theme/theme-provider';
import { useSession } from '@/hooks/use-session';

type Alert = {
  id: string;
  type: string;
  title: string;
  content: string;
  is_read: boolean;
  created_at: string;
};

const ALERT_COLORS: Record<string, string> = {
  review: 'bg-destructive',
  customer: 'bg-warning',
  order: 'bg-primary',
  inventory: 'bg-warning',
  email: 'bg-primary',
};

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const t = useTranslations();
  const ta = useTranslations('account');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertOpen, setAlertOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const { resolved } = useTheme();
  // 身份由 useSession 内部请求 `/api/auth/me` 得到（与 AppShell 的会话守卫同一个接口）。
  // 不在这里自己再 fetch 一次：那样同一个身份会有两个事实来源，登出后两者还可能不同步。
  const { session } = useSession();

  useEffect(() => {
    fetch('/api/alerts?unread=true')
      .then((r) => r.json())
      .then((d) => setAlerts(d.alerts ?? []))
      .catch(() => {});
  }, [alertOpen]);

  const unreadCount = alerts.filter((a) => !a.is_read).length;

  const markAllRead = async () => {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
  };

  const switchLocale = (next: string) => {
    router.replace(pathname, { locale: next });
  };

  /**
   * 退出（= 切换账号）。
   *
   * ## 为什么必须检查响应而不是 `void fetch(...)`
   *
   * 会话凭据是 HttpOnly cookie，前端**看不到**它。若服务端清 cookie 失败而前端照样
   * 跳登录页，用户看到的是"已退出"，实际下一次请求仍带着有效会话 ——
   * 在共用收银台的场景里，这等于把上一个人的账号留在下一个人手里。
   * 所以：只有响应 ok 才跳转；失败就把错误留在界面上，会话保持原样。
   *
   * ## 为什么只有一个菜单项
   *
   * "退出登录"与"切换账号"在本系统里是**同一个动作**（清掉当前会话 cookie）。
   * 摆两个按钮会让人以为差别在哪，于是每个都点一次。这里用一个标签把两种意图
   * 都写清楚：`Sign out & switch account`。
   */
  const signOut = async () => {
    setSignOutError('');
    setSigningOut(true);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        setSignOutError(ta('signOutFailed'));
        return;
      }
      // i18n router 会自动补 locale 前缀，实际去向是 `/{locale}/auth/login`
      router.push('/auth/login');
      router.refresh();
    } catch {
      setSignOutError(ta('signOutFailed'));
    } finally {
      setSigningOut(false);
    }
  };

  // 角色只认这三个值：接口（resolveUserByToken）也只放行这三个，
  // 但这里仍做一次收窄 —— 拿不到的键名去调 t() 会抛 MISSING_MESSAGE 把整个顶栏搞崩。
  const role = session?.role === 'owner' || session?.role === 'manager' || session?.role === 'staff'
    ? session.role
    : null;
  const displayName = session?.name?.trim() || session?.email?.split('@')[0] || t('topbar.owner');
  const initial = (session?.name?.trim() || session?.email || 'R').slice(0, 1).toUpperCase();

  return (
    <header className="bg-card sticky top-0 z-40 h-14 flex items-center justify-between px-5 border-b border-border/20">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="md:hidden w-9 h-9 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground"
        >
          <Menu className="w-4.5 h-4.5" />
        </button>
        <Link href="/" className="flex items-center gap-2.5">
          <span className="hidden sm:inline-flex">
            <RoveFrameLogo variant="primary" size="md" darkMode={resolved === 'dark'} />
          </span>
          <span className="sm:hidden">
            <RoveFrameLogo variant="monogram" size="md" darkMode={resolved === 'dark'} />
          </span>
          <span className="text-[10px] font-extrabold tracking-wider text-[#0D0D0D] bg-[#A7FF00] px-1.5 py-0.5 rounded-sm uppercase">
            AI OS
          </span>
        </Link>
      </div>
      <div className="flex items-center gap-3">
        {/* 主题切换：Light / Dark / System（本地时间自动） */}
        <ThemeToggle />
        {/* 语言切换 */}
        <DropdownMenu>
          <DropdownMenuTrigger className="w-9 h-9 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            <Globe className="w-4.5 h-4.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {[
              { code: 'en', label: 'English' },
              { code: 'zh', label: '中文' },
              { code: 'es', label: 'Español' },
            ].map((l) => (
              <DropdownMenuItem key={l.code} onClick={() => switchLocale(l.code)} className="flex items-center justify-between">
                {l.label}
                {locale === l.code && <Check className="w-3.5 h-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 实时告警 */}
        <Popover open={alertOpen} onOpenChange={setAlertOpen}>
          <PopoverTrigger className="relative w-9 h-9 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            <Bell className="w-4.5 h-4.5" />
            {unreadCount > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
              <span className="text-sm font-semibold">{t('topbar.alerts')}</span>
              <button onClick={markAllRead} className="text-xs text-primary hover:underline">{t('topbar.markAllRead')}</button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {alerts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('topbar.noAlerts')}</p>
              ) : (
                alerts.slice(0, 8).map((a) => (
                  <div key={a.id} className="flex gap-3 px-4 py-3 border-b border-border/10 last:border-0">
                    <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${a.is_read ? 'bg-border' : (ALERT_COLORS[a.type] ?? 'bg-primary')}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{a.title}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{a.content}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
        <span className="w-px h-5 bg-border" />
        {/* 退出失败必须看得见：放在菜单**外面**，菜单收起后依然留在顶栏上 */}
        {signOutError && (
          <span className="hidden sm:flex items-center gap-1.5 text-xs font-medium text-destructive max-w-[14rem]">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{signOutError}</span>
          </span>
        )}
        {/* 账号菜单：身份（姓名 / 邮箱 / 角色）+ 退出并切换账号 */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={ta('menuLabel')}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-muted transition-colors"
          >
            <span className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
              {initial}
            </span>
            <span className="text-sm font-medium max-w-[8rem] truncate hidden sm:inline">{displayName}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="space-y-0.5 font-normal">
              <p className="text-sm font-medium truncate">{displayName}</p>
              {session?.email && (
                <p className="text-xs text-muted-foreground truncate">{session.email}</p>
              )}
              {role && (
                <p className="text-[11px] text-muted-foreground">
                  {ta('role')} · {ta(`roles.${role}`)}
                </p>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={signOut}
              disabled={signingOut}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="w-3.5 h-3.5" />
              {ta('switchAccount')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/settings')}>
              <CircleUser className="w-3.5 h-3.5" />
              {t('nav.settings')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
