/**
 * Phase 6 — Deployment Engine
 * POST /api/deployment — 输入服务器/域名/环境，生成部署产物包（owner only）
 *
 * Body: { domain?, port?, environment?, imageName?, healthPath?, sslEmail? }
 * Returns: DeploymentPlan（artifacts 内联，不落盘、不触碰服务器）
 */

import { NextRequest } from 'next/server';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { writeAudit } from '@/lib/audit';
import { generateDeploymentPlan, validateDeploymentConfig } from '@/lib/deployment/generator';
import { protectBusinessMutation } from '@/lib/mutation-guard';

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const check = validateDeploymentConfig({
    domain: typeof input.domain === 'string' && input.domain ? input.domain : undefined,
    port: typeof input.port === 'number' ? input.port : undefined,
    environment:
      input.environment === 'staging' || input.environment === 'production'
        ? input.environment
        : undefined,
    imageName: typeof input.imageName === 'string' ? input.imageName : undefined,
    healthPath: typeof input.healthPath === 'string' ? input.healthPath : undefined,
    sslEmail: typeof input.sslEmail === 'string' && input.sslEmail ? input.sslEmail : undefined,
  });
  if (!check.valid) {
    return jsonError(check.errors.join('; '), 400);
  }

  try {
    const plan = generateDeploymentPlan(input);

    await writeAudit({
      tenantId: ctx.tenantId,
      actorId: ctx.user.userId,
      action: 'deployment.plan_generated',
      entity: 'deployment',
      after: {
        domain: plan.config.domain ?? null,
        environment: plan.config.environment,
        port: plan.config.port,
        artifactCount: plan.artifacts.length,
      },
    });

    return json(plan);
  } catch (e) {
    return jsonError(getErrorMessage(e), 500);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'deployment:write', action: 'deployment.plan', entity: 'deployment' },
  withAuth(handlePost, { roles: ['owner'] }),
);
