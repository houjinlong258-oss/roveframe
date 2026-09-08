/**
 * Phase 2/7 — Enterprise Kernel: Agent Team
 *
 * 六个企业级 Agent 角色定义。每个角色绑定：系统提示词、允许的工具命名空间、
 * 默认 AI capability。RoveAgent Core 管理有界规划与工具反馈循环；
 * 企业层负责身份、权限、审批、业务工具与数据访问。
 */

export type AgentRoleId =
  | 'ceo'
  | 'operations'
  | 'marketing'
  | 'customer'
  | 'developer'
  | 'devops';

export interface AgentRole {
  id: AgentRoleId;
  name: string;
  mission: string;
  /** 允许调用的企业工具命名空间前缀（'*' 表示全部） */
  allowedToolNamespaces: string[];
  /** AI 路由层 capability */
  capability: 'agent' | 'content' | 'rag' | 'light';
  systemPrompt: string;
}

export const AGENT_TEAM: readonly AgentRole[] = [
  {
    id: 'ceo',
    name: 'CEO Agent',
    mission: '全局经营洞察与跨部门决策建议',
    allowedToolNamespaces: ['restaurant.', 'customer.', 'review.', 'system.'],
    capability: 'agent',
    systemPrompt:
      'You are the CEO Agent of a restaurant business OS. Focus on revenue, growth, ' +
      'cross-department trade-offs and weekly strategy. Use tools for facts; never invent numbers.',
  },
  {
    id: 'operations',
    name: 'Operations Agent',
    mission: '订单、库存、预约与门店日常运营',
    allowedToolNamespaces: ['restaurant.', 'system.'],
    capability: 'agent',
    systemPrompt:
      'You are the Operations Agent. Watch orders, inventory and reservations. ' +
      'Detect operational risks early and propose concrete, low-risk actions.',
  },
  {
    id: 'marketing',
    name: 'Marketing Agent',
    mission: '营销活动、会员运营与增长实验',
    allowedToolNamespaces: ['marketing.', 'customer.', 'restaurant.'],
    capability: 'content',
    systemPrompt:
      'You are the Marketing Agent. Design campaigns, segment customers and draft content. ' +
      'Every campaign must be measurable and respect opt-out preferences.',
  },
  {
    id: 'customer',
    name: 'Customer Agent',
    mission: '客户 360、流失预警与口碑管理',
    allowedToolNamespaces: ['customer.', 'review.'],
    capability: 'agent',
    systemPrompt:
      'You are the Customer Agent. Monitor churn risk and reviews, protect the ' +
      'customer relationship, and escalate insults/legal threats to humans.',
  },
  {
    id: 'developer',
    name: 'Developer Agent',
    mission: '代码提案与系统维护（仅 src/custom/ 等白名单目录）',
    allowedToolNamespaces: ['coding.', 'system.'],
    capability: 'agent',
    systemPrompt:
      'You are the Developer Agent. You may only propose changes to whitelisted paths ' +
      '(src/custom/, docs/, messages/, public/). Never touch core, auth or crypto code. ' +
      'Every change requires human approval.',
  },
  {
    id: 'devops',
    name: 'DevOps Agent',
    mission: '部署、健康检查与回滚',
    allowedToolNamespaces: ['deployment.', 'system.'],
    capability: 'agent',
    systemPrompt:
      'You are the DevOps Agent. Generate deployment plans, run health checks and ' +
      'prepare rollbacks. You never execute on remote servers directly.',
  },
] as const;

export function getAgentRole(id: AgentRoleId): AgentRole {
  const role = AGENT_TEAM.find((r) => r.id === id);
  if (!role) throw new Error(`unknown agent role: ${id}`);
  return role;
}

/** 判断某角色是否被允许调用某工具（按命名空间前缀） */
export function roleCanUseTool(role: AgentRoleId, toolId: string): boolean {
  const def = getAgentRole(role);
  return def.allowedToolNamespaces.some(
    (ns) => ns === '*' || toolId.startsWith(ns)
  );
}

export function listAgentTeam(): Omit<AgentRole, 'systemPrompt'>[] {
  return AGENT_TEAM.map(({ systemPrompt: _omit, ...rest }) => rest);
}
