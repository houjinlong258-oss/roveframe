/**
 * Phase 2/7 — Enterprise Kernel: Tool Runtime
 *
 * 所有企业能力以命名空间工具暴露（restaurant.sales.analyze / review.monitor /
 * customer.segment / marketing.create_campaign / deployment.deploy /
 * system.health_check）。每次调用必经三段闸门：
 *
 *   Permission（RBAC + Agent 角色命名空间白名单）
 *   → Audit（agent_actions 持久化，started → succeeded/failed/blocked）
 *   → Execution（超时保护）
 */

import { z } from 'zod';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { insertWithScope } from '@/lib/tenant-db';
import { hasPermission, type RoleKey } from '@/lib/rbac';
import { writeAgentAction } from '@/lib/agent/audit';
import type { AgentAuditEvent, AgentToolContext } from '@/lib/agent/types';
import { generateDeploymentPlan } from '@/lib/deployment/generator';
import { roleCanUseTool, type AgentRoleId } from './agents';

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export interface EnterpriseToolContext {
  tenantId: string;
  businessId: string;
  userId: string;
  role: RoleKey;
  agentRole: AgentRoleId;
  sessionId?: string;
  locale?: string;
}

interface EnterpriseTool {
  id: string;
  description: string;
  requiredPermission: string;
  risk: 'read' | 'write';
  inputSchema: z.ZodTypeAny;
  run: (input: unknown, ctx: EnterpriseToolContext) => Promise<unknown>;
}

const EMPTY = z.object({}).passthrough();

const sevenDaysAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

const ENTERPRISE_TOOLS: EnterpriseTool[] = [
  {
    id: 'restaurant.sales.analyze',
    description: '近 7 天销售概览：订单数、营收、客单价、渠道分布',
    requiredPermission: 'orders:read',
    risk: 'read',
    inputSchema: EMPTY,
    run: async (_input, ctx) => {
      const { data, error } = await getSupabaseClient()
        .from('orders')
        .select('total, channel, status')
        .eq('tenant_id', ctx.tenantId)
        .eq('business_id', ctx.businessId)
        .gte('created_at', sevenDaysAgo());
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { total: string; channel: string; status: string }[];
      const revenue = rows.reduce((s, r) => s + Number(r.total || 0), 0);
      const byChannel: Record<string, number> = {};
      for (const r of rows) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
      return {
        periodDays: 7,
        orderCount: rows.length,
        revenue: Math.round(revenue * 100) / 100,
        avgTicket: rows.length ? Math.round((revenue / rows.length) * 100) / 100 : 0,
        byChannel,
      };
    },
  },
  {
    id: 'review.monitor',
    description: '近 7 天差评监控：数量、平均分、未回复数',
    requiredPermission: 'reviews:read',
    risk: 'read',
    inputSchema: EMPTY,
    run: async (_input, ctx) => {
      const { data, error } = await getSupabaseClient()
        .from('reviews')
        .select('rating, reply_status')
        .eq('tenant_id', ctx.tenantId)
        .eq('business_id', ctx.businessId)
        .gte('created_at', sevenDaysAgo());
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { rating: number; reply_status: string | null }[];
      const negative = rows.filter((r) => r.rating <= 3);
      return {
        periodDays: 7,
        total: rows.length,
        negative: negative.length,
        negativeUnreplied: negative.filter((r) => r.reply_status !== 'replied').length,
        avgRating: rows.length
          ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 100) / 100
          : null,
      };
    },
  },
  {
    id: 'customer.segment',
    description: '客户分群统计：按流失风险等级计数',
    requiredPermission: 'customers:read',
    risk: 'read',
    inputSchema: EMPTY,
    run: async (_input, ctx) => {
      const { data, error } = await getSupabaseClient()
        .from('customers')
        .select('churn_risk')
        .eq('tenant_id', ctx.tenantId)
        .eq('business_id', ctx.businessId);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { churn_risk: string | null }[];
      const segments: Record<string, number> = {};
      for (const r of rows) {
        const key = r.churn_risk ?? 'unknown';
        segments[key] = (segments[key] ?? 0) + 1;
      }
      return { total: rows.length, segments };
    },
  },
  {
    id: 'marketing.create_campaign',
    description: '创建营销活动草稿（不发送，进入待审队列）',
    requiredPermission: 'marketing:write',
    risk: 'write',
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      theme: z.string().min(1).max(500),
      targetSegment: z.string().max(100).optional(),
    }),
    run: async (input, ctx) => {
      const { name, theme, targetSegment } = input as {
        name: string;
        theme: string;
        targetSegment?: string;
      };
      const result = await insertWithScope(ctx, 'marketing_contents', {
        name,
        theme,
        target_segment: targetSegment ?? null,
        status: 'draft',
        created_by: ctx.userId,
      });
      if (result.error) throw new Error(result.error.message);
      return { created: true, name, status: 'draft' };
    },
  },
  {
    id: 'deployment.deploy',
    description: '生成部署计划（Docker/Nginx 产物包；不直接操作服务器）',
    requiredPermission: 'deployment:execute', // 仅 owner（'*'）持有
    risk: 'write',
    inputSchema: z.object({
      domain: z.string().max(253).optional(),
      environment: z.enum(['production', 'staging']).optional(),
      sslEmail: z.string().email().optional(),
    }),
    run: async (input) => {
      const plan = generateDeploymentPlan(input as Record<string, unknown>);
      return {
        domain: plan.config.domain ?? null,
        environment: plan.config.environment,
        artifacts: plan.artifacts.map((a) => a.path),
        steps: plan.steps,
      };
    },
  },
  {
    id: 'system.health_check',
    description: '系统健康检查：数据库连通性 + 关键表存在性',
    requiredPermission: 'settings:read',
    risk: 'read',
    inputSchema: EMPTY,
    run: async (_input, ctx) => {
      const checks: Record<string, boolean> = {};
      try {
        const { error } = await getSupabaseClient()
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('business_id', ctx.businessId);
        checks.database = !error;
      } catch {
        checks.database = false;
      }
      return { ok: Object.values(checks).every(Boolean), checks, checkedAt: new Date().toISOString() };
    },
  },
];

