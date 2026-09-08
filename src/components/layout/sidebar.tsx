'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  LayoutDashboard, Bot, Brain, Star, Users, Megaphone, Mail, Database,
  CalendarDays, Settings, X, ShieldCheck, GitPullRequest, ScrollText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoveFrameLogo } from '@/components/layout/brand-logo';

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
  { href: '/approvals', key: 'approvals', icon: ShieldCheck },
  { href: '/audit', key: 'audit', icon: ScrollText },
  { href: '/enterprise/approvals', key: 'enterpriseApprovals', icon: GitPullRequest },
] as const;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-md font-medium text-sm transition-colors',
      active
        ? 'bg-[#1A1A1A] text-[#A7FF00] font-semibold border-l-2 border-[#A7FF00]'
        : 'text-[#A0A0A0] hover:bg-[#1A1A1A] hover:text-[#F7F5F0]'
    );

  const nav = (
    <>
      <div className="hidden md:flex items-center gap-2 px-5 py-4 border-b border-[#262626]">
        <RoveFrameLogo variant="primary" size="md" darkMode={true} />
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
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
      <div className="p-3 border-t border-[#262626]">
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
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} />
      )}
      <aside
        className={cn(
          'w-60 shrink-0 bg-[#0D0D0D] border-r border-[#262626] flex flex-col text-[#F7F5F0]',
          'fixed z-50 inset-y-0 left-0 transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="md:hidden flex justify-between items-center p-3 border-b border-[#262626]">
          <RoveFrameLogo variant="primary" size="sm" darkMode={true} />
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-[#1F1F1F] flex items-center justify-center text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        {nav}
      </aside>
    </>
  );
}
