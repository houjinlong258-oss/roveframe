'use client';

import { cn } from '@/lib/utils';
import { RoveCard } from './rove-card';

export type AgentStatus = 'active' | 'thinking' | 'idle' | 'attention';

const STATUS_DOT: Record<AgentStatus, string> = {
  active: 'bg-accent rove-live-dot',
  thinking: 'bg-warning rove-thinking-dot',
  idle: 'bg-muted-foreground/40',
  attention: 'bg-destructive',
};

/**
 * AI 员工卡片：状态、当前任务、最近动作、进入 Agent。
 * AI-native 交互核心 —— 界面强调 Agents 而非菜单。
 */
export function AgentCard({
  name,
  role,
  status,
  statusLabel,
  currentTask,
  lastAction,
  icon: Icon,
  action,
  onOpen,
  rise,
  className,
}: {
  name: string;
  role: string;
  status: AgentStatus;
  statusLabel: string;
  currentTask?: string;
  lastAction?: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  onOpen?: () => void;
  rise?: 0 | 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <RoveCard
      rise={rise}
      className={cn(
        'p-5 group cursor-pointer hover:shadow-float hover:-translate-y-0.5 transition-all duration-300',
        className
      )}
      // 整卡可点击进入 Agent
    >
      <div onClick={onOpen} className="flex flex-col h-full">
        <div className="flex items-start justify-between">
          <span className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5" />
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className={cn('w-2 h-2 rounded-full', STATUS_DOT[status])} />
            {statusLabel}
          </span>
        </div>
        <div className="mt-3.5">
          <h3 className="text-sm font-bold tracking-tight">{name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{role}</p>
        </div>
        {currentTask && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground line-clamp-2 min-h-8">
            {currentTask}
          </p>
        )}
        <div className="mt-auto pt-4 flex items-center justify-between">
          {lastAction ? (
            <span className="text-[11px] text-muted-foreground/70 truncate max-w-[60%]">{lastAction}</span>
          ) : (
            <span />
          )}
          {action}
        </div>
      </div>
    </RoveCard>
  );
}
