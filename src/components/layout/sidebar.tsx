'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  LayoutDashboard, Bot, Brain, Star, Users, Megaphone, Mail, Database,
  CalendarDays, Settings, X, ShieldCheck, GitPullRequest, ScrollText, FolderOpen,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoveFrameLogo } from '@/components/layout/brand-logo';

/** Workspace 分组：让侧边栏表达「工作台」而不是一串页面清单 */
const NAV_GROUPS = [
  {
    key: 'workspace',
    items: [
      { href: '/', key: 'dashboard', icon: LayoutDashboard },
      { href: '/agent', key: 'agent', icon: Bot },
      { href: '/files', key: 'files', icon: FolderOpen },
    ],
  },
  {
    key: 'operations',
    items: [
      { href: '/knowledge', key: 'knowledge', icon: Brain },
      { href: '/reviews', key: 'reviews', icon: Star },
      { href: '/customers', key: 'customers', icon: Users },
      { href: '/marketing', key: 'marketing', icon: Megaphone },
      { href: '/emails', key: 'emails', icon: Mail },
      { href: '/business', key: 'business', icon: Database },
      { href: '/reservations', key: 'reservations', icon: CalendarDays },
    ],
  },
  {
    key: 'governance',
    items: [
      { href: '/approvals', key: 'approvals', icon: ShieldCheck },
      { href: '/audit', key: 'audit', icon: ScrollText },
      { href: '/enterprise/approvals', key: 'enterpriseApprovals', icon: GitPullRequest },
    ],
  },
] as const;

export function Sidebar({
  open,
  onClose,
  collapsed = false,
  onToggleCollapse,
}: {
  open: boolean;
  onClose: () => void;
  /** 图标模式：只占 56px，把横向空间让给工作区 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  const linkClass = (active: boolean) =>
    cn(
      'group relative flex items-center rounded-md font-medium text-sm transition-colors duration-300',
      collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5',
      active
        ? 'bg-[#1A1A1A] text-[#A7FF00] font-semibold'
        : 'text-[#A0A0A0] hover:bg-[#1A1A1A] hover:text-[#F7F5F0]',
    );

  const nav = (
    <>
      <div
        className={cn(
          'hidden items-center border-b border-[#262626] md:flex',
          collapsed ? 'justify-center px-2 py-4' : 'gap-2 px-5 py-4',
        )}
      >
        {collapsed
          ? <RoveFrameLogo variant="monogram" darkMode={true} />
          : <RoveFrameLogo variant="primary" size="md" darkMode={true} />}
      </div>

      <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'space-y-2 p-2' : 'space-y-4 p-3')}>
        {NAV_GROUPS.map((group) => (
          <div key={group.key} className="space-y-1">
            {collapsed ? (
              <div className="mx-auto my-1 h-px w-6 bg-[#262626]" />
            ) : (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-[#5C5C5C]">
                {t(`group.${group.key}`)}
              </p>
            )}
            {group.items.map(({ href, key, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={key}
                  href={href}
                  onClick={onClose}
                  aria-current={active ? 'page' : undefined}
                  /* 折叠态用原生 title 提示：悬停即知，不引入额外浮层依赖 */
                  title={collapsed ? t(key) : undefined}
                  className={linkClass(active)}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{t(key)}</span>}
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-[#A7FF00]" />
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={cn('border-t border-[#262626]', collapsed ? 'p-2' : 'p-3')}>
        <Link
          href="/settings"
          onClick={onClose}
          title={collapsed ? t('settings') : undefined}
          className={linkClass(pathname === '/settings')}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">{t('settings')}</span>}
        </Link>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
            className={cn(
              'mt-1 hidden w-full items-center rounded-md text-[#8A8A8A] transition-colors duration-300 hover:bg-[#1A1A1A] hover:text-[#F7F5F0] md:flex',
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5',
            )}
          >
            {collapsed
              ? <PanelLeftOpen className="h-4 w-4 shrink-0" />
              : <PanelLeftClose className="h-4 w-4 shrink-0" />}
            {!collapsed && (
              <span className="flex flex-1 items-center text-left text-sm">
                {t('collapseSidebar')}
                <kbd className="ml-2 rounded border border-[#333] px-1 py-0.5 text-[10px] text-[#8A8A8A]">
                  Ctrl B
                </kbd>
              </span>
            )}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* 移动端遮罩 */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 md:hidden" onClick={onClose} />
      )}
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-[#262626] bg-[#0D0D0D] text-[#F7F5F0]',
          'transition-[width,transform] duration-300 ease-out',
          collapsed ? 'w-14' : 'w-60',
          'fixed inset-y-0 left-0 z-50 md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-[#262626] p-3 md:hidden">
          <RoveFrameLogo variant="primary" size="sm" darkMode={true} />
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[#1F1F1F]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {nav}
      </aside>
    </>
  );
}
