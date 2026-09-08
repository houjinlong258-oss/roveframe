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

export function roveAgentConfigured(): boolean {
  return Boolean(process.env.ROVEAGENT_API_URL || process.env.ROVEAGENT_API_KEY);
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

function signedBody(value: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(value);
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
