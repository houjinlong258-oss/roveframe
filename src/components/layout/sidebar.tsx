'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  LayoutDashboard, Bot, Brain, Star, Users, Megaphone, Mail, Database,
  CalendarDays, Settings, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', key: 'dashboard', icon: LayoutDashboard },
  { href: '/agent', key: 'agent', icon: Bot },
  { href: '/knowledge', key: 'knowledge', icon: Brain },
  { href: '/reviews', key: 'reviews', icon: Star },
  { href: '/customers', key: 'customers', icon: Users },
  { href: '/marketing', key: 'marketing', icon: Megaphone },
  { href: '/emails', key: 'emails', icon: Mail },
  { href: '/business', key: 'business', icon: Database },
  { href: '/reservations', key: 'reservations', icon: CalendarDays },
] as const;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-md font-medium text-sm transition-colors',
      active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    );

  const nav = (
    <>
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ href, key, icon: Icon }) => (
          <Link
            key={key}
            href={href}
            onClick={onClose}
            aria-current={pathname === href ? 'page' : undefined}
            className={linkClass(pathname === href)}
          >
            <Icon className="w-4 h-4" />
            {t(key)}
          </Link>
        ))}
      </nav>
      <div className="p-3 border-t border-border/20">
        <Link href="/settings" onClick={onClose} className={linkClass(pathname === '/settings')}>
          <Settings className="w-4 h-4" />
          {t('settings')}
        </Link>
      </div>
    </>
  );

  return (
    <>
      {/* 移动端遮罩 */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={onClose} />
      )}
      <aside
        className={cn(
          'w-56 shrink-0 bg-card border-r border-border/20 flex flex-col',
          'fixed z-50 inset-y-0 left-0 transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="md:hidden flex justify-end p-2">
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        {nav}
      </aside>
    </>
  );
}
