'use client';

import React from 'react';
import {
  CalendarDays,
  Clock,
  Bike,
  CalendarCheck,
  User,
  LayoutDashboard,
} from 'lucide-react';
import { Locale } from '@/types';
import { getTranslations } from '@/lib/i18n';

/**
 * 员工端 PWA 外壳：内容区 + 底部六个 Tab。
 *
 * 与原型（_pwa-review/src/components/staff/StaffShell.tsx）的差异只有 import 形态，
 * 没有一处是重写：`../../types` → `@/types`、`../../lib/i18n` → `@/lib/i18n`。
 * 原型这一层本来就没有引入动画库、也没有用 Vite 那套环境变量写法，因此不需要
 * `usePresence` 之类的替换 —— 老实保留 1:1 是有意的：多改一处就多一处回归点。
 *
 * `'use client'` 是**必须**的：整个外壳是 onClick + 受控 Tab，
 * 漏掉这一行不会让构建失败，只会在浏览器控制台报错。
 */

export type StaffTab = 'today' | 'clock' | 'shifts' | 'deliveries' | 'reservations' | 'me';

interface StaffShellProps {
  currentTab: StaffTab;
  onSelectTab: (tab: StaffTab) => void;
  pendingDeliveriesCount?: number;
  pendingReservationsCount?: number;
  locale: Locale;
  children: React.ReactNode;
}

export const StaffShell: React.FC<StaffShellProps> = ({
  currentTab,
  onSelectTab,
  pendingDeliveriesCount = 0,
  pendingReservationsCount = 0,
  locale,
  children,
}) => {
  const t = getTranslations(locale);

  const tabs: { id: StaffTab; label: string; icon: React.FC<{ className?: string }>; badge?: number }[] = [
    { id: 'today', label: t.staff.nav_today, icon: LayoutDashboard },
    { id: 'clock', label: t.staff.nav_clock, icon: Clock },
    { id: 'shifts', label: t.staff.nav_shifts, icon: CalendarDays },
    {
      id: 'deliveries',
      label: t.staff.nav_deliveries,
      icon: Bike,
      badge: pendingDeliveriesCount > 0 ? pendingDeliveriesCount : undefined,
    },
    {
      id: 'reservations',
      label: t.staff.nav_reservations,
      icon: CalendarCheck,
      badge: pendingReservationsCount > 0 ? pendingReservationsCount : undefined,
    },
    { id: 'me', label: t.staff.nav_me, icon: User },
  ];

  return (
    <div className="rf-staff-shell min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans select-none antialiased">
      {/* Scrollable Staff Content Area */}
      <div className="flex-1 pb-24 max-w-md mx-auto w-full">{children}</div>

      {/* Mobile-first Bottom Navigation with iOS Safe Area Inset (§8) */}
      <nav
        id="staff-bottom-nav"
        className="rf-staff-nav fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-t border-slate-800/80 shadow-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <div className="max-w-md mx-auto grid grid-cols-6 h-15 items-center px-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className={`relative flex flex-col items-center justify-center py-1.5 transition ${
                  isActive
                    ? 'text-teal-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                id={`staff-tab-${tab.id}`}
              >
                <div className="relative">
                  <Icon className={`w-5 h-5 ${isActive ? 'scale-110' : ''} transition-transform`} />
                  {tab.badge != null && tab.badge > 0 && (
                    <span className="absolute -top-1 -right-2 bg-amber-500 text-slate-950 font-black text-[9px] w-4 h-4 rounded-full flex items-center justify-center border-2 border-slate-950">
                      {tab.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-[48px]">
                  {tab.label}
                </span>
                {isActive && (
                  <span className="absolute bottom-1 w-5 h-0.5 bg-teal-400 rounded-full" />
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
