'use client';

/**
 * Dockable Workspace 的底层封装。
 *
 * 为什么包一层而不是到处直接用 `react-resizable-panels`：
 * 1. 该库 v4 的 API 与旧版差异很大（`Group`/`Separator`/`orientation`，
 *    不再是 `PanelGroup`/`PanelResizeHandle`/`direction`），集中在这里只有一处要跟；
 * 2. 拖拽手柄的命中区域、hover/active 反馈、收起动画需要统一视觉；
 * 3. 面板尺寸记忆统一走 `useDefaultLayout`（内置 localStorage 持久化），
 *    并且必须按「面板组合」分开存 —— 否则用户隐藏右侧栏后再打开会串尺寸。
 */

import type { ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

/**
 * 布局记忆键。
 *
 * ⚠️ v4 的单位语义变过：`defaultSize={20}` 被当成 **20 像素**（不是 20%），
 * 结果两侧面板只有 20px 宽。改动尺寸单位或默认值时**必须同时升这个 key**，
 * 否则老用户浏览器里存着的坏布局会一直生效。
 */
export const WORKSPACE_LAYOUT_STORAGE_KEY = 'roveframe.workspace.layout.v2';

/**
 * 永远返回一个**可用**的 storage 对象。
 *
 * 踩过的坑：把 `undefined` 传给 `useDefaultLayout` 会在 SSR 阶段抛
 * 「Cannot read properties of undefined (reading 'getItem')」，
 * Next 随即退化成纯客户端渲染并打一条 page error（Playwright 抓到的）。
 * 所以这里给一个惰性、永不抛错的实现：服务端读不到就返回 null（用默认布局），
 * 隐私模式写入失败就静默忽略。
 */
function createLayoutStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  let cache: Storage | null = null;
  const resolve = (): Storage | null => {
    if (typeof window === 'undefined') return null;
    if (cache) return cache;
    try {
      const probe = '__rf_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      cache = window.localStorage;
      return cache;
    } catch {
      return null;
    }
  };
  return {
    getItem(key: string): string | null {
      try {
        return resolve()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        resolve()?.setItem(key, value);
      } catch {
        // 隐私模式 / 配额满：不记忆即可，不影响功能
      }
    },
  };
}

const LAYOUT_STORAGE = createLayoutStorage();

/**
 * 记忆本工作区的面板布局。
 * `panelIds` 必须是当前实际渲染的面板 id —— 条件渲染面板时，
 * 不传它会在「隐藏再打开」时恢复出错位的尺寸。
 */
export function useWorkspaceLayout(panelIds: string[]) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: WORKSPACE_LAYOUT_STORAGE_KEY,
    panelIds,
    storage: LAYOUT_STORAGE,
  });
  return { defaultLayout, onLayoutChanged };
}

export function WorkspaceGroup({
  children,
  defaultLayout,
  onLayoutChanged,
  className,
}: {
  children: ReactNode;
  defaultLayout?: { [id: string]: number } | undefined;
  onLayoutChanged?: (layout: { [id: string]: number }) => void;
  className?: string;
}) {
  return (
    <Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      /* flex-1 而不是 h-full：它是 flex-col 里的子项，h-full 会和 header 叠加导致溢出 */
      className={cn('flex min-h-0 w-full flex-1', className)}
    >
      {children}
    </Group>
  );
}

/**
 * 面板尺寸一律用**带单位的字符串**（如 `"20%"`）。
 *
 * 踩过的坑：`react-resizable-panels` v4 把裸数字当作 `px`，
 * `defaultSize={20}` 会得到 20 像素宽的面板 —— 必须写 `"20%"`。
 */
export function WorkspacePanel({
  id,
  children,
  defaultSize,
  minSize,
  maxSize,
  className,
}: {
  id: string;
  children: ReactNode;
  /** 带单位字符串，如 "20%" */
  defaultSize?: string;
  minSize?: string;
  maxSize?: string;
  className?: string;
}) {
  return (
    <Panel
      id={id}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={maxSize}
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
    >
      {children}
    </Panel>
  );
}

/**
 * 拖拽手柄：视觉上只有 1px 细线，但命中区域放宽到 9px 且 hover 时高亮 —— 
 * 太细的把手在触控板上几乎抓不住。
 */
export function WorkspaceSeparator({ className }: { className?: string }) {
  return (
    <Separator
      className={cn(
        'group relative w-px shrink-0 bg-border/40 transition-colors duration-300',
        'hover:bg-primary/60 data-[dragging]:bg-primary',
        className,
      )}
    >
      <span className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
    </Separator>
  );
}
