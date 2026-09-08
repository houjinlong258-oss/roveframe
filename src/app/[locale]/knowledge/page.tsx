'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  Plus, Sparkles, Bot, FileText, Trash2, ClipboardList, Utensils, Crown,
  AlertTriangle, ChefHat, RefreshCcw, X, Pencil, Loader2,
} from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { Markdown } from '@/components/markdown';
import { cn, safeFetchJson } from '@/lib/utils';
import { saveJson } from '@/lib/fetch-utils';
import { fmtDate } from '@/lib/format';

type Doc = {
  id: string; title: string; category: string; content: string;
  status: string; updated_at: string;
};

const CATEGORIES = ['all', 'sop', 'product', 'policy'] as const;
const CAT_KEYS: Record<string, string> = { all: 'categoryAll', sop: 'categorySop', product: 'categoryProduct', policy: 'categoryPolicy' };
const CAT_STYLE: Record<string, { badge: string; iconBg: string; icons: typeof ClipboardList[] }> = {
  sop: { badge: 'bg-primary/10 text-primary', iconBg: 'bg-primary/10 text-primary', icons: [ClipboardList, AlertTriangle] },
  product: { badge: 'bg-success/15 text-success', iconBg: 'bg-success/15 text-success', icons: [Utensils, ChefHat] },
  policy: { badge: 'bg-warning/15 text-warning', iconBg: 'bg-warning/15 text-warning', icons: [Crown, RefreshCcw] },
};

export default function KnowledgePage() {
  const t = useTranslations('knowledge');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asked, setAsked] = useState('');
  const [sources, setSources] = useState<{ title: string }[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [form, setForm] = useState({ title: '', category: 'sop', content: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const [removing, setRemoving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const { streaming, start } = useSSE();

  const loadDocs = async () => {
    const d = await safeFetchJson(`/api/knowledge/docs?category=${category}`);
    setDocs(d?.docs ?? []);
  };

  useEffect(() => { loadDocs(); }, [category]);

  const ask = async () => {
    const q = question.trim();
    if (!q || streaming) return;
    setAsked(q);
    setAnswer('');
    setSources([]);
    setQuestion('');
    await start({
      url: '/api/knowledge/ask',
      body: { question: q, locale },
      onChunk: (chunk) => setAnswer((prev) => prev + chunk),
      onDone: (headers) => {
        const raw = headers.get('X-Sources');
        if (raw) {
          try { setSources(JSON.parse(decodeURIComponent(raw))); } catch { /* ignore */ }
        }
      },
    });
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ title: '', category: 'sop', content: '' });
    setModalOpen(true);
  };

  const openEdit = (doc: Doc) => {
    setEditing(doc);
    setForm({ title: doc.title, category: doc.category, content: doc.content });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.title.trim() || !form.content.trim() || saving) return;
    setSaving(true);
    // P0-7：失败不关弹窗不误报，按钮经 finally 复位
    try {
      if (editing) {
        await saveJson('/api/knowledge/docs', {
          method: 'PATCH',
          body: { id: editing.id, ...form },
        });
      } else {
        await saveJson('/api/knowledge/docs', {
          method: 'POST',
          body: form,
        });
      }
      setModalOpen(false);
      loadDocs();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('saveFail');
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      await saveJson(`/api/knowledge/docs?id=${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      loadDocs();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('saveFail');
      setSaveError(message);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={openCreate}
          className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />{t('newDoc')}
        </button>
      </div>

      {/* RAG 问答区 */}
      <div className="bg-card rounded-lg shadow-card p-5 mb-6">
        <h2 className="text-base font-semibold flex items-center gap-2 mb-4">
          <span className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5" />
          </span>
          {t('ask')}
        </h2>
        <div className="flex gap-3 mb-5">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder={t('askPlaceholder')}
            className="flex-1 bg-muted border-none rounded-md px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
          />
          <button
            onClick={ask}
            disabled={streaming || !question.trim()}
            className="bg-primary text-primary-foreground px-5 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2 shrink-0 disabled:opacity-50"
          >
            {streaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {t('ask')}
          </button>
        </div>
        {(asked || streaming) && (
          <div className="rounded-md bg-muted/60 p-4">
            <div className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-md bg-primary flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="text-primary-foreground w-3.5 h-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground mb-1.5">{asked}</p>
                {answer ? <Markdown content={answer} /> : <span className="text-sm text-muted-foreground">{tc('loading')}</span>}
                {sources.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/20">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('sources')}</p>
                    <div className="flex flex-wrap gap-2">
                      {sources.map((s) => (
                        <span key={s.title} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-card text-xs font-medium shadow-card">
                          <FileText className="w-3 h-3 text-primary" />{s.title}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 文档管理 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-muted rounded-md p-0.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-sm',
                category === c ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(CAT_KEYS[c] as 'categoryAll')}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{docs.length} docs</span>
      </div>

      {docs.length === 0 ? (
        <div className="bg-card rounded-lg shadow-card p-12 text-center text-sm text-muted-foreground">{t('empty')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {docs.map((doc, i) => {
            const style = CAT_STYLE[doc.category] ?? CAT_STYLE.sop;
            const Icon = style.icons[i % style.icons.length];
            return (
              <div
                key={doc.id}
                onClick={() => openEdit(doc)}
                className="bg-card rounded-lg shadow-card p-5 hover:shadow-float transition-shadow cursor-pointer"
              >
                <div className="flex items-start justify-between mb-3">
                  <span className={cn('w-9 h-9 rounded-md flex items-center justify-center', style.iconBg)}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(doc); }}
                      className="text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleting(doc); }}
                      className="text-muted-foreground/50 hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <h3 className="text-sm font-semibold mb-1.5">{doc.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{doc.content}</p>
                <div className="flex items-center justify-between mt-4">
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium', style.badge)}>
                    {t(CAT_KEYS[doc.category] as 'categorySop')}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn('w-1.5 h-1.5 rounded-full inline-block', doc.status === 'ready' ? 'bg-success' : doc.status === 'processing' ? 'bg-warning animate-pulse' : 'bg-destructive')} />
                    {fmtDate(doc.updated_at, locale)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 新建/编辑文档弹窗 */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-card rounded-xl shadow-dialog max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">{editing ? t('editDoc') : t('createDoc')}</h3>
              <button onClick={() => setModalOpen(false)} className="w-8 h-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('docTitle')}</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full bg-muted border-none rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('docCategory')}</label>
                <div className="flex gap-1 bg-muted rounded-md p-0.5 w-fit">
                  {(['sop', 'product', 'policy'] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setForm({ ...form, category: c })}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium rounded-sm',
                        form.category === c ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t(CAT_KEYS[c] as 'categorySop')}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('docContent')}</label>
                <textarea
                  rows={8}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  className="w-full bg-muted border-none rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none"
                />
              </div>
              {saveError && (
                <p className="text-sm text-destructive">{saveError}</p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">
                  {tc('cancel')}
                </button>
                <button
                  onClick={save}
                  disabled={saving || !form.title.trim() || !form.content.trim()}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-all inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {tc('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-card rounded-xl shadow-dialog max-w-sm w-full p-6">
            <h3 className="text-base font-semibold mb-2">{t('deleteDoc')}</h3>
            <p className="text-sm text-muted-foreground mb-5">{t('deleteConfirm', { title: deleting.title })}</p>
            {saveError && (
              <p className="text-sm text-destructive mb-3">{saveError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">
                {tc('cancel')}
              </button>
              <button onClick={remove} disabled={removing} className="bg-destructive text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-all disabled:opacity-60">
                {removing ? tc('loading') : tc('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
