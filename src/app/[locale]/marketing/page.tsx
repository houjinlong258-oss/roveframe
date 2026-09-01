'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  CalendarHeart,
  Share2,
  MailPlus,
  Sparkles,
  FileOutput,
  Save,
  X,
  Inbox,
  Timer,
  SendHorizontal,
  LoaderCircle,
  Check,
  Trash2,
} from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { timeAgo } from '@/lib/format';

type ContentType = 'campaign' | 'social' | 'email';
type Segment = 'all' | 'high_value' | 'risk' | 'new';

interface Asset {
  id: string;
  type: ContentType;
  title: string;
  brief: string | null;
  content: string;
  status: string;
  created_at: string;
}

interface Preview {
  customer: { id: string; name: string; email: string | null };
  raw: string;
}

const TYPE_META: Record<ContentType, { icon: typeof CalendarHeart; color: string }> = {
  campaign: { icon: CalendarHeart, color: 'text-primary' },
  social: { icon: Share2, color: 'text-success' },
  email: { icon: MailPlus, color: 'text-warning' },
};

function parsePreview(raw: string): { subject: string; body: string; profile: string } {
  const subject = raw.match(/SUBJECT:\s*(.+)/)?.[1]?.trim() ?? '';
  const profile = raw.match(/PROFILE:\s*(.+)/)?.[1]?.trim() ?? '';
  const body = (raw.split('---')[1] ?? raw).replace(/PROFILE:[\s\S]*$/, '').trim();
  return { subject, body, profile };
}

