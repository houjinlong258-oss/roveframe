'use client';

import { useEffect, useState, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  Star, ThumbsUp, MessageSquareWarning, Sparkles, Wand2, RefreshCcw, Check,
  Globe, MapPin, Loader2, Pencil,
} from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';

type Review = {
  id: string; author_name: string; platform: string; rating: number; content: string;
  sentiment: string; status: string; reply_content: string | null; reply_status: string;
  created_at: string;
};

type Stats = {
  avgRating: number; positiveRate: number; pendingCount: number;
  sentimentDist: { positive: number; neutral: number; negative: number };
};

const PLATFORM_ICONS: Record<string, typeof Globe> = { google: Globe, yelp: MapPin, facebook: Globe };
const AVATAR_COLORS = ['bg-primary/10 text-primary', 'bg-warning/15 text-warning', 'bg-success/15 text-success', 'bg-destructive/15 text-destructive'];
const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'bg-success/15 text-success',
  neutral: 'bg-warning/15 text-warning',
  negative: 'bg-destructive/15 text-destructive',
};

function ReviewsContent() {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [platform, setPlatform] = useState('all');
  const [sentiment, setSentiment] = useState('all');
  const [onlyPending, setOnlyPending] = useState(searchParams.get('filter') === 'pending');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const { streaming, start } = useSSE();

  const load = async () => {
    const params = new URLSearchParams({ platform, sentiment, pending: String(onlyPending) });
    const d = await fetch(`/api/reviews?${params}`).then((r) => r.json()).catch(() => ({ reviews: [] }));
    setReviews(d.reviews ?? []);
    setStats(d.stats ?? null);
  };

  useEffect(() => { load(); }, [platform, sentiment, onlyPending]);

  const generateReply = async (review: Review) => {
    if (streaming) return;
    setStreamingId(review.id);
    setReviews((prev) => prev.map((r) => (r.id === review.id ? { ...r, reply_content: '', reply_status: 'draft' } : r)));
    await start({
      url: '/api/reviews/reply',
      body: { review_id: review.id, locale },
      onChunk: (chunk) => {
        setReviews((prev) => prev.map((r) => (r.id === review.id ? { ...r, reply_content: (r.reply_content ?? '') + chunk } : r)));
      },
      onDone: () => setStreamingId(null),
      onError: () => setStreamingId(null),
    });
  };

  const markPublished = async (review: Review) => {
    await fetch('/api/reviews', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: review.id, reply_status: 'published' }),
    });
    load();
  };

  const saveEdit = async (review: Review) => {
    await fetch('/api/reviews', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: review.id, reply_content: editText }),
    });
    setEditingId(null);
    load();
  };

  return (
    <div>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
        </div>
      </div>

      {/* 统计条 */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <div className="bg-card rounded-lg shadow-card p-4 flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-warning/15 text-warning flex items-center justify-center"><Star className="w-4.5 h-4.5" /></span>
          <div>
            <div className="text-xl font-bold">{stats?.avgRating ?? '-'}<span className="text-sm font-normal text-muted-foreground"> / 5</span></div>
            <div className="text-xs text-muted-foreground">{t('avgRating')}</div>
          </div>
        </div>
        <div className="bg-card rounded-lg shadow-card p-4 flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-success/15 text-success flex items-center justify-center"><ThumbsUp className="w-4.5 h-4.5" /></span>
          <div>
            <div className="text-xl font-bold">{stats?.positiveRate ?? '-'}%</div>
            <div className="text-xs text-muted-foreground">{t('positiveRate')}</div>
          </div>
        </div>
        <div className="bg-card rounded-lg shadow-card p-4 flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-destructive/15 text-destructive flex items-center justify-center"><MessageSquareWarning className="w-4.5 h-4.5" /></span>
          <div>
            <div className="text-xl font-bold">{stats?.pendingCount ?? '-'}</div>
            <div className="text-xs text-muted-foreground">{t('pendingReply')}</div>
          </div>
        </div>
        <div className="bg-card rounded-lg shadow-card p-4">
          <div className="text-xs text-muted-foreground mb-2">{t('sentimentDist')}</div>
          <div className="h-2.5 rounded-full overflow-hidden flex">
            <div className="bg-success" style={{ width: `${stats?.sentimentDist.positive ?? 0}%` }} />
            <div className="bg-warning" style={{ width: `${stats?.sentimentDist.neutral ?? 0}%` }} />
            <div className="bg-destructive" style={{ width: `${stats?.sentimentDist.negative ?? 0}%` }} />
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success inline-block" />{t('positive')} {stats?.sentimentDist.positive ?? 0}%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warning inline-block" />{t('neutral')} {stats?.sentimentDist.neutral ?? 0}%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-destructive inline-block" />{t('negative')} {stats?.sentimentDist.negative ?? 0}%</span>
          </div>
        </div>
      </div>

      {/* 筛选行 */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="bg-muted border-none rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
        >
          <option value="all">{t('filterPlatform')}</option>
          <option value="google">Google</option>
          <option value="yelp">Yelp</option>
          <option value="facebook">Facebook</option>
        </select>
        <select
          value={sentiment}
          onChange={(e) => setSentiment(e.target.value)}
          className="bg-muted border-none rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
        >
          <option value="all">{t('filterSentiment')}</option>
          <option value="positive">{t('positive')}</option>
          <option value="neutral">{t('neutral')}</option>
          <option value="negative">{t('negative')}</option>
        </select>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
            className="w-4 h-4 rounded accent-[#2F6BFF]"
          />
          <span className="text-sm text-muted-foreground">{t('onlyPending')}</span>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{reviews.length}</span>
      </div>

      {/* 评论列表 */}
      <div className="space-y-4">
        {reviews.map((review, i) => {
          const PlatformIcon = PLATFORM_ICONS[review.platform] ?? Globe;
          const isStreaming = streaming && streamingId === review.id;
          return (
            <div key={review.id} className="bg-card rounded-lg shadow-card p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className={cn('w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold', AVATAR_COLORS[i % AVATAR_COLORS.length])}>
                    {review.author_name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{review.author_name}</span>
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-muted text-muted-foreground">
                        <PlatformIcon className="w-3 h-3" />{review.platform}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {Array(5).fill(0).map((_, s) => (
                        <Star key={s} className={cn('w-3.5 h-3.5', s < review.rating ? 'text-warning fill-warning' : 'text-border')} />
                      ))}
                      <span className="text-xs text-muted-foreground ml-1.5">{timeAgo(review.created_at, locale)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium', SENTIMENT_STYLE[review.sentiment])}>
                    {t(review.sentiment as 'positive')}
                  </span>
                  {review.reply_status === 'published' && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-success/15 text-success">{t('replied')}</span>
                  )}
                </div>
              </div>
              <p className="text-sm leading-relaxed mb-4">{review.content}</p>

              {/* AI 回复区 */}
              <div className="rounded-md bg-muted/60 p-4">
                {review.reply_status === 'none' && !isStreaming ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />{t('replyDraft')}
                    </span>
                    <button
                      onClick={() => generateReply(review)}
                      disabled={streaming}
                      className="bg-primary text-primary-foreground px-3 py-1.5 rounded-sm text-xs font-medium hover:opacity-90 transition-all inline-flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Wand2 className="w-3 h-3" />{t('generateReply')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-primary" />
                        {isStreaming ? t('analyzing') : review.reply_status === 'published' ? t('replied') : t('draft')}
                      </span>
                      {review.reply_status !== 'published' && !isStreaming && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setEditingId(review.id); setEditText(review.reply_content ?? ''); }}
                            className="px-2.5 py-1 rounded-sm text-xs font-medium bg-card text-muted-foreground hover:text-foreground shadow-card transition-all inline-flex items-center gap-1"
                          >
                            <Pencil className="w-3 h-3" />{t('editReply')}
                          </button>
                          <button
                            onClick={() => generateReply(review)}
                            className="px-2.5 py-1 rounded-sm text-xs font-medium bg-card text-muted-foreground hover:text-foreground shadow-card transition-all inline-flex items-center gap-1"
                          >
                            <RefreshCcw className="w-3 h-3" />{t('regenerate')}
                          </button>
                          <button
                            onClick={() => markPublished(review)}
                            className="px-2.5 py-1 rounded-sm text-xs font-medium bg-success/15 text-success hover:bg-success/25 transition-all inline-flex items-center gap-1"
                          >
                            <Check className="w-3 h-3" />{t('publish')}
                          </button>
                        </div>
                      )}
                      {isStreaming && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                    </div>
                    {editingId === review.id ? (
                      <div>
                        <textarea
                          rows={4}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="w-full bg-card border-none rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                          <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-sm text-xs font-medium text-muted-foreground hover:bg-card transition-colors">
                            {t('editReply')}
                          </button>
                          <button onClick={() => saveEdit(review)} className="bg-primary text-primary-foreground px-3 py-1.5 rounded-sm text-xs font-medium hover:opacity-90">
                            {t('publish')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{review.reply_content}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {reviews.length === 0 && (
          <div className="bg-card rounded-lg shadow-card p-12 text-center text-sm text-muted-foreground">-</div>
        )}
      </div>
    </div>
  );
}

export default function ReviewsPage() {
  return (
    <Suspense>
      <ReviewsContent />
    </Suspense>
  );
}
