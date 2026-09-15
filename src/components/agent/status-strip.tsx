'use client';

import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentStatusPhase } from '@/lib/agent/stream-events';
import type { AgentErrorAttempt } from '@/lib/agent/stream-events';
import {
  presentRuntime,
  type RuntimeStatusLike,
} from '@/lib/agent/runtime-availability';

const PHASE_ICON: Record<AgentStatusPhase, typeof Loader2> = {
  thinking: Loader2,
  analyzing: Search,
  calling_tool: Wrench,
  tool_done: Wrench,
  generating: Sparkles,
  creating_file: Sparkles,
};

/**
 * 实时执行状态条 —— 把「正在做什么」讲清楚（类似 Cursor 的 agent 状态）。
 * 阶段来自服务端真实事件：工具调用由 Tool Registry 的审计回调上报，
 * 不是前端猜的定时器轮转。
 */
export function StatusStrip({
  phase,
  tool,
  label,
  providerLabel,
  className,
}: {
  phase: AgentStatusPhase;
  tool?: string;
  label?: string;
  providerLabel?: string;
  className?: string;
}) {
  const t = useTranslations('agent.status');
  const Icon = PHASE_ICON[phase] ?? Loader2;
  const text = tool
    ? t('callingTool', { tool: humanizeTool(tool) })
    : label
      ? t('creatingFile', { name: label })
      : t(phase);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/70 px-3 py-1 text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      <Icon className={cn('h-3 w-3', phase === 'thinking' ? 'rove-thinking-dot' : 'animate-pulse')} />
      <span className="truncate">{text}</span>
      {providerLabel && (
        <span className="border-l border-border/60 pl-2 text-[10px] opacity-80">{providerLabel}</span>
      )}
    </div>
  );
}

/**
 * Runtime 状态条（Step 3.1 任务 2）。
 *
 * 取代了 Step 3 的 `RuntimeBadge` —— 徽标对**每种** mode 都渲染，
 * 包括正常的 `roveagent`，属于视觉噪音。本组件改为**仅异常时显示**：
 *
 * - `roveagent`   → **不渲染**（返回 null）
 * - `fallback`    → 琥珀色警告
 * - `unavailable` → 红色错误 + 恢复按钮组
 *
 * 逻辑全在 `@/lib/agent/runtime-availability` 的纯函数里（便于单测），
 * 这里只做渲染。
 */
export function RuntimeStatusBar({
  status,
  onReconnect,
  onUseBasicMode,
  reconnecting,
  basicModeActive,
  className,
}: {
  status: RuntimeStatusLike | undefined | null;
  onReconnect?: () => void;
  onUseBasicMode?: () => void;
  reconnecting?: boolean;
  basicModeActive?: boolean;
  className?: string;
}) {
  const t = useTranslations('agent.runtime');
  const view = presentRuntime(status);
  if (!view.visible) return null;

  const isError = view.kind === 'error';

  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-2.5 text-xs',
        isError
          ? 'border-destructive/35 bg-destructive/5'
          : 'border-amber-500/35 bg-amber-500/5',
        className,
      )}
      role={isError ? 'alert' : 'status'}
      data-runtime-banner={view.kind}
    >
      <p
        className={cn(
          'flex items-center gap-1.5 font-semibold',
          isError ? 'text-destructive' : 'text-amber-700 dark:text-amber-300',
        )}
      >
        {isError ? <AlertTriangle className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
        {t(status?.mode === 'fallback' ? 'fallback' : 'unavailable')}
      </p>

      {view.detail && (
        <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
          {t('reason')}: {view.detail}
        </p>
      )}

      {view.recoverable && (onReconnect || onUseBasicMode) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {onReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              disabled={reconnecting}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3 w-3', reconnecting && 'animate-spin')} />
              {reconnecting ? t('reconnecting') : t('reconnect')}
            </button>
          )}
          {onUseBasicMode && (
            <button
              type="button"
              onClick={onUseBasicMode}
              disabled={basicModeActive}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <MessageSquare className="h-3 w-3" />
              {basicModeActive ? t('basicModeOn') : t('basicMode')}
            </button>
          )}
        </div>
      )}

      {basicModeActive && view.recoverable && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {t('basicModeHint')}
        </p>
      )}
    </div>
  );
}

/** analytics.get_sales_summary → Sales summary */
export function humanizeTool(tool: string): string {
  const tail = tool.includes('.') ? tool.split('.').slice(1).join('.') : tool;
  const spaced = tail.replace(/[._]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * 全部服务商失败面板 —— 「不要静默失败」的落点。
 * 逐家列出失败原因与延迟，并提供 Retry。
 */
export function ProviderAlert({
  attempts,
  providersTried,
  onRetry,
  retrying,
  className,
}: {
  attempts: AgentErrorAttempt[];
  providersTried?: number;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const t = useTranslations('agent.alert');
  const tried = providersTried ?? attempts.length;

  return (
    <div
      className={cn(
        'rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-sm',
        className,
      )}
      role="alert"
    >
      <p className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {t('title')}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t('tried', { count: tried })}
      </p>
      {attempts.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {attempts.map((attempt, index) => (
            <li key={`${attempt.provider}-${index}`} className="flex items-baseline gap-2 text-xs">
              <span className="font-mono font-medium">{attempt.provider}</span>
              <span className="text-destructive">{attempt.code}</span>
              {attempt.status != null && <span className="text-muted-foreground">HTTP {attempt.status}</span>}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{attempt.message}</span>
              {attempt.latencyMs > 0 && (
                <span className="shrink-0 text-muted-foreground">{attempt.latencyMs}ms</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', retrying && 'animate-spin')} />
          {t('retry')}
        </button>
      )}
    </div>
  );
}
