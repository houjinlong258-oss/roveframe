/**
 * RoveAgent Gateway Client — RoveFrame ↔ RoveAgent Core 的唯一接口面。
 *
 * 架构（蓝图 Phase 2）：
 *   Frontend → RoveFrame API → 【本模块】→ RoveAgent Service (FastAPI)
 *     → Workforce / EnterpriseToolGate / Memory / Connectors
 *
 * 配置：
 *   ROVEAGENT_API_URL  Python 服务地址（默认 http://127.0.0.1:8788）
 *   ROVEAGENT_API_KEY  共享密钥（X-RoveAgent-Key）
 *
 * 契约：未配置或调用失败时抛 RoveAgentUnavailable，由调用方决定降级；
 * 本模块永不静默伪造 AI 回答。
 */

import { signRoveAgentPayload } from '@/lib/roveagent/signature';

const DEFAULT_URL = 'http://127.0.0.1:8788';
const DEFAULT_TIMEOUT_MS = 30_000;

export class RoveAgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoveAgentUnavailable';
  }
}

/**
 * 是否已配置 RoveAgent Runtime 连接。
 *
 * 契约（Step 1 修正）：**必须同时**提供 `ROVEAGENT_API_URL` 与 `ROVEAGENT_API_KEY`。
 *
 * 原实现用 `||`，只给其中一个就算「已配置」——那必然导致每个请求都去打一个
 * 注定失败的连接（缺 Key 会 401，缺 URL 会打默认本地端口），用户看到的只是
 * 变慢，看不到原因。改为 `&&` 后，「未配置」成为确定的快速判定。
 */
export function roveAgentConfigured(): boolean {
  return Boolean(process.env.ROVEAGENT_API_URL && process.env.ROVEAGENT_API_KEY);
}

/** 已配置的 URL / Key 各缺哪个（用于诊断提示，返回值不含密钥本身）。 */
export function roveAgentConfigGaps(): string[] {
  const gaps: string[] = [];
  if (!process.env.ROVEAGENT_API_URL) gaps.push('ROVEAGENT_API_URL');
  if (!process.env.ROVEAGENT_API_KEY) gaps.push('ROVEAGENT_API_KEY');
  return gaps;
}

/**
 * 「未配置」时给用户看的那句话 —— **必须点名缺哪个变量**。
 *
 * 实测（2026-09-25）：老板的实例只缺 `ROVEAGENT_API_URL` 一个变量，界面上却只说
 * "roveagent runtime not configured"。于是这个可一行修好的配置问题，被误判成
 * "整套工具能力没实现"，对方的 AI 还据此编出了一份"重构后端"的工单。
 * 报错含糊的代价，比报错本身大得多。
 *
 * 变量齐备时返回空串（调用方据此判断"不是缺配置，是连不上"）。
 */
export function roveAgentConfigDetail(): string {
  const gaps = roveAgentConfigGaps();
  if (gaps.length === 0) return '';
  return `missing ${gaps.join(', ')}`;
}

/** 健康检查结果。Runtime 可达性探针，不抛错。 */
export interface RoveAgentHealth {
  ok: boolean;
  /** 人类可读状态：ok | unreachable | unauthorized | error | unconfigured */
  status: 'ok' | 'unreachable' | 'unauthorized' | 'error' | 'unconfigured';
  latencyMs: number | null;
  detail: string;
}

/**
 * 探测 Runtime 可达性（`GET /api/health`）。
 *
 * 与 `call()` 的区别：这里**吞掉异常**并返回结构化结果 —— 它服务于
 * 「Runtime 状态必须透明」，调用方需要一个确定的布尔值而不是抛错。
 * 超时故意设短（默认 2s），避免把状态探测变成新的延迟来源。
 */
