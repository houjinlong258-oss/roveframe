/**
 * Phase 5 — AI Customization Engine
 * /api/customization — REST endpoint
 *
 * POST /api/customization — 自然语言定制：{ prompt } → AI 选模板 + 参数抽取 → 应用
 *                           （owner/manager；全程审计）
 * GET  /api/customization — 列出可用定制模板（任意登录用户）
 */

import { NextRequest } from 'next/server';
import { json, jsonError, getForwardHeaders } from '@/lib/api-helpers';
import { withAuth, type AuthContext } from '@/lib/auth-guard';
import { writeAudit } from '@/lib/audit';
import { nlCustomizationEngine } from '@/lib/customization/nl-engine';
import { protectBusinessMutation } from '@/lib/mutation-guard';

async function handlePost(request: NextRequest, ctx: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const prompt = (body as Record<string, unknown>).prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return jsonError('prompt (non-empty string) is required', 400);
  }

  const result = await nlCustomizationEngine.parseAndApplyNLIntentAsync(
    prompt.slice(0, 1000),
    getForwardHeaders(request)
  );

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.user.userId,
    action: result.success ? 'customization.nl_applied' : 'customization.nl_rejected',
    entity: 'customization_template',
    entityId: result.templateId ?? null,
    after: {
      prompt: prompt.slice(0, 200),
      channel: result.channel ?? null,
      config: result.generatedConfig ?? null,
    },
  });

  if (!result.success) {
    return json({ success: false, errors: result.errors }, 422);
  }
  return json({
    success: true,
    templateId: result.templateId,
    templateName: result.templateName,
    channel: result.channel,
    generatedConfig: result.generatedConfig,
  });
}

async function handleGet(): Promise<Response> {
  return json({ templates: nlCustomizationEngine.listTemplates() });
}

export const POST = protectBusinessMutation(
  { permission: 'customization:write', action: 'customization.apply', entity: 'customization_template' },
  withAuth(handlePost, { roles: ['owner', 'manager'] }),
);
export const GET = withAuth(handleGet);