// ---------------------------------------------------------------------------
// 执行入口：Permission → Audit → Execution
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  ok: boolean;
  toolId: string;
  data?: unknown;
  error?: string;
  blocked?: boolean;
  durationMs: number;
  /**
   * 审计写入失败时为 true。
   *
   * 存在的理由：调用方需要能区分「被拒绝」与「被拒绝、但这次拒绝没能记下来」。
   * 两者都不是成功，但后者是**证据链的缺口**，必须能被告警/排查看见。
   */
  auditFailed?: boolean;
}

const TOOL_TIMEOUT_MS = 30_000;

export function listEnterpriseTools(): { id: string; description: string; risk: string }[] {
  return ENTERPRISE_TOOLS.map((t) => ({ id: t.id, description: t.description, risk: t.risk }));
}

export function getEnterpriseTool(id: string): EnterpriseTool | undefined {
  return ENTERPRISE_TOOLS.find((t) => t.id === id);
}

export async function executeEnterpriseTool(
  toolId: string,
  rawInput: unknown,
  ctx: EnterpriseToolContext
): Promise<ToolExecutionResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const auditCtx: AgentToolContext = {
    tenantId: ctx.tenantId,
    businessId: ctx.businessId,
    userId: ctx.userId,
    role: ctx.role,
    sessionId: ctx.sessionId ?? 'enterprise-tool',
    turnId: `turn_${t0.toString(36)}`,
    locale: ctx.locale ?? 'en',
    timeZone: 'UTC',
    audit: async () => undefined,
  };

  const auditEvent = (status: 'succeeded' | 'failed' | 'blocked', summary: string) => ({
    tool: toolId,
    action: 'execute',
    input: rawInput as Record<string, unknown>,
    resultSummary: summary,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
  });

  /**
   * 写审计并**如实报告失败**（fail-closed）。
   *
   * ## 为什么不能用 `.catch(() => undefined)`
   *
   * 这里原本四处都是 `.catch(() => undefined)`。危险的方向只有一个：
   * **工具已经执行完成、而记录它的那行没写进去，调用方却拿到 `ok: true`** ——
   * 那是"做了一件无法证明做过的事"，审计链从此有一个看不见的洞。
   *
   * 同一条链上的 `src/lib/mutation-guard.ts` 是 fail-closed：
   * 审计写不进去就 503「security audit unavailable」，绝不把未记录的操作报成成功。
   * 本函数把工具运行时对齐到同一语义：**返回审计错误，由调用方决定怎么报**。
   */
  const recordAudit = async (event: AgentAuditEvent): Promise<string | null> => {
    try {
      await writeAgentAction(auditCtx, event);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[tool-runtime] agent action audit failed:', toolId, message);
      return message;
    }
  };

  /** 审计失败时的统一措辞：调用方与被拒绝/普通失败区分得开。 */
  const auditUnavailable = (message: string) => `security audit unavailable: ${message}`;

  const tool = getEnterpriseTool(toolId);
  if (!tool) {
    return { ok: false, toolId, error: `unknown tool: ${toolId}`, durationMs: Date.now() - t0 };
  }

  // 1. Permission —— RBAC 权限 + Agent 角色命名空间
  if (!hasPermission(ctx.role, tool.requiredPermission)) {
    const deniedReason = `permission denied: ${tool.requiredPermission}`;
    const auditError = await recordAudit(auditEvent('blocked', deniedReason));
    return {
      ok: false,
      toolId,
      blocked: true,
      // 拒绝本身也必须有记录。记不下来时把两件事都写进 error：
      // 调用方既要看得出"被拒绝"，也要看得出"这次拒绝没有留下证据"。
      error: auditError ? `${deniedReason} | ${auditUnavailable(auditError)}` : deniedReason,
      auditFailed: auditError ? true : undefined,
      durationMs: Date.now() - t0,
    };
  }
  if (!roleCanUseTool(ctx.agentRole, toolId)) {
    const deniedReason = `agent role '${ctx.agentRole}' may not use ${toolId}`;
    const auditError = await recordAudit(auditEvent('blocked', deniedReason));
    return {
      ok: false,
      toolId,
      blocked: true,
      error: auditError ? `${deniedReason} | ${auditUnavailable(auditError)}` : deniedReason,
      auditFailed: auditError ? true : undefined,
      durationMs: Date.now() - t0,
    };
  }

  // 2. 输入校验
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      toolId,
      error: `invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      durationMs: Date.now() - t0,
    };
  }

  // 3. Execution（超时保护 + 审计）
  try {
    const data = await Promise.race([
      tool.run(parsed.data, ctx),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('tool timed out')), TOOL_TIMEOUT_MS)
      ),
    ]);
    // ⚠️ 这里是本次修复的核心：工具**已经执行完了**才写审计。
    // 审计失败时绝不能报 ok:true —— 那等于"做了一件无法证明做过的事"。
    const auditError = await recordAudit(auditEvent('succeeded', 'ok'));
    if (auditError) {
      return {
        ok: false,
        toolId,
        error: auditUnavailable(auditError),
        auditFailed: true,
        durationMs: Date.now() - t0,
      };
    }
    return { ok: true, toolId, data, durationMs: Date.now() - t0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const auditError = await recordAudit(auditEvent('failed', message.slice(0, 200)));
    return {
      ok: false,
      toolId,
      error: auditError ? `${message} | ${auditUnavailable(auditError)}` : message,
      auditFailed: auditError ? true : undefined,
      durationMs: Date.now() - t0,
    };
  }
}
