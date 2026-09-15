'use client';

import { useTranslations } from 'next-intl';
import { BarChart3, FolderOpen, ListChecks, Menu, MessageSquare, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceMode } from '@/components/workspace/types';

const MODE_ICON: Record<WorkspaceMode, typeof MessageSquare> = {
  chat: MessageSquare,
  tasks: ListChecks,
  files: FolderOpen,
  insights: BarChart3,
};

const MODES: WorkspaceMode[] = ['chat', 'tasks', 'files', 'insights'];

/**
 * 移动端底部导航。
 *
 * 手机上不做「三栏挤压」——只保留主内容 + 底部模式切换，
 * 侧栏与指挥中心改为左右滑出的抽屉（AppShell 负责遮罩）。
 */
export function MobileNav({
  mode,
  onModeChange,
  onOpenSidebar,
  onOpenCommand,
  pendingApprovals,
  className,
}: {
  mode: WorkspaceMode;
  onModeChange: (next: WorkspaceMode) => void;
  onOpenSidebar: () => void;
  onOpenCommand: () => void;
  pendingApprovals: number;
  className?: string;
}) {
  const t = useTranslations('workspace.modes');
  return (
    <nav
      className={cn(
        'flex shrink-0 items-stretch border-t border-border/40 bg-card pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label={t('openNav')}
        className="flex w-12 shrink-0 items-center justify-center text-muted-foreground transition-colors active:bg-muted"
      >
        <Menu className="h-4.5 w-4.5" />
      </button>
      {MODES.map((item) => {
        const Icon = MODE_ICON[item];
        const active = mode === item;
        return (
          <button
            key={item}
            type="button"
            onClick={() => onModeChange(item)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {t(item)}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onOpenCommand}
        aria-label={t('openCommand')}
        className="relative flex w-12 shrink-0 items-center justify-center text-muted-foreground transition-colors active:bg-muted"
      >
        <PanelRight className="h-4.5 w-4.5" />
        {pendingApprovals > 0 && (
          <span className="absolute right-2 top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold text-background">
            {pendingApprovals}
          </span>
        )}
      </button>
    </nav>
  );
}
