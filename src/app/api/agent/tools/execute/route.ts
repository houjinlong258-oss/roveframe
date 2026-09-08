import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorResponse, json } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { withAgentAudit, registerDefaultReadTools } from '@/lib/agent';
import { agentToolRegistry } from '@/lib/agent';
import { getSettings } from '@/lib/settings';
import { protectBusinessMutation } from '@/lib/mutation-guard';

const requestSchema = z.object({
  tool: z.string().trim().min(1).max(128),
  input: z.unknown().optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  turnId: z.string().trim().min(1).max(128).optional(),
});

registerDefaultReadTools();

/** Internal Agent Tool boundary. The caller cannot choose tenant/business/user scope. */
async function executeAgentTool(request: Request) {
  try {
    const context = await getTenantContext(request);
    if (!context.businessId) {
      return json({ error: 'business scope is required before Agent tools can run' }, 409);
    }

    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: 'invalid tool request', details: parsed.error.flatten() }, 400);
    }

    const settings = await getSettings(context.tenantId, context.businessId);
    const localeSettings = (settings.locale ?? {}) as Record<string, unknown>;
    const agentContext = withAgentAudit({
      tenantId: context.tenantId,
      businessId: context.businessId,
      userId: context.userId,
      role: context.role,
      sessionId: parsed.data.sessionId ?? randomUUID(),
      turnId: parsed.data.turnId ?? randomUUID(),
      locale: request.headers.get('accept-language')?.split(',')[0]?.split('-')[0] ?? 'en',
      timeZone: typeof localeSettings.timezone === 'string' ? localeSettings.timezone : 'America/New_York',
    });
    const result = await agentToolRegistry.execute(parsed.data.tool, parsed.data.input ?? {}, agentContext);
    if (!result.ok) {
      const status = result.error.code === 'forbidden'
        ? 403
        : result.error.code === 'tool_not_found'
          ? 404
          : result.error.code === 'tool_timeout'
            ? 504
            : result.error.code === 'invalid_input'
              ? 400
              : 422;
      return json(result, status);
    }
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'agent:use', action: 'agent_tools.execute', entity: 'agent_actions' },
  executeAgentTool,
);
