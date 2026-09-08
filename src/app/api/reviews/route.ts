import { json, jsonError, errorResponse } from '@/lib/api-helpers';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

export async function GET(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    // P0-4：读接口 RBAC —— staff 无 reviews:read（含客户昵称/评论原文）。
    requirePermission(ctx, 'reviews:read');
    const { searchParams } = new URL(request.url);
    const platform = searchParams.get('platform');
    const sentiment = searchParams.get('sentiment');
    const pending = searchParams.get('pending') === 'true';

    const q = scopedTable(ctx, 'reviews')
      .order('created_at', { ascending: false })
      .limit(50);
    const chained = (() => {
      let b: typeof q = q;
      if (platform && platform !== 'all') b = (b as unknown as { eq: (c: string, v: unknown) => typeof b }).eq('platform', platform);
      if (sentiment && sentiment !== 'all') b = (b as unknown as { eq: (c: string, v: unknown) => typeof b }).eq('sentiment', sentiment);
      if (pending) b = (b as unknown as { eq: (c: string, v: unknown) => typeof b }).eq('reply_status', 'none');
      return b;
    })();
    const { data, error } = await chained;
    if (error) throw new Error(error.message);

    // 统计
    const allRes = await scopedTable(ctx, 'reviews', 'rating, sentiment, reply_status');
    if (allRes.error) throw new Error(allRes.error.message);
    const rows = (allRes.data ?? []) as { rating: number; sentiment: string; reply_status: string }[];
    const avgRating = rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10 : 0;
    const positiveRate = rows.length ? Math.round((rows.filter((r) => r.rating >= 4).length / rows.length) * 100) : 0;
    const pendingCount = rows.filter((r) => r.reply_status === 'none').length;
    const total = rows.length || 1;
    const sentimentDist = {
      positive: Math.round((rows.filter((r) => r.sentiment === 'positive').length / total) * 100),
      neutral: Math.round((rows.filter((r) => r.sentiment === 'neutral').length / total) * 100),
      negative: Math.round((rows.filter((r) => r.sentiment === 'negative').length / total) * 100),
    };

    return json({ reviews: data ?? [], stats: { avgRating, positiveRate, pendingCount, sentimentDist, total: rows.length } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function updateReview(request: Request) {
  try {
    const ctx = await getTenantContext(request);
    const body = (await request.json()) as { id: string; reply_content?: string; reply_status?: string };
    if (!body.id) return jsonError('missing id', 400);
    const updates: Record<string, string> = {};
    if (body.reply_content !== undefined) updates.reply_content = body.reply_content;
    if (body.reply_status) {
      updates.reply_status = body.reply_status;
      if (body.reply_status === 'published') updates.status = 'replied';
    }
    const { error } = await updateWithScope(ctx, 'reviews', body.id, updates);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = protectBusinessMutation(
  { permission: 'reviews:write', action: 'reviews.update', entity: 'reviews' },
  updateReview,
);
