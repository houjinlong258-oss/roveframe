import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const platform = searchParams.get('platform');
    const sentiment = searchParams.get('sentiment');
    const pending = searchParams.get('pending') === 'true';
    const client = getSupabaseClient();

    let query = client.from('reviews').select('*').order('created_at', { ascending: false }).limit(50);
    if (platform && platform !== 'all') query = query.eq('platform', platform);
    if (sentiment && sentiment !== 'all') query = query.eq('sentiment', sentiment);
    if (pending) query = query.eq('reply_status', 'none');
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // 统计
    const { data: all, error: sErr } = await client.from('reviews').select('rating, sentiment, reply_status');
    if (sErr) throw new Error(sErr.message);
    const rows = all ?? [];
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
    return jsonError(getErrorMessage(error));
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id: string; reply_content?: string; reply_status?: string };
    if (!body.id) return jsonError('missing id', 400);
    const client = getSupabaseClient();
    const updates: Record<string, string> = {};
    if (body.reply_content !== undefined) updates.reply_content = body.reply_content;
    if (body.reply_status) {
      updates.reply_status = body.reply_status;
      if (body.reply_status === 'published') updates.status = 'replied';
    }
    const { error } = await client.from('reviews').update(updates).eq('id', body.id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