export default function MarketingPage() {
  const t = useTranslations('marketing');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [type, setType] = useState<ContentType>('campaign');
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const genRef = useRef(false);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [viewAsset, setViewAsset] = useState<Asset | null>(null);

  // 邮件营销
  const [segment, setSegment] = useState<Segment>('all');
  const [segmentCount, setSegmentCount] = useState<number | null>(null);
  const [sender, setSender] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    const res = await fetch('/api/marketing/contents');
    const data = await res.json();
    setAssets(data.contents ?? []);
  }, []);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  // 切换客群时刷新人数
  useEffect(() => {
    if (type !== 'email') return;
    fetch('/api/marketing/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'count', segment }),
    })
      .then((r) => r.json())
      .then((d) => {
        setSegmentCount(d.count ?? 0);
        setSender(d.sender ?? null);
      })
      .catch(() => setSegmentCount(null));
  }, [segment, type]);

  const generate = async () => {
    if (!brief.trim() || genRef.current) return;
    genRef.current = true;
    setGenerating(true);
    setResult('');
    try {
      const res = await fetch('/api/marketing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, brief, locale }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.text) setResult((prev) => prev + j.text);
            } catch {
              // skip
            }
          }
        }
      }
    } finally {
      setGenerating(false);
      genRef.current = false;
    }
  };

  const saveAsset = async () => {
    if (!result.trim()) return;
    setSaving(true);
    try {
      const titleLine = result.split('\n').find((l) => l.replace(/[#*]/g, '').trim().length > 0) ?? brief.slice(0, 40);
      await fetch('/api/marketing/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title: titleLine.replace(/[#*]/g, '').trim().slice(0, 80), brief, content: result }),
      });
      await loadAssets();
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const deleteAsset = async (id: string) => {
    await fetch(`/api/marketing/contents?id=${id}`, { method: 'DELETE' });
    setViewAsset(null);
    await loadAssets();
  };

  const loadPreviews = async () => {
    setPreviewLoading(true);
    setPreviews([]);
    setPreviewIdx(0);
    try {
      const res = await fetch('/api/marketing/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', segment, brief, locale }),
      });
      const data = await res.json();
      setPreviews(data.previews ?? []);
      if (data.sender) setSender(data.sender);
    } finally {
      setPreviewLoading(false);
    }
  };

  const startSend = async () => {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch('/api/marketing/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', segment, brief, locale }),
      });
      const data = await res.json();
      setSendResult(t('queuedResult', { count: data.queued ?? 0 }));
    } finally {
      setSending(false);
    }
  };

  const segments: { key: Segment; label: string }[] = [
    { key: 'all', label: t('segAll') },
    { key: 'high_value', label: t('segHighValue') },
    { key: 'risk', label: t('segRisk') },
    { key: 'new', label: t('segNew') },
  ];

  const currentPreview = previews[previewIdx] ? parsePreview(previews[previewIdx].raw) : null;

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-[1.5fr_1fr] gap-4 items-start">
        {/* 左侧：生成工作台 */}
        <div className="space-y-4">
          <div className="bg-surface rounded-lg shadow-card p-5">
            <h2 className="text-base font-semibold mb-4">{t('workbench')}</h2>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {(Object.keys(TYPE_META) as ContentType[]).map((k) => {
                const M = TYPE_META[k];
                const active = type === k;
                return (
                  <button
                    key={k}
                    onClick={() => setType(k)}
                    className={`rounded-md px-3 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                      active ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    <M.icon className="w-4 h-4" />
                    {t(`types.${k}`)}
                  </button>
                );
              })}
            </div>
            <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('briefLabel')}</label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder={t('briefPlaceholder')}
              className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none mb-3"
            />
            <button
              onClick={generate}
              disabled={generating || !brief.trim()}
              className="w-full bg-primary text-on-primary px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <Sparkles className="w-4 h-4" />
              {generating ? tc('generating') : t('generate')}
            </button>
          </div>

          {/* 生成结果 */}
          <div className="bg-surface rounded-lg shadow-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <span className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                  <FileOutput className="w-3.5 h-3.5" />
                </span>
                {t('result')}
              </h2>
              <button
                onClick={saveAsset}
                disabled={!result.trim() || saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-medium bg-success/15 text-success hover:bg-success/25 transition-all disabled:opacity-50"
              >
                {savedTick ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
                {savedTick ? t('saved') : t('saveAsset')}
              </button>
            </div>
            {result || generating ? (
              <div className="text-sm leading-relaxed">
                <Markdown content={result || tc('generating')} />
              </div>
            ) : (
              <p className="text-sm text-on-surface-variant/60 text-center py-8">{t('resultEmpty')}</p>
            )}
          </div>

          {/* 邮件营销：个性化生成与发送 */}
          {type === 'email' && (
            <div className="bg-surface rounded-lg shadow-card p-5 space-y-5">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <span className="w-6 h-6 rounded-md bg-warning/15 text-warning flex items-center justify-center">
                    <MailPlus className="w-3.5 h-3.5" />
                  </span>
                  {t('personalizedTitle')}
                </h2>
                <p className="text-xs text-on-surface-variant mt-1.5">{t('personalizedDesc')}</p>
              </div>

              {/* 客群圈选 */}
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-2">{t('segmentLabel')}</label>
                <div className="flex flex-wrap gap-2">
                  {segments.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setSegment(s.key)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        segment === s.key
                          ? 'bg-primary/10 text-primary'
                          : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {s.label}
                      {segment === s.key && segmentCount !== null ? ` · ${segmentCount}` : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* 个性化预览 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-medium text-on-surface-variant">{t('previewLabel')}</label>
                  <button
                    onClick={loadPreviews}
                    disabled={previewLoading}
                    className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {previewLoading ? tc('loading') : previews.length > 0 ? t('regenPreview') : t('loadPreview')}
                  </button>
                </div>
                {previews.length > 0 && (
                  <>
                    <div className="flex gap-2 mb-3">
                      {previews.map((p, i) => (
                        <button
                          key={p.customer.id}
                          onClick={() => setPreviewIdx(i)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                            previewIdx === i
                              ? 'bg-primary/10 text-primary'
                              : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                          }`}
                        >
                          {p.customer.name}
                        </button>
                      ))}
                    </div>
                    {currentPreview && (
                      <div className="rounded-md bg-surface-container/50 p-4">
                        <p className="text-xs text-on-surface-variant mb-1.5">{currentPreview.subject}</p>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{currentPreview.body}</p>
                        {currentPreview.profile && (
                          <p className="text-[11px] text-on-surface-variant/70 mt-2">
                            {t('profileCited')}：{currentPreview.profile}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 发送区 */}
              <div className="rounded-md bg-surface-container/50 p-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="text-xs text-on-surface-variant space-y-1">
                  <p className="flex items-center gap-1.5">
                    <Inbox className="w-3.5 h-3.5" />
                    {t('senderAccount')}：<span className="font-medium text-on-surface">{sender ?? t('noSender')}</span>
                  </p>
                  <p className="flex items-center gap-1.5">
                    <Timer className="w-3.5 h-3.5" />
                    {t('sendEstimate', { count: segmentCount ?? 0, minutes: segmentCount ?? 0 })}
                  </p>
                </div>
                <button
                  onClick={startSend}
                  disabled={sending || !sender || (segmentCount ?? 0) === 0}
                  className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2 disabled:opacity-60"
                >
                  <SendHorizontal className="w-3.5 h-3.5" />
                  {sending ? t('queueing') : t('startSend')}
                </button>
              </div>
              {sendResult && (
                <div className="rounded-md bg-success/10 p-3.5 flex items-center gap-3">
                  <LoaderCircle className="w-4 h-4 text-success shrink-0" />
                  <p className="text-xs font-medium text-success">{sendResult}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右侧：内容资产 */}
        <div className="bg-surface rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">{t('assets')}</h2>
            <span className="text-xs text-on-surface-variant">{t('assetCount', { count: assets.length })}</span>
          </div>
          <div className="space-y-3">
            {assets.length === 0 ? (
              <p className="text-sm text-on-surface-variant/60 text-center py-8">{tc('noData')}</p>
            ) : (
              assets.map((a) => {
                const M = TYPE_META[a.type] ?? TYPE_META.campaign;
                return (
                  <button
                    key={a.id}
                    onClick={() => setViewAsset(a)}
                    className="w-full text-left rounded-md bg-surface-container/60 p-3.5 hover:bg-surface-container transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${M.color}`}>
                        <M.icon className="w-3.5 h-3.5" />
                        {t(`types.${a.type}`)}
                      </span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium ${
                          a.status === 'adopted' ? 'bg-success/15 text-success' : 'bg-surface-container-high text-on-surface-variant'
                        }`}
                      >
                        {t(`statuses.${a.status}` as 'statuses.draft')}
                      </span>
                    </div>
                    <p className="text-sm font-medium">{a.title}</p>
                    <p className="text-xs text-on-surface-variant mt-1 truncate">{a.brief ?? a.content.slice(0, 60)}</p>
                    <p className="text-xs text-on-surface-variant/70 mt-2">{timeAgo(a.created_at, locale)}</p>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* 内容查看弹窗 */}
      {viewAsset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setViewAsset(null)}>
          <div
            className="bg-surface rounded-xl shadow-dialog max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {(() => {
                  const M = TYPE_META[viewAsset.type] ?? TYPE_META.campaign;
                  return (
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${M.color}`}>
                      <M.icon className="w-3.5 h-3.5" />
                      {t(`types.${viewAsset.type}`)}
                    </span>
                  );
                })()}
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium ${
                    viewAsset.status === 'adopted' ? 'bg-success/15 text-success' : 'bg-surface-container-high text-on-surface-variant'
                  }`}
                >
                  {t(`statuses.${viewAsset.status}` as 'statuses.draft')}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => deleteAsset(viewAsset.id)}
                  className="w-8 h-8 rounded-md hover:bg-error/10 text-on-surface-variant hover:text-error flex items-center justify-center transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewAsset(null)}
                  className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <h3 className="text-lg font-bold mb-4">{viewAsset.title}</h3>
            <div className="text-sm leading-relaxed">
              <Markdown content={viewAsset.content} />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
