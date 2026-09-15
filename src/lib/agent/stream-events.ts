/**
 * Agent SSE 事件协议（服务端与前端共用）。
 *
 * 向后兼容：`delta` 事件同时带 `text` 字段，因此旧的
 * `use-sse`（只读 `parsed.text`）依然可用；`error` 事件同时带
 * `error` 字段，旧的错误处理也不会退化。
 *
 * 与 `sseResponse()`（`data: {text}`）的区别：这里的事件是**有类型的**，
 * 前端可以据此渲染「正在调用工具 / 正在生成报告 / 已切换模型」等真实阶段。
 */

import type { ArtifactRecord } from '@/lib/artifacts/store';
import type { ReasoningLevel } from '@/lib/ai/model-registry';

export type AgentStatusPhase =
  | 'thinking'
  | 'analyzing'
  | 'calling_tool'
  | 'tool_done'
  | 'generating'
  | 'creating_file';

export interface AgentProviderEvent {
  type: 'provider';
  index: number;
  total: number;
  provider: string;
  model: string;
  label: string;
  source: string;
}

export interface AgentStatusEvent {
  type: 'status';
  phase: AgentStatusPhase;
  /** 工具名（phase=calling_tool/tool_done 时有值） */
  tool?: string;
  /** 人类可读补充（如产物文件名） */
  label?: string;
}

export interface AgentDeltaEvent {
  type: 'delta';
  text: string;
}

export interface AgentArtifactEvent {
  type: 'artifact';
  artifact: ArtifactRecord;
}

export interface AgentNoticeEvent {
  type: 'notice';
  level: 'info' | 'warning';
  message: string;
  code?: string;
  /**
   * 技术细节（provider / error code / HTTP 状态）。**只有够权限的人会收到**，
   * 老板侧默认只看到「AI 服务正在自动切换备用引擎…」这类人话 —— 底层 400/超时
   * 堆在聊天里会让客户觉得系统不稳定。
   */
  technical?: string;
}

/** 聊天内审批卡片的数据。审批入口在对话里，底层仍然走 Approval Bus。 */
export interface ApprovalCardPayload {
  id: string;
  actionType: string;
  title: string;
  description: string | null;
  riskLevel: string;
  requiredRole: string;
  status: string;
  createdAt: string;
  /** 当前用户是否够权限决策（不够则只读展示，不给按钮） */
  canDecide: boolean;
  /** 已脱敏的载荷摘要：只保留标量字段，不把内部结构整个暴露到前端 */
  summary: Record<string, string | number | boolean | null>;
}

export interface AgentApprovalEvent {
  type: 'approval';
  approval: ApprovalCardPayload;
  reason?: 'created' | 'updated';
}

export interface AgentErrorAttempt {
  provider: string;
  model: string;
  code: string;
  status: number | null;
  message: string;
  latencyMs: number;
}

export interface AgentErrorEvent {
  type: 'error';
  error: string;
  code?: string;
  requestId?: string;
  provider?: string | null;
  model?: string | null;
  retryable?: boolean;
  /** 全部服务商失败时的逐家原因（UI 的 "AI Service Temporarily Unavailable" 面板） */
  providersTried?: number;
  attempts?: AgentErrorAttempt[];
}

export interface AgentDoneEvent {
  type: 'done';
  provider?: string;
  model?: string;
  reasoning?: ReasoningLevel;
}

/**
 * Runtime 状态（Step 2）。由 Agent Router 在流的最前面发出，
 * 前端据此判断本次请求实际由哪个 Runtime 执行。
 *
 * - `roveagent`：Python RoveAgent Runtime（正常路径）
 * - `fallback`：TS 兜底路径（降级；能力受限，必须让用户看见）
 * - `unavailable`：Runtime 不可用且该请求不允许降级（工具任务）
 */
export type AgentRuntimeMode = 'roveagent' | 'fallback' | 'unavailable';

export interface AgentRuntimeStatusEvent {
  type: 'runtime_status';
  mode: AgentRuntimeMode;
  /** 人类可读补充（agent 名 / 失败原因） */
  detail?: string;
}

export type AgentSseEvent =
  | AgentProviderEvent
  | AgentStatusEvent
  | AgentDeltaEvent
  | AgentArtifactEvent
  | AgentNoticeEvent
  | AgentApprovalEvent
  | AgentErrorEvent
  | AgentDoneEvent
  | AgentRuntimeStatusEvent;

/* -------------------------------------------------------------------------- */
/* 审批标记：与产物标记同一套思路 —— 落库进正文，刷新后卡片仍在                */
/* -------------------------------------------------------------------------- */

const APPROVAL_MARKER_SOURCE = '<<approval:([0-9a-fA-F-]{36})>>';

export function approvalMarker(id: string): string {
  return `<<approval:${id}>>`;
}

/** 从已落库正文中提取所有审批 id（去重、保序）。每次现建正则，避免 lastIndex 陷阱。 */
export function approvalIdsIn(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(APPROVAL_MARKER_SOURCE, 'g'))) {
    const id = match[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const ANY_MARKER = /<<(?:artifact|approval):[0-9a-fA-F-]{36}>>/g;

/**
 * 去掉正文里的内部标记。
 *
 * **必须有这一步**：正文在流式阶段被塞进了 `<<artifact:…>>` / `<<approval:…>>`，
 * 若把它直接当成 Markdown 内容去生成 Word/PDF，标记会被写进正式文件里。
 */
export function stripInternalMarkers(text: string): string {
  return (text ?? '').replace(ANY_MARKER, '').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ConversationSegment {
  type: 'text' | 'artifact' | 'approval';
  value: string;
}

/** 把带标记的正文切成「文本 / 产物 / 审批」有序片段，供前端渲染。 */
export function splitConversationSegments(text: string): ConversationSegment[] {
  const pattern = new RegExp(
    `${APPROVAL_MARKER_SOURCE}|<<artifact:([0-9a-fA-F-]{36})>>`,
    'g',
  );
  const segments: ConversationSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    if (before.trim()) segments.push({ type: 'text', value: before });
    if (match[1]) segments.push({ type: 'approval', value: match[1].toLowerCase() });
    else if (match[2]) segments.push({ type: 'artifact', value: match[2].toLowerCase() });
    cursor = index + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.trim()) segments.push({ type: 'text', value: rest });
  return segments;
}
