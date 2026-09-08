import { NextRequest, NextResponse } from 'next/server';
import { streamChat } from '@/lib/ai/router';
import { contextToPrompt, getBusinessContext } from '@/lib/business-context';
import { sseResponse } from '@/lib/api-helpers';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

const TYPE_PROMPTS: Record<string, string> = {
  campaign: 'Create a marketing campaign plan with: campaign name, background insight, concrete offers/mechanics (with dates and prices), promotion schedule, and measurable goals.',
  social: 'Write an engaging social media post (e.g. for Instagram / Xiaohongshu style). Include a catchy hook, dish highlights, hashtags, and a call-to-action.',
  email: 'Write a marketing email: subject line + body. Warm, personal, with a clear offer and call-to-action.',
};

// 生成营销内容（流式）
async function generateMarketing(request: NextRequest) {
  const tenant = requireBusinessContext(await getTenantContext(request));
  requirePermission(tenant, 'marketing:write');
  const body = await request.json();
  const type = (body.type as string) ?? 'campaign';
  const brief = (body.brief as string) ?? '';
  const locale = (body.locale as string) ?? 'en';
  if (!brief.trim()) return NextResponse.json({ error: 'brief required' }, { status: 400 });

  const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const ctx = await getBusinessContext(tenant.tenantId, tenant.businessId);
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? 'Español' : 'English';

  return sseResponse(
    streamChat(
      'content',
      [
        {
          role: 'system',
          content: `You are the marketing director of a small restaurant. Reply in ${lang}, formatted with concise markdown (## sections, bold key info). ${TYPE_PROMPTS[type] ?? TYPE_PROMPTS.campaign}\n\nCurrent business snapshot:\n${contextToPrompt(ctx, locale)}`,
        },
        { role: 'user', content: brief },
      ],
      forwardHeaders,
      { tenantId: tenant.tenantId, businessId: tenant.businessId, userId: tenant.userId }
    )
  );
}

export const POST = protectBusinessMutation(
  { permission: 'marketing:write', action: 'marketing.generate', entity: 'marketing_contents' },
  generateMarketing,
);
