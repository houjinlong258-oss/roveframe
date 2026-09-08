/**
 * Phase 2/7 — Enterprise Kernel
 * /api/enterprise — REST endpoint
 *
 * GET  /api/enterprise          — Agent Team 名单 + 企业工具目录（任意登录用户）
 * POST /api/enterprise          — 执行企业工具 { toolId, input?, agentRole? }
 *                                 （权限不足返回 403 语义，全程 agent_actions 审计）
 */

import { NextRequest } from 'next/server';
import { json, jsonError } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { listAgentTeam, AGENT_TEAM, type AgentRoleId } from '@/lib/enterprise/agents';
import { executeEnterpriseTool, listEnterpriseTools } from '@/lib/enterprise/tool-runtime';
import { protectBusinessMutation } from '@/lib/mutation-guard';

async function handleGet(): Promise<Response> {
  return json({
    team: listAgentTeam(),
    tools: listEnterpriseTools(),
  });
}

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const b = body as Record<string, unknown>;
  if (typeof b.toolId !== 'string') {
    return jsonError('toolId (string) is required', 400);
  }

  const agentRole: AgentRoleId =
    typeof b.agentRole === 'string' && AGENT_TEAM.some((r) => r.id === b.agentRole)
      ? (b.agentRole as AgentRoleId)
      : 'operations';

  if (!ctx.businessId) {
    return jsonError('business scope is required for enterprise tools', 409);
  }

  const result = await executeEnterpriseTool(b.toolId, b.input ?? {}, {
    tenantId: ctx.tenantId,
    businessId: ctx.businessId,
    userId: ctx.user.userId,
    role: ctx.role,
    agentRole,
  });

  if (!result.ok && result.blocked) {
    return json(result, 403);
  }
  if (!result.ok) {
    return json(result, 422);
  }
  return json(result);
}

export const GET = withAuth(handleGet);
export const POST = protectBusinessMutation(
  { permission: 'agent:use', action: 'enterprise_tools.execute', entity: 'agent_actions' },
  withAuth(handlePost),
);
