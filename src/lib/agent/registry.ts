import { hasPermission } from '@/lib/rbac';
import type {
  AgentActionStatus,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolFailure,
  AgentToolResult,
} from '@/lib/agent/types';

const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_TOOL_TIMEOUT_MS = 120_000;
const SENSITIVE_INPUT_KEY = /(key|token|secret|password|credential|authorization|cookie)/i;

function failure(code: string, message: string): AgentToolFailure {
  return { ok: false, error: { code, message } };
}

function summarizeResult(result: AgentToolResult): string {
  if (!result.ok) return result.error.message.slice(0, 500);
  try {
    return JSON.stringify(result.data).slice(0, 500);
  } catch {
    return '[unserializable tool result]';
  }
}

function normalizeStatus(result: AgentToolResult): AgentActionStatus {
  return result.ok ? 'succeeded' : 'failed';
}

function redactAuditInput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_INPUT_KEY.test(key)) {
      result[key] = '[REDACTED]';
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      result[key] = redactAuditInput(item) ?? '[OBJECT]';
    } else if (typeof item === 'string') {
      result[key] = item.slice(0, 500);
    } else {
      result[key] = item;
    }
  }
  return result;
}

async function executeWithTimeout(
  execute: () => Promise<AgentToolResult>,
  timeoutMs: number,
): Promise<AgentToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<AgentToolFailure>((resolve) => {
        timer = setTimeout(
          () => resolve(failure('tool_timeout', `Tool timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Business Tool Registry.
 *
 * Tools are registered explicitly and execute only with a server-created
 * tenant/business context. This is intentionally independent of the LLM
 * provider so the same tools can later serve PWA, API, scheduled tasks, and
 * channel-based Agent sessions.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<unknown, unknown>>();

  register<TInput, TData>(definition: AgentToolDefinition<TInput, TData>): this {
    if (!definition.name.trim()) throw new Error('Agent tool name is required');
    if (this.tools.has(definition.name)) {
      throw new Error(`Agent tool already registered: ${definition.name}`);
    }

    const timeoutMs = definition.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS;
    if (timeoutMs < 1 || timeoutMs > MAX_TOOL_TIMEOUT_MS) {
      throw new Error(`Invalid timeout for Agent tool ${definition.name}`);
    }
    const approvalPolicy = definition.approvalPolicy ?? 'none';
    if ((definition.risk === 'external_side_effect' || definition.risk === 'destructive')
      && approvalPolicy === 'none') {
      throw new Error(`High-risk Agent tool ${definition.name} requires an approval policy`);
    }

    this.tools.set(definition.name, {
      ...definition,
      timeoutMs,
      requiredPermissions: definition.requiredPermissions ?? [definition.requiredPermission],
      approvalPolicy,
      auditCategory: definition.auditCategory ?? definition.action,
    } as AgentToolDefinition<unknown, unknown>);
    return this;
  }

  get(name: string): AgentToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): AgentToolDefinition<unknown, unknown>[] {
    return Array.from(this.tools.values());
  }

  /** Return only tools the current role may see and the model can call safely. */
  modelTools(role: AgentToolContext['role']): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.list()
      .filter((definition) => definition.modelInputSchema
        && (definition.requiredPermissions ?? [definition.requiredPermission])
          .every((permission) => hasPermission(role, permission)))
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.modelInputSchema!,
      }));
  }

  async execute(
    name: string,
    rawInput: unknown,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const definition = this.tools.get(name);
    if (!definition) return failure('tool_not_found', `Unknown Agent tool: ${name}`);

    const startedAt = new Date().toISOString();
    const inputForAudit = redactAuditInput(rawInput);

    const parsed = definition.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      await context.audit({
        tool: definition.name,
        action: definition.action,
        status: 'blocked',
        input: inputForAudit,
        errorCode: 'invalid_input',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return failure('invalid_input', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }

    const missingContext = Object.entries({
      tenantId: context.tenantId,
      businessId: context.businessId,
      userId: context.userId,
      role: context.role,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }).filter(([, value]) => !value).map(([key]) => key);
    if (missingContext.length > 0) {
      await context.audit({
        tool: definition.name,
        action: definition.action,
        status: 'blocked',
        input: inputForAudit,
        errorCode: 'missing_context',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return failure('missing_context', `Missing trusted context: ${missingContext.join(', ')}`);
    }

    const requiredPermissions = definition.requiredPermissions ?? [definition.requiredPermission];
    const missingPermissions = requiredPermissions.filter((permission) => !hasPermission(context.role, permission));
    if (missingPermissions.length > 0) {
      await context.audit({
        tool: definition.name,
        action: definition.action,
        status: 'blocked',
        input: inputForAudit,
        errorCode: 'forbidden',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return failure('forbidden', `Missing permission: ${missingPermissions.join(', ')}`);
    }

    if ((definition.risk === 'external_side_effect' || definition.risk === 'destructive')
      && (definition.approvalPolicy ?? 'none') === 'none') {
      await context.audit({
        tool: definition.name,
        action: definition.action,
        status: 'blocked',
        input: inputForAudit,
        errorCode: 'approval_policy_missing',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return failure('approval_policy_missing', 'High-risk tool is missing an approval policy');
    }

    await context.audit({
      tool: definition.name,
      action: definition.action,
      status: 'started',
      input: inputForAudit,
      startedAt,
    });

    let result: AgentToolResult;
    try {
      result = await executeWithTimeout(
        () => definition.execute(parsed.data, context),
        definition.timeoutMs,
      );
    } catch (error) {
      result = failure('tool_error', error instanceof Error ? error.message : 'Agent tool failed');
    }

    const status = !result.ok && result.error.code === 'tool_timeout'
      ? 'timed_out'
      : normalizeStatus(result);
    await context.audit({
      tool: definition.name,
      action: definition.action,
      status,
      resultSummary: summarizeResult(result),
      errorCode: result.ok ? undefined : result.error.code,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return result;
  }
}

export const agentToolRegistry = new AgentToolRegistry();
