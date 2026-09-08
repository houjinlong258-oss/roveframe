'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { Bell, Bot, Menu, Check, Globe } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RoveFrameLogo } from '@/components/layout/brand-logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { useTheme } from '@/components/theme/theme-provider';

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
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertOpen, setAlertOpen] = useState(false);
  const { resolved } = useTheme();

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
        <button className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-muted transition-colors">
          <span className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">R</span>
          <span className="text-sm font-medium">{t('topbar.owner')}</span>
        </button>
      </div>
    </header>
  );
}
