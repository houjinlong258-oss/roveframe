'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  BarChart3, Bot, ChevronRight, FolderOpen, Info, ListChecks, MessageSquare,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pin, PinOff,
  Plus, Search, Target, Trash2,
} from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { useIsMobile } from '@/hooks/use-mobile';
import { Markdown } from '@/components/markdown';
import { ArtifactCard } from '@/components/agent/artifact-card';
import { Composer } from '@/components/agent/composer';
import { ProviderAlert, RuntimeStatusBar, StatusStrip, humanizeTool } from '@/components/agent/status-strip';
import { ApprovalCard } from '@/components/agent/approval-card';
import type { RegistryPayload } from '@/components/agent/model-selector';
import {
  WorkspaceGroup, WorkspacePanel, WorkspaceSeparator, useWorkspaceLayout,
} from '@/components/workspace/panels';
import { CommandCenter } from '@/components/workspace/command-center';
import { TasksView, type TaskRun } from '@/components/workspace/tasks-view';
import { InsightsView } from '@/components/workspace/insights-view';
import { MobileNav } from '@/components/workspace/mobile-nav';
import { isWorkspaceMode, type WorkspaceMode, type WorkspaceVisibility } from '@/components/workspace/types';
import { cn, safeFetchJson } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';
import { PERSONAS, type PersonaKey } from '@/lib/agent/personas';
import { defaultReasoningForAgent, type ReasoningLevel } from '@/lib/ai/reasoning';
import type { MissionBoard } from '@/lib/agent/missions';
import { artifactIdsIn } from '@/lib/artifacts/protocol';
import type { ArtifactRecord } from '@/lib/artifacts/store';
import {
  approvalIdsIn,
  splitConversationSegments,
  type AgentErrorEvent,
  type AgentRuntimeMode,
  type AgentSseEvent,
  type AgentStatusPhase,
  type ApprovalCardPayload,
} from '@/lib/agent/stream-events';
import {
  applyProbeResult,
  canSendInBasicMode,
  type RuntimeHealthReport,
} from '@/lib/agent/runtime-availability';
import { classifyRequest } from '@/lib/agent/request-class';

type Session = { id: string; title: string; updated_at: string };
type Notice = { level: 'info' | 'warning'; message: string; code?: string; technical?: string };
type Step = { key: string; label: string; done: boolean };

type ViewMessage = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  pending?: boolean;
  phase?: AgentStatusPhase | null;
  tool?: string;
  creatingFile?: string;
  providerLabel?: string;
  /** Step 3：本轮由哪个 Runtime 执行（必须对用户可见） */
  runtimeMode?: AgentRuntimeMode;
  runtimeDetail?: string;
  notices?: Notice[];
  error?: AgentErrorEvent | null;
  steps?: Step[];
};

const MODEL_STORAGE_KEY = 'roveframe.agent.model';
const REASONING_STORAGE_KEY = 'roveframe.agent.reasoning';
const MODE_STORAGE_KEY = 'roveframe.workspace.mode';
const VISIBILITY_STORAGE_KEY = 'roveframe.workspace.visibility';
const PINNED_STORAGE_KEY = 'roveframe.workspace.pinned';

const MODE_ICON = {
  chat: MessageSquare,
  tasks: ListChecks,
  files: FolderOpen,
  insights: BarChart3,
} as const;

function readStore(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式：忽略，只是不记忆
  }
}

