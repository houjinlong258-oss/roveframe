export type AgentRole = 'analytics_agent' | 'marketing_agent' | 'coding_agent' | 'general_agent';

export type AccessAction = 'READ' | 'WRITE';

export interface PermissionPolicy {
  allowedReadResources: string[];
  allowedWriteResources: string[];
  allowedReadPaths: RegExp[];
  allowedWritePaths: RegExp[];
  forbiddenPaths: RegExp[];
  forbiddenResources: string[];
}

const AGENT_POLICIES: Record<AgentRole, PermissionPolicy> = {
  analytics_agent: {
    allowedReadResources: ['sales', 'reviews', 'customers', 'orders', 'kpis'],
    allowedWriteResources: [],
    allowedReadPaths: [/^src\/custom\//, /^messages\//],
    allowedWritePaths: [],
    forbiddenPaths: [/^src\/core\//, /^src\/app\/api\//],
    forbiddenResources: ['code', 'payment', 'credentials', 'database_core'],
  },
  marketing_agent: {
    allowedReadResources: ['products', 'customers', 'marketing_assets'],
    allowedWriteResources: ['marketing_content', 'email_campaigns'],
    allowedReadPaths: [/^src\/custom\//, /^messages\//],
    allowedWritePaths: [/^src\/custom\/prompts\//, /^src\/custom\/workflows\//],
    forbiddenPaths: [/^src\/core\//, /^src\/app\/api\/auth\//],
    forbiddenResources: ['code', 'payment', 'credentials'],
  },
  coding_agent: {
    allowedReadResources: ['code', 'logs', 'errors', 'documentation', 'schema'],
    allowedWriteResources: ['custom_layer', 'plugins', 'unit_tests'],
    allowedReadPaths: [/^src\//, /^tests\//, /^messages\//],
    allowedWritePaths: [/^src\/custom\//, /^src\/plugins\//, /^tests\//],
    forbiddenPaths: [
      /^src\/core\//,
      /^src\/app\/api\/auth\//,
      /^src\/app\/api\/payment\//,
      /^src\/storage\/database\/supabase-client/,
    ],
    forbiddenResources: ['payment', 'authentication', 'production_database', 'master_credentials'],
  },
  general_agent: {
    allowedReadResources: ['kpis', 'products', 'reviews', 'orders'],
    allowedWriteResources: ['approvals'],
    allowedReadPaths: [/^src\/custom\//],
    allowedWritePaths: [],
    forbiddenPaths: [/^src\/core\//],
    forbiddenResources: ['code', 'payment', 'credentials'],
  },
};

export class AgentPermissionEngine {
  /** Verify if an agent role can read/write a specific file path. */
  public canAccessPath(
    role: AgentRole,
    action: AccessAction,
    filePath: string
  ): { allowed: boolean; reason?: string } {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const policy = AGENT_POLICIES[role];

    if (!policy) {
      return { allowed: false, reason: `Unknown agent role "${role}"` };
    }

    // Check forbidden paths first
    for (const forbidden of policy.forbiddenPaths) {
      if (forbidden.test(normalizedPath)) {
        return {
          allowed: false,
          reason: `Agent role "${role}" is explicitly forbidden from accessing path "${normalizedPath}"`,
        };
      }
    }

    if (action === 'WRITE') {
      const isAllowed = policy.allowedWritePaths.some((pattern) => pattern.test(normalizedPath));
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Agent role "${role}" is not granted WRITE permission for path "${normalizedPath}"`,
        };
      }
      return { allowed: true };
    }

    // READ action
    const isAllowedRead = policy.allowedReadPaths.some((pattern) => pattern.test(normalizedPath));
    if (!isAllowedRead) {
      return {
        allowed: false,
        reason: `Agent role "${role}" is not granted READ permission for path "${normalizedPath}"`,
      };
    }

    return { allowed: true };
  }

  /** Verify if an agent role can read/write a specific business resource. */
  public canAccessResource(
    role: AgentRole,
    action: AccessAction,
    resource: string
  ): { allowed: boolean; reason?: string } {
    const policy = AGENT_POLICIES[role];
    if (!policy) {
      return { allowed: false, reason: `Unknown agent role "${role}"` };
    }

    if (policy.forbiddenResources.includes(resource)) {
      return {
        allowed: false,
        reason: `Agent role "${role}" is explicitly forbidden from resource "${resource}"`,
      };
    }

    if (action === 'WRITE') {
      const canWrite = policy.allowedWriteResources.includes(resource);
      if (!canWrite) {
        return {
          allowed: false,
          reason: `Agent role "${role}" does not have WRITE permission for resource "${resource}"`,
        };
      }
      return { allowed: true };
    }

    const canRead = policy.allowedReadResources.includes(resource);
    if (!canRead) {
      return {
        allowed: false,
        reason: `Agent role "${role}" does not have READ permission for resource "${resource}"`,
      };
    }

    return { allowed: true };
  }
}

export const agentPermissionEngine = new AgentPermissionEngine();