export async function roveAgentHealth(timeoutMs = 2_000): Promise<RoveAgentHealth> {
  const gaps = roveAgentConfigGaps();
  if (gaps.length > 0) {
    return {
      ok: false,
      status: 'unconfigured',
      latencyMs: null,
      detail: `missing ${gaps.join(', ')}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl()}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'X-RoveAgent-Key': process.env.ROVEAGENT_API_KEY ?? '' },
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      return { ok: true, status: 'ok', latencyMs, detail: 'runtime reachable' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 'unauthorized', latencyMs, detail: `runtime rejected key (${res.status})` };
    }
    return { ok: false, status: 'error', latencyMs, detail: `runtime returned ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      status: 'unreachable',
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function baseUrl(): string {
  return (process.env.ROVEAGENT_API_URL || DEFAULT_URL).replace(/\/$/, '');
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-RoveAgent-Key': process.env.ROVEAGENT_API_KEY ?? '',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RoveAgentUnavailable(`roveagent ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof RoveAgentUnavailable) throw error;
    throw new RoveAgentUnavailable(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出技能市场里该租户**已装**的技能（名字 + 描述）。
 *
 * 供任务→技能路由使用：只提示已装的技能，否则会把模型引向一个它调不动的技能。
 * 调用方必须把失败当"没有提示"处理（best-effort），不能让聊天因此失败。
 */
export async function listInstalledSkills(scope: {
  tenantId: string;
  businessId: string;
}): Promise<Array<{ name: string; description: string; installed: boolean }>> {
  const query = new URLSearchParams({
    tenant_id: scope.tenantId,
    business_id: scope.businessId,
  });
  const payload = await call<{
    skills?: Array<{ name?: string; description?: string; installed?: boolean }>;
  }>(`/api/agent/skills/market?${query.toString()}`, { method: 'GET' }, 10_000);
  return (payload.skills ?? [])
    .filter((s): s is { name: string; description?: string; installed?: boolean } => Boolean(s?.name))
    .map((s) => ({
      name: s.name,
      description: s.description ?? '',
      installed: s.installed === true,
    }));
}

function signedBody(value: Record<string, unknown>): { body: string; headers: Record<string, string> } {  const body = JSON.stringify(value);
  const signed = signRoveAgentPayload(body);
  return {
    body,
    headers: {
      'X-RoveAgent-Timestamp': signed.timestamp,
      'X-RoveAgent-Signature': signed.signature,
    },
  };
}

export interface RoveAgentChatInput {
  tenantId: string;
  businessId: string;
  userId: string;
  message: string;
  agent?: string;
  role: string;
  permissions: string[];
  requestId: string;
  taskId: string;
  /** 会话 ID：相同 ID 的多次调用共享多轮上下文。 */
  sessionId: string;
  industry: string;
  /** Bounded canonical facts assembled by RoveFrame for the current business. */
  businessContext: string;
}

export interface RoveAgentChatResult {
  reply: string;
  agent: string;
  tenant_id: string;
  business_id: string;
  session_id: string;
  history_turns: number;
  memory_used: number;
}

export function roveAgentChat(input: RoveAgentChatInput): Promise<RoveAgentChatResult> {
  return call('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: input.tenantId,
      business_id: input.businessId,
      user_id: input.userId,
      message: input.message,
      agent: input.agent ?? 'ceo',
      role: input.role,
      permissions: input.permissions,
      request_id: input.requestId,
      task_id: input.taskId,
      session_id: input.sessionId,
      industry: input.industry,
      business_context: input.businessContext,
    }),
  });
}

/** 一条已解析的 SSE 事件。payload 的形状由前端 `AgentSseEvent` 契约决定。 */
export interface RoveAgentStreamEvent {
  data: string;
  payload: Record<string, unknown> | null;
}

/**
 * 流式对话（Step 2）—— `POST /api/agent/chat/stream`。
 *
 * 与 `roveAgentChat()` 的关系：**并列**，不替代。非流式端点、HMAC 签名流程、
 * 审批回放、任务执行全部保持不变。
 *
 * 返回一个异步迭代器；调用方逐个消费事件。实现与 `call()` 相同的：
 * `X-RoveAgent-Key` 鉴权、AbortController 超时（这里放宽，因为一轮工具循环
 * 可能远超 30s）、以及把所有失败统一包成 `RoveAgentUnavailable`。
 */
export async function* roveAgentChatStream(
  input: RoveAgentChatInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<RoveAgentStreamEvent, void, unknown> {
  if (!roveAgentConfigured()) {
    const gaps = roveAgentConfigGaps();
    throw new RoveAgentUnavailable(`runtime not configured (missing ${gaps.join(', ')})`);
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 600_000; // 10 分钟：工具循环可能很长
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 外部取消（用户点停止）与内部超时合并
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(`${baseUrl()}/api/agent/chat/stream`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-RoveAgent-Key': process.env.ROVEAGENT_API_KEY ?? '',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        tenant_id: input.tenantId,
        business_id: input.businessId,
        user_id: input.userId,
        message: input.message,
        agent: input.agent ?? 'ceo',
        role: input.role,
        permissions: input.permissions,
        request_id: input.requestId,
        task_id: input.taskId,
        session_id: input.sessionId,
        industry: input.industry,
        business_context: input.businessContext,
      }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new RoveAgentUnavailable(
        `roveagent /api/agent/chat/stream -> ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        let payload: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object') {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          // 不完整片段：当作纯文本，不丢内容
        }
        yield { data: raw, payload };
      }
    }
  } catch (error) {
    if (error instanceof RoveAgentUnavailable) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new RoveAgentUnavailable('roveagent stream aborted (client cancelled or timed out)');
    }
    throw new RoveAgentUnavailable(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export interface RoveAgentTaskStep {
  id: string;
  title: string;
  assignee: string;
  kind: 'analyze' | 'propose' | 'execute' | 'measure';
  status: string;
  needs_approval: boolean;
  detail: string;
  result: string;
}

export interface RoveAgentTask {
  id: string;
  tenant_id: string;
  business_id: string;
  title: string;
  objective: string;
  status: 'planned' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'rejected';
  steps: RoveAgentTaskStep[];
  created_at: number;
  updated_at: number;
}

export interface RoveAgentTaskCreateResult {
  task: RoveAgentTask;
  metric: string;
  target: string;
  strategy: string[];
}

export function roveAgentCreateTask(
  tenantId: string,
  businessId: string,
  objective: string,
  title = '',
): Promise<RoveAgentTaskCreateResult> {
  return call('/api/agent/task', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId, business_id: businessId, objective, title }),
  });
}

export function roveAgentExecuteTask(
  tenantId: string,
  businessId: string,
  taskId: string,
  approved: boolean,
  approver = '',
): Promise<{ task_id: string; status: string; executed: string[]; awaiting_approval: string[] }> {
  const signed = signedBody({
    tenant_id: tenantId,
    business_id: businessId,
    task_id: taskId,
    approved,
    approver,
  });
  return call('/api/agent/execute', {
    method: 'POST',
    body: signed.body,
    headers: signed.headers,
  });
}

export function roveAgentTaskStatus(
  tenantId: string,
  businessId: string,
  taskId: string,
): Promise<{ task: RoveAgentTask }> {
  const params = new URLSearchParams({ tenant_id: tenantId, business_id: businessId });
  return call(`/api/agent/status/${encodeURIComponent(taskId)}?${params.toString()}`);
}

/**
 * 审批回调：把 RoveFrame 审批 UI 的批准/拒绝决定回传给 RoveAgent，
 * 落成门控 grant —— 同租户同工具同参数的重试在 TTL 内凭 grant 放行。
 */
export function roveAgentResolveTool(input: {
  tenantId: string;
  businessId: string;
  tool: string;
  args?: Record<string, unknown>;
  approved: boolean;
  approver?: string;
  auditEventId?: string;
  invocationId: string;
  executionId: string;
  argumentsHash: string;
  userId: string;
  agentId: string;
  role: string;
  permissions: string[];
  requestId: string;
  taskId: string;
}): Promise<{ ok: boolean; approved: boolean; execution_id: string; result?: unknown }> {
  const signed = signedBody({
    tenant_id: input.tenantId,
    business_id: input.businessId,
    tool: input.tool,
    args: input.args ?? {},
    approved: input.approved,
    approver: input.approver ?? '',
    audit_event_id: input.auditEventId ?? '',
    invocation_id: input.invocationId,
    execution_id: input.executionId,
    arguments_hash: input.argumentsHash,
    user_id: input.userId,
    agent_id: input.agentId,
    role: input.role,
    permissions: input.permissions,
    request_id: input.requestId,
    task_id: input.taskId,
  });
  return call('/api/agent/tool/resolve', {
    method: 'POST',
    body: signed.body,
    headers: signed.headers,
  });
}

export interface RoveAgentMemoryHit {
  layer: string;
  kind: string;
  content: string;
  score: number;
}

export function roveAgentMemory(
  tenantId: string,
  businessId: string,
  query = '',
  industry = '',
  limit = 8,
): Promise<{ count: number; memories: RoveAgentMemoryHit[] }> {
  const qs = new URLSearchParams({
    tenant_id: tenantId,
    business_id: businessId,
    query,
    industry,
    limit: String(limit),
  });
  return call(`/api/agent/memory?${qs.toString()}`);
}

export function roveAgentCreateSkill(input: {
  tenantId: string;
  businessId: string;
  name: string;
  description?: string;
  workflow?: string;
  industry?: string;
}): Promise<{ skill: string; path: string }> {
  return call('/api/agent/skill/create', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: input.tenantId,
      business_id: input.businessId,
      name: input.name,
      description: input.description ?? '',
      workflow: input.workflow ?? '',
      industry: input.industry ?? '',
    }),
  });
}

export interface RoveAgentMarketSkill {
  name: string;
  description: string;
  industry: string;
  category: string;
  source: 'builtin' | 'library' | 'tenant';
  installed: boolean;
}

/** 技能市场目录（可按行业过滤）。 */
export function roveAgentSkillMarket(
  tenantId: string, businessId: string, industry = '',
): Promise<{ count: number; skills: RoveAgentMarketSkill[] }> {
  const qs = new URLSearchParams({ tenant_id: tenantId, business_id: businessId, industry });
  return call(`/api/agent/skills/market?${qs.toString()}`);
}

/** 把市场技能安装进租户技能目录（幂等）。 */
export function roveAgentInstallSkill(input: {
  tenantId: string; businessId: string; name: string; industry?: string;
}): Promise<{ ok: boolean; skill: string; path: string }> {
  return call('/api/agent/skills/install', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: input.tenantId,
      business_id: input.businessId,
      name: input.name,
      industry: input.industry ?? '',
    }),
  });
}