function AgentWorkspace() {
  const t = useTranslations('agent');
  const tw = useTranslations('workspace');
  const tRuntime = useTranslations('agent.runtime');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactRecord>>({});
  const [approvals, setApprovals] = useState<Record<string, ApprovalCardPayload>>({});
  const [input, setInput] = useState('');
  const [persona, setPersona] = useState<PersonaKey>('ceo-insight');
  const [registry, setRegistry] = useState<RegistryPayload | null>(null);
  const [modelValue, setModelValue] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<ReasoningLevel>('medium');
  const [missionBoard, setMissionBoard] = useState<MissionBoard | null>(null);
  const [missionsLoading, setMissionsLoading] = useState(true);
  const [missionsFailed, setMissionsFailed] = useState(false);
  const [attachments, setAttachments] = useState<ArtifactRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);

  // 工作区形态：模式 + 面板可见性（都持久化，刷新后保持用户习惯）
  const [mode, setMode] = useState<WorkspaceMode>('chat');
  const [visibility, setVisibility] = useState<WorkspaceVisibility>({ conversations: true, command: true });
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [mobileCommand, setMobileCommand] = useState(false);

  // ---- Step 3.1：Runtime 恢复状态 ----
  /** 「重新连接」探测中 */
  const [runtimeReconnecting, setRuntimeReconnecting] = useState(false);
  /**
   * 基础模式：用户已确认接受降级。
   * 只允许普通聊天 —— tool_execution 仍然被拒绝（`canSendInBasicMode`）。
   */
  const [basicMode, setBasicMode] = useState(false);

  const { streaming, start, stop } = useSSE();
  const scrollRef = useRef<HTMLDivElement>(null);
  const insightSentRef = useRef(false);
  const keyCounter = useRef(0);

  const agentDefaultReasoning = defaultReasoningForAgent(persona);
  const activePersona = PERSONAS.find((item) => item.key === persona) ?? PERSONAS[0];

  const panelIds = useMemo(() => {
    const ids: string[] = [];
    if (visibility.conversations) ids.push('conversations');
    ids.push('main');
    if (visibility.command) ids.push('command');
    return ids;
  }, [visibility]);
  const { defaultLayout, onLayoutChanged } = useWorkspaceLayout(panelIds);

  const nextKey = useCallback((prefix: string) => {
    keyCounter.current += 1;
    return `${prefix}-${keyCounter.current}-${Date.now().toString(36)}`;
  }, []);

  /** 只在「最后一条 assistant 消息」上做流式更新，避免整表重渲染 */
  const patchStreamingMessage = useCallback((patch: (message: ViewMessage) => ViewMessage) => {
    setMessages((prev) => {
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        if (prev[index].role === 'assistant') {
          const next = [...prev];
          next[index] = patch(next[index]);
          return next;
        }
      }
      return prev;
    });
  }, []);

  /**
   * 「重新连接」（Step 3.1 任务 1）—— 探测 Runtime 是否恢复。
   *
   * 走服务端代理 `/api/agent/runtime-health`：浏览器不能直连 Runtime
   * （`client.ts` 经 `signature.ts` 依赖 node:crypto，且 API Key 不得下发）。
   *
   * 契约：
   * - 成功 → 把该会话的 runtime 状态恢复为 `roveagent`（状态条自动隐藏）
   * - 失败 → **保持错误**，并保留/更新原因
   */
  const reconnectRuntime = useCallback(async () => {
    setRuntimeReconnecting(true);
    try {
      const response = await fetch('/api/agent/runtime-health', { cache: 'no-store' });
      if (!response.ok) {
        // 探测本身失败（如 401）：保持错误，不谎报恢复
        return;
      }
      const report = (await response.json()) as RuntimeHealthReport;
      setMessages((prev) => {
        let changed = false;
        const next = prev.map((message) => {
          if (message.role !== 'assistant' || !message.runtimeMode) return message;
          const applied = applyProbeResult(
            { mode: message.runtimeMode, detail: message.runtimeDetail },
            report,
          );
          changed = true;
          return {
            ...message,
            runtimeMode: applied.mode,
            runtimeDetail: applied.detail,
            // 恢复成功后清掉不可用错误，让消息回到正常形态
            error: report.ok && message.error?.code === 'runtime_unavailable'
              ? null
              : message.error,
          };
        });
        return changed ? next : prev;
      });
      if (report.ok) setBasicMode(false);
    } catch {
      // 网络异常：保持错误
    } finally {
      setRuntimeReconnecting(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await safeFetchJson('/api/agent/sessions');
    const list: Session[] = data?.sessions ?? [];
    setSessions(list);
    return list;
  }, []);
  const loadMessages = useCallback(async (sessionId: string) => {
    const data = await safeFetchJson(`/api/agent/messages?session_id=${sessionId}`);
    const raw: Array<{ id?: string; role: 'user' | 'assistant'; content: string; created_at?: string }> =
      data?.messages ?? [];
    setMessages(
      raw.map((message, index) => ({
        key: message.id ?? `history-${sessionId}-${index}`,
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
      })),
    );

    const ids = new Set<string>();
    const approvalIds = new Set<string>();
    for (const message of raw) {
      if (message.role !== 'assistant') continue;
      for (const id of artifactIdsIn(message.content)) ids.add(id);
      for (const id of approvalIdsIn(message.content)) approvalIds.add(id);
    }
    if (ids.size > 0) {
      const result = await safeFetchJson(`/api/artifacts?ids=${Array.from(ids).join(',')}`);
      const list: ArtifactRecord[] = result?.artifacts ?? [];
      setArtifacts((prev) => {
        const next = { ...prev };
        for (const artifact of list) next[artifact.id] = artifact;
        return next;
      });
    }
    // 审批卡片在刷新后依然要出现：按标记里的 id 回查
    const pending = await safeFetchJson('/api/agent/approvals');
    const rows: Array<Record<string, unknown>> = Array.isArray(pending?.approvals)
      ? (pending.approvals as Array<Record<string, unknown>>)
      : [];
    if (rows.length > 0) {
      setApprovals((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id.toLowerCase() : null;
          if (!id) continue;
          if (approvalIds.size > 0 && !approvalIds.has(id)) continue;
          next[id] = {
            id,
            actionType: String(row.action_type ?? ''),
            title: String(row.title ?? ''),
            description: typeof row.description === 'string' ? row.description : null,
            riskLevel: String(row.risk_level ?? 'medium'),
            requiredRole: String(row.required_role ?? 'manager'),
            status: String(row.status ?? 'pending'),
            createdAt: String(row.created_at ?? ''),
            canDecide: next[id]?.canDecide ?? true,
            summary: next[id]?.summary ?? {},
          };
        }
        return next;
      });
    }
  }, []);

  const loadMissions = useCallback(async (key: PersonaKey) => {
    setMissionsLoading(true);
    setMissionsFailed(false);
    try {
      const data = await safeFetchJson(`/api/agent/missions?persona=${key}`);
      if (!data || (data as { error?: string }).error) {
        // 失败与「真的没数据」必须分开，否则用户以为系统坏了
        setMissionBoard(null);
        setMissionsFailed(true);
        return;
      }
      setMissionBoard(data as MissionBoard);
    } finally {
      setMissionsLoading(false);
    }
  }, []);

  // 挂载：会话 + 注册表 + 本地偏好（含工作区形态）
  useEffect(() => {
    loadSessions().then((list) => {
      if (list.length > 0) {
        setActiveId(list[0].id);
        void loadMessages(list[0].id);
      }
    });
    safeFetchJson('/api/ai/models').then((data) => {
      if (!data || (data as { error?: string }).error) return;
      const payload = data as RegistryPayload;
      setRegistry(payload);
      if (readStore(MODEL_STORAGE_KEY) !== null) return;
      if (payload.defaultProvider && payload.defaultModel) {
        setModelValue(`${payload.defaultProvider}:${payload.defaultModel}`);
      }
    });

    const savedReasoning = readStore(REASONING_STORAGE_KEY);
    if (savedReasoning === 'low' || savedReasoning === 'medium' || savedReasoning === 'high') {
      setReasoning(savedReasoning);
    } else {
      setReasoning(defaultReasoningForAgent('ceo-insight'));
    }
    const savedModel = readStore(MODEL_STORAGE_KEY);
    if (savedModel) setModelValue(savedModel === 'auto' ? null : savedModel);

    const savedMode = readStore(MODE_STORAGE_KEY);
    if (isWorkspaceMode(savedMode)) setMode(savedMode);

    const savedVisibility = readStore(VISIBILITY_STORAGE_KEY);
    if (savedVisibility) {
      try {
        const parsed = JSON.parse(savedVisibility) as Partial<WorkspaceVisibility>;
        setVisibility({
          conversations: parsed.conversations !== false,
          command: parsed.command !== false,
        });
      } catch {
        // 忽略损坏值
      }
    }

    const savedPinned = readStore(PINNED_STORAGE_KEY);
    if (savedPinned) {
      try {
        const parsed = JSON.parse(savedPinned) as unknown;
        if (Array.isArray(parsed)) setPinned(parsed.filter((id): id is string => typeof id === 'string'));
      } catch {
        // 忽略损坏值
      }
    }
  }, [loadSessions, loadMessages]);

  useEffect(() => {
    void loadMissions(persona);
  }, [persona, loadMissions]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const changeMode = useCallback((next: WorkspaceMode) => {
    setMode(next);
    writeStore(MODE_STORAGE_KEY, next);
  }, []);

  const togglePanel = useCallback((panel: keyof WorkspaceVisibility) => {
    setVisibility((prev) => {
      const next = { ...prev, [panel]: !prev[panel] };
      writeStore(VISIBILITY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const changePersona = useCallback((next: PersonaKey) => {
    setPersona(next);
    setReasoning(defaultReasoningForAgent(next));
  }, []);

  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      writeStore(PINNED_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      if (mode !== 'chat') changeMode('chat');

      // ---- 基础模式守卫（Step 3.1 任务 1）----
      // 基础模式只允许普通聊天。工具类请求必须继续被拒绝：
      // 放行等于让 TS 兜底路径「假装做过」，正是要消除的行为。
      // 这是**客户端预检**（即时反馈）；服务端分类仍是权威判定。
      if (basicMode && !canSendInBasicMode(classifyRequest(trimmed).requestClass)) {
        setMessages((prev) => [
          ...prev,
          { key: nextKey('user'), role: 'user', content: trimmed },
          {
            key: nextKey('assistant'),
            role: 'assistant',
            content: '',
            pending: false,
            notices: [{
              level: 'warning',
              code: 'basic_mode_blocks_tool_task',
              message: tRuntime('basicModeBlocked'),
            }],
          },
        ]);
        return;
      }

      setInput('');
      setLastPrompt(trimmed);
      const attachmentIds = attachments.map((file) => file.id);
      setAttachments([]);
      setMessages((prev) => [
        ...prev,
        { key: nextKey('user'), role: 'user', content: trimmed },
        {
          key: nextKey('assistant'),
          role: 'assistant',
          content: '',
          pending: true,
          phase: 'thinking',
          notices: [],
          steps: [],
        },
      ]);

      await start({
        url: '/api/agent/chat',
        body: {
          session_id: activeId ?? undefined,
          message: trimmed,
          locale,
          persona,
          model: modelValue ?? undefined,
          reasoning,
          attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
        },
        onEvent: (event: AgentSseEvent) => {
          switch (event.type) {
            case 'status':
              patchStreamingMessage((message) => ({
                ...message,
                phase: event.phase,
                tool: event.tool,
                creatingFile: event.phase === 'creating_file' ? event.label : undefined,
                steps: mergeStep(message.steps, event),
              }));
              break;
            case 'provider':
              patchStreamingMessage((message) => ({ ...message, providerLabel: event.label }));
              break;
            case 'delta':
              patchStreamingMessage((message) => ({ ...message, content: message.content + event.text }));
              break;
            case 'artifact':
              setArtifacts((prev) => ({ ...prev, [event.artifact.id]: event.artifact }));
              patchStreamingMessage((message) => ({
                ...message,
                steps: (message.steps ?? []).map((step) =>
                  step.key === `file:${event.artifact.name}` ? { ...step, done: true } : step,
                ),
              }));
              break;
            case 'notice':
              patchStreamingMessage((message) => ({
                ...message,
                notices: [...(message.notices ?? []), {
                  level: event.level,
                  message: event.message,
                  code: event.code,
                  technical: event.technical,
                }],
              }));
              break;
            case 'approval':
              setApprovals((prev) => ({ ...prev, [event.approval.id]: event.approval }));
              break;
            case 'runtime_status':
              // Step 3 任务 1：Runtime 状态必须对用户可见。
              // 关键点：`fallback` / `unavailable` 时**保留 pending**，
              // 不要在这里置 false —— 否则后续 delta 会渲染成一条已完成的消息。
              patchStreamingMessage((message) => ({
                ...message,
                runtimeMode: event.mode,
                runtimeDetail: event.detail,
              }));
              break;
            case 'error':
              patchStreamingMessage((message) => ({ ...message, error: event, pending: false }));
              break;
            default:
              break;
          }
        },
        onDone: (headers) => {
          const newId = headers.get('X-Session-Id');
          if (newId && newId !== activeId) setActiveId(newId);
          patchStreamingMessage((message) => ({ ...message, pending: false, phase: null }));
          void loadSessions();
          void loadMissions(persona);
        },
        onError: (message) => {
          patchStreamingMessage((prev) => ({
            ...prev,
            pending: false,
            phase: null,
            error: prev.error ?? { type: 'error', error: message },
          }));
        },
      });
    },
    [
      activeId, attachments, basicMode, changeMode, loadMissions, loadSessions, locale, mode,
      modelValue, nextKey, patchStreamingMessage, persona, reasoning, start, streaming, tRuntime,
    ],
  );

  // 从仪表盘洞察跳转：自动以洞察主题开场
  useEffect(() => {
    const insight = searchParams.get('insight');
    if (insight && !insightSentRef.current) {
      insightSentRef.current = true;
      void send(insight);
    }
  }, [searchParams, send]);

  const newChat = useCallback(() => {
    stop();
    setActiveId(null);
    setMessages([]);
    setAttachments([]);
    changeMode('chat');
  }, [stop, changeMode]);

  const deleteSession = useCallback(
    async (id: string, event: React.MouseEvent) => {
      event.stopPropagation();
      await fetch(`/api/agent/sessions?id=${id}`, { method: 'DELETE' });
      const list = await loadSessions();
      if (activeId === id) {
        if (list.length > 0) {
          setActiveId(list[0].id);
          void loadMessages(list[0].id);
        } else {
          newChat();
        }
      }
    },
    [activeId, loadMessages, loadSessions, newChat],
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      try {
        for (const file of files) {
          const form = new FormData();
          form.append('file', file);
          if (activeId) form.append('session_id', activeId);
          const response = await fetch('/api/artifacts', { method: 'POST', body: form });
          if (!response.ok) continue;
          const data = (await response.json()) as { artifact?: ArtifactRecord };
          const artifact = data.artifact;
          if (!artifact) continue;
          setArtifacts((prev) => ({ ...prev, [artifact.id]: artifact }));
          setAttachments((prev) => [...prev, artifact]);
        }
      } finally {
        setUploading(false);
      }
    },
    [activeId],
  );

  const handleModelChange = useCallback((next: string | null) => {
    setModelValue(next);
    writeStore(MODEL_STORAGE_KEY, next ?? 'auto');
  }, []);

  const handleReasoningChange = useCallback((next: ReasoningLevel) => {
    setReasoning(next);
    writeStore(REASONING_STORAGE_KEY, next);
  }, []);

  const team = useMemo(
    () => [
      { key: 'ceo', name: t('team.ceo'), role: t('team.ceoRole') },
      { key: 'ops', name: t('team.ops'), role: t('team.opsRole') },
      { key: 'mkt', name: t('team.mkt'), role: t('team.mktRole') },
      { key: 'cust', name: t('team.cust'), role: t('team.custRole') },
      { key: 'dev', name: t('team.dev'), role: t('team.devRole') },
      { key: 'devops', name: t('team.devops'), role: t('team.devopsRole') },
    ],
    [t],
  );

  /** 会话抽屉：置顶优先 + 搜索 */
  const visibleSessions = useMemo(() => {
    const needle = sessionQuery.trim().toLowerCase();
    const list = needle
      ? sessions.filter((session) => session.title.toLowerCase().includes(needle))
      : sessions;
    return [...list].sort((a, b) => {
      const aPinned = pinned.includes(a.id) ? 1 : 0;
      const bPinned = pinned.includes(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return b.updated_at.localeCompare(a.updated_at);
    });
  }, [sessions, sessionQuery, pinned]);

  /** Tasks 模式：把聊天消息里的执行步骤抽成运行记录 */
  const taskRuns: TaskRun[] = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'assistant' && (message.steps?.length ?? 0) > 0)
        .map((message) => {
          const index = messages.findIndex((item) => item.key === message.key);
          const question = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user');
          return {
            key: message.key,
            title: question?.content.slice(0, 60) ?? t('title'),
            at: message.createdAt ? fmtDateTime(message.createdAt, locale) : '',
            running: Boolean(message.pending),
            steps: message.steps ?? [],
            error: message.error?.error ?? null,
          };
        })
        .reverse(),
    [messages, locale, t],
  );

  const approvalList = useMemo(() => Object.values(approvals), [approvals]);
  const pendingApprovalCount = approvalList.filter(
    (item) => item.status === 'pending' || item.status === 'executing',
  ).length;
  const recentArtifacts = useMemo(
    () => Object.values(artifacts).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [artifacts],
  );
  const runningSteps = messages[messages.length - 1]?.steps ?? [];

  const openApprovals = useCallback(() => {
    changeMode('chat');
    setMobileCommand(false);
  }, [changeMode]);

  const conversationPanel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="shrink-0 border-b border-border/40 p-3">
        <button
          onClick={newChat}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('newChat')}
        </button>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder={tw('searchConversations')}
            className="w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visibleSessions.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">{tw('noConversations')}</p>
        )}
        {visibleSessions.map((session) => {
          const isPinned = pinned.includes(session.id);
          return (
            <div
              key={session.id}
              className={cn(
                'group flex items-center gap-1 rounded-md px-2 py-2 transition-colors',
                activeId === session.id ? 'bg-muted' : 'hover:bg-muted/60',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  if (streaming) return;
                  setActiveId(session.id);
                  void loadMessages(session.id);
                  if (isMobile) setMobileSidebar(false);
                }}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex items-center gap-1.5">
                  {isPinned && <Pin className="h-2.5 w-2.5 shrink-0 text-primary" />}
                  <span className="truncate text-[12px] font-medium">{session.title}</span>
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {fmtDateTime(session.updated_at, locale)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => togglePin(session.id)}
                aria-label={isPinned ? tw('unpin') : tw('pin')}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={(event) => void deleteSession(session.id, event)}
                aria-label={tw('delete')}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const chatPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {PERSONAS.map((item) => (
            <button
              key={item.key}
              onClick={() => changePersona(item.key)}
              disabled={streaming}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                persona === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              )}
            >
              {item.label}
              <span className="ml-1 opacity-60">{item.description}</span>
            </button>
          ))}
        </div>

        {messages.length === 0 && (
          <div className="flex flex-col items-center px-4 py-6 text-center">
            <span className="rove-rise mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary">
              <Bot className="h-7 w-7 text-primary-foreground" />
            </span>
            <h1 className="rove-rise rove-rise-1 font-display text-xl font-bold tracking-tight">
              {t('title')}
            </h1>
            <p className="rove-rise rove-rise-2 mt-1.5 max-w-md text-sm text-muted-foreground">
              {t('subtitle')}
            </p>

            <p className="rove-rise rove-rise-2 mb-3 mt-8 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t('yourTeam')}
            </p>
            <div className="grid w-full max-w-3xl grid-cols-1 gap-2 text-left sm:grid-cols-2 lg:grid-cols-3">
              {team.map((member) => (
                <button
                  key={member.key}
                  onClick={() => void send(t(`team.kickoff.${member.key}` as 'team.kickoff.ceo'))}
                  disabled={streaming}
                  className="group flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-left shadow-card transition-colors hover:border-primary/40 disabled:opacity-50"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Bot className="h-4 w-4 text-foreground/70" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{member.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{member.role}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {[t('quick1'), t('quick2'), t('quick3'), t('quick4'), t('quick5')].map((question) => (
                <button
                  key={question}
                  onClick={() => void send(question)}
                  disabled={streaming}
                  className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:opacity-50"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.key} className="flex justify-end">
              <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-4 py-3 sm:max-w-[70%]">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-primary-foreground">
                  {message.content}
                </p>
              </div>
            </div>
          ) : (
            <div key={message.key} className="flex gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
                <Bot className="h-4 w-4 text-primary-foreground" />
              </span>
              <div className="min-w-0 max-w-[92%] flex-1 space-y-2 sm:max-w-[80%]">
                <div className="min-w-0 rounded-xl rounded-tl-sm bg-card px-5 py-4 shadow-card">
                  {message.content ? (
                    <MessageBody
                      content={message.content}
                      artifacts={artifacts}
                      approvals={approvals}
                      onApprovalDecided={(id, status) =>
                        setApprovals((prev) =>
                          prev[id] ? { ...prev, [id]: { ...prev[id], status } } : prev,
                        )
                      }
                      onModifyApproval={(approval) => {
                        setInput(t('approval.modifyPrompt', { title: approval.title }));
                        changeMode('chat');
                        requestAnimationFrame(() => {
                          document.querySelector<HTMLTextAreaElement>('textarea')?.focus();
                        });
                      }}
                    />
                  ) : (
                    !message.error && (
                      <span className="text-sm text-muted-foreground">{t('thinking')}</span>
                    )
                  )}
                </div>

                {(message.notices ?? []).map((notice, index) => (
                  <NoticeLine
                    key={`${message.key}-notice-${index}`}
                    notice={notice}
                    label={t('notice.technical')}
                    hideLabel={t('notice.hideTechnical')}
                  />
                ))}

                {message.runtimeMode && (
                  <RuntimeStatusBar
                    status={{ mode: message.runtimeMode, detail: message.runtimeDetail }}
                    reconnecting={runtimeReconnecting}
                    basicModeActive={basicMode}
                    onReconnect={() => void reconnectRuntime()}
                    onUseBasicMode={() => setBasicMode(true)}
                  />
                )}

                {message.error && (
                  <ProviderAlert
                    attempts={message.error.attempts ?? []}
                    providersTried={message.error.providersTried}
                    onRetry={lastPrompt ? () => void send(lastPrompt) : undefined}
                    retrying={streaming}
                  />
                )}

                {message.pending && message.phase && (
                  <StatusStrip
                    phase={message.phase}
                    tool={message.tool}
                    label={message.creatingFile}
                    providerLabel={message.providerLabel}
                  />
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="shrink-0 border-t border-border/20 bg-card px-4 py-3 sm:px-6">
        <Composer
          value={input}
          onChange={setInput}
          onSend={(text) => void send(text)}
          streaming={streaming}
          onStop={stop}
          registry={registry}
          modelValue={modelValue}
          onModelChange={handleModelChange}
          reasoning={reasoning}
          onReasoningChange={handleReasoningChange}
          agentDefaultReasoning={agentDefaultReasoning}
          attachments={attachments}
          uploading={uploading}
          onUploadFiles={(files) => void uploadFiles(files)}
          onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((file) => file.id !== id))}
          placeholder={t('inputPlaceholder')}
        />
        <p className="mt-2 text-xs text-muted-foreground/70">{t('dataContext')}</p>
      </div>
    </div>
  );

  const filesPanel = (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight">{tw('files.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{tw('files.subtitle')}</p>
        </div>
        <a
          href={`/${locale}/files`}
          className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {tw('files.openCenter')}
          <ChevronRight className="h-3 w-3" />
        </a>
      </header>
      {recentArtifacts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
          {tw('files.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {recentArtifacts.slice(0, 30).map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      )}
    </div>
  );

  const modeContent =
    mode === 'chat' ? chatPanel
      : mode === 'tasks' ? (
        <TasksView
          runs={taskRuns}
          approvals={approvalList}
          scheduled={missionBoard?.activeTasks ?? []}
          onOpenChat={openApprovals}
          className="h-full"
        />
      )
        : mode === 'files' ? filesPanel
          : <InsightsView board={missionBoard} loading={missionsLoading} className="h-full" />;

  const commandCenter = (
    <CommandCenter
      agentName={activePersona.label}
      board={missionBoard}
      loading={missionsLoading}
      failed={missionsFailed}
      onRetry={() => void loadMissions(persona)}
      runningSteps={runningSteps}
      running={streaming}
      approvals={approvalList}
      onRunMission={(cta) => void send(cta)}
      onOpenApprovals={openApprovals}
      onOpenArtifact={() => changeMode('files')}
      className="bg-card"
    />
  );

  return (
    <div className="flex h-full -m-6 flex-col bg-background">
      {/* 顶部：模式切换 + 面板开关 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-card px-3 py-2">
        {visibility.conversations ? (
          <button
            type="button"
            onClick={() => togglePanel('conversations')}
            aria-label={tw('hideConversations')}
            className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => togglePanel('conversations')}
            aria-label={tw('showConversations')}
            className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {(['chat', 'tasks', 'files', 'insights'] as WorkspaceMode[]).map((item) => {
            const Icon = MODE_ICON[item];
            const active = mode === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => changeMode(item)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors duration-300',
                  active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tw(`modes.${item}`)}
              </button>
            );
          })}
        </nav>

        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:inline-flex">
          <Target className="h-3 w-3" />
          {activePersona.label}
        </span>

        {visibility.command ? (
          <button
            type="button"
            onClick={() => togglePanel('command')}
            aria-label={tw('hideCommand')}
            className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => togglePanel('command')}
            aria-label={tw('showCommand')}
            className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        )}
      </header>

      {isMobile ? (
        <>
          <div className="min-h-0 flex-1">{modeContent}</div>
          <MobileNav
            mode={mode}
            onModeChange={changeMode}
            onOpenSidebar={() => setMobileSidebar(true)}
            onOpenCommand={() => setMobileCommand(true)}
            pendingApprovals={pendingApprovalCount}
          />
        </>
      ) : (
        <WorkspaceGroup defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          {visibility.conversations && (
            <WorkspacePanel id="conversations" defaultSize="20%" minSize="14%" maxSize="30%">
              {conversationPanel}
            </WorkspacePanel>
          )}
          {visibility.conversations && <WorkspaceSeparator />}
          <WorkspacePanel id="main" minSize="40%">
            {modeContent}
          </WorkspacePanel>
          {visibility.command && <WorkspaceSeparator />}
          {visibility.command && (
            <WorkspacePanel id="command" defaultSize="22%" minSize="16%" maxSize="34%">
              {commandCenter}
            </WorkspacePanel>
          )}
        </WorkspaceGroup>
      )}

      {/* 移动端抽屉：左侧会话 / 右侧指挥中心 */}
      {isMobile && mobileSidebar && (
        <div className="fixed inset-0 z-50 flex">
          <div className="w-[78%] max-w-xs bg-card shadow-dialog">{conversationPanel}</div>
          <button
            type="button"
            aria-label={tw('closeDrawer')}
            className="flex-1 bg-black/50 transition-opacity duration-300"
            onClick={() => setMobileSidebar(false)}
          />
        </div>
      )}
      {isMobile && mobileCommand && (
        <div className="fixed inset-0 z-50 flex">
          <button
            type="button"
            aria-label={tw('closeDrawer')}
            className="flex-1 bg-black/50 transition-opacity duration-300"
            onClick={() => setMobileCommand(false)}
          />
          <div className="w-[84%] max-w-sm bg-card shadow-dialog">{commandCenter}</div>
        </div>
      )}
    </div>
  );
}

/**
 * 把 SSE 状态事件累积成一份「执行步骤清单」。
 * 状态条只说"现在在做什么"，清单留下"已经做过什么"。
 */
function mergeStep(
  steps: Step[] | undefined,
  event: { phase: AgentStatusPhase; tool?: string; label?: string },
): Step[] {
  const list = [...(steps ?? [])];
  if (event.phase === 'calling_tool' && event.tool) {
    const key = `tool:${event.tool}`;
    if (!list.some((step) => step.key === key)) {
      list.push({ key, label: humanizeTool(event.tool), done: false });
    }
    return list;
  }
  if (event.phase === 'tool_done' && event.tool) {
    const key = `tool:${event.tool}`;
    return list.map((step) => (step.key === key ? { ...step, done: true } : step));
  }
  if (event.phase === 'creating_file') {
    const key = event.label ? `file:${event.label}` : 'file:pending';
    if (!list.some((step) => step.key === key)) {
      list.push({ key, label: event.label ? `${event.label}` : 'Deliverable', done: false });
    }
    return list;
  }
  if (event.phase === 'analyzing' && !list.some((step) => step.key === 'analyze')) {
    list.push({ key: 'analyze', label: 'Analyzing business data', done: false });
    return list;
  }
  return list;
}

/**
 * 把带标记的正文渲染成「Markdown + Artifact 卡片 + 审批卡片」的有序片段。
 * 三种标记共用一套分段逻辑，顺序与产出顺序一致。
 */
function MessageBody({
  content,
  artifacts,
  approvals,
  onApprovalDecided,
  onModifyApproval,
}: {
  content: string;
  artifacts: Record<string, ArtifactRecord>;
  approvals: Record<string, ApprovalCardPayload>;
  onApprovalDecided: (id: string, status: string) => void;
  onModifyApproval: (approval: ApprovalCardPayload) => void;
}) {
  const segments = splitConversationSegments(content);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'artifact') {
          const artifact = artifacts[segment.value];
          return artifact ? (
            <ArtifactCard key={`artifact-${segment.value}`} artifact={artifact} className="my-3" />
          ) : (
            <ArtifactCard
              key={`artifact-${segment.value}`}
              pending
              className="my-3"
              artifact={{
                id: segment.value,
                name: 'Generating…',
                format: 'txt',
                mime: 'text/plain',
                size: 0,
                createdAt: new Date(0).toISOString(),
                source: 'agent',
                agent: null,
                sessionId: null,
                messageId: null,
                title: null,
              }}
            />
          );
        }
        if (segment.type === 'approval') {
          const approval = approvals[segment.value];
          if (!approval) return null;
          return (
            <ApprovalCard
              key={`approval-${segment.value}`}
              approval={approval}
              onDecided={onApprovalDecided}
              onModify={onModifyApproval}
            />
          );
        }
        return <Markdown key={`text-${index}`} content={segment.value} />;
      })}
    </>
  );
}

/**
 * 提示行：默认只显示人话（「AI 服务正在自动切换备用引擎…」）。
 * 底层 provider / HTTP 状态收进折叠区，老板不会被吓到，排查时随时能看到。
 */
function NoticeLine({
  notice,
  label,
  hideLabel,
}: {
  notice: Notice;
  label: string;
  hideLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <p
        className={cn(
          'flex items-center gap-2 text-[11px]',
          notice.level === 'warning' ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        <Info className="h-3 w-3 shrink-0" />
        {notice.message}
        {notice.technical && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="ml-1 shrink-0 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {open ? hideLabel : label}
          </button>
        )}
      </p>
      {open && notice.technical && (
        <p className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {notice.technical}
        </p>
      )}
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentWorkspace />
    </Suspense>
  );
}
