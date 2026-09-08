import { getForwardHeaders, jsonError, errorResponse, sseResponse } from '@/lib/api-helpers';
import { streamChat, type ChatMessage } from '@/lib/ai/router';
import { getTenantContext } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

async function draftReviewReply(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const body = (await request.json()) as { review_id: string; locale?: string };
    if (!body.review_id) return jsonError('missing review_id', 400);
    const locale = body.locale ?? 'en';

    const reviewRes = await scopedTable(ctx, 'reviews', 'author_name, platform, rating, content, sentiment')
      .eq('id', body.review_id)
      .maybeSingle();
    if (reviewRes.error) throw new Error(reviewRes.error.message);
    const review = reviewRes.data as { author_name: string; platform: string; rating: number; content: string; sentiment: string } | null;
    if (!review) return jsonError('review not found', 404);

    const systemPrompt = locale === 'zh'
      ? `你是餐厅的客服负责人，为店铺回复顾客评论。要求：
- 语气真诚、专业，不套模板
- 差评：先致歉，针对具体问题给出改进措施和补偿方案
- 好评：感谢并提及顾客点到的具体菜品/细节，邀请再来
- 100-180 字，直接输出回复正文，不要任何前缀`
      : `You are the restaurant's customer care lead, replying to a customer review. Requirements:
- Sincere, professional tone — no canned templates
- Negative reviews: apologize first, address the specific issue with concrete improvements and compensation
- Positive reviews: thank them, mention the specific dish/details they praised, invite them back
- 80-150 words, output ONLY the reply body, no prefix`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Platform: ${review.platform}\nRating: ${review.rating}/5\nCustomer: ${review.author_name}\nReview: ${review.content}`,
      },
    ];

    // 流式生成 + 结束后落库草稿（tenant 化）
    const scopedContext = ctx;
    const reviewId = body.review_id;
    async function* wrapped(): AsyncGenerator<string> {
      let full = '';
      for await (const chunk of streamChat('agent', messages, getForwardHeaders(request), { tenantId: ctx.tenantId, businessId: ctx.businessId, userId: ctx.userId })) {
        full += chunk;
        yield chunk;
      }
      const { error: upErr } = await updateWithScope(scopedContext, 'reviews', reviewId, {
        reply_content: full,
        reply_status: 'draft',
      });
      if (upErr) throw new Error(upErr.message);
    }

    return sseResponse(wrapped());
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'reviews:write', action: 'reviews.draft_reply', entity: 'reviews' },
  draftReviewReply,
);
