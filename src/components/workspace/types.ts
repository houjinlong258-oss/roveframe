/** Workspace 模式与布局的共享类型（客户端与服务端都能安全引用） */

export type WorkspaceMode = 'chat' | 'tasks' | 'files' | 'insights';

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ['chat', 'tasks', 'files', 'insights'];

const MODE_SET: ReadonlySet<string> = new Set(WORKSPACE_MODES);

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

/** 面板可见性：两侧都能独立收起，收起后主区自动占满 */
export interface WorkspaceVisibility {
  conversations: boolean;
  command: boolean;
}
