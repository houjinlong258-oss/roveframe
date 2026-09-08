'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Inbox,
  MessageCircleQuestion,
  Briefcase,
  MessageSquareWarning,
  Truck,
  Mails,
  Sparkles,
  RotateCcw,
  SendHorizontal,
  CheckCheck,
} from 'lucide-react';
import { fmtDateTime } from '@/lib/format';
import { safeFetchJson } from '@/lib/utils';
import { saveJson } from '@/lib/fetch-utils';
import { useRouter } from '@/i18n/navigation';

interface Email {
  id: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string;
  subject: string;
  content: string;
  category: string;
  priority: string;
  ai_summary: string | null;
  reply_draft: string | null;
  status: string;
  created_at: string;
}

interface Account {
  id: string;
  email: string;
  display_name: string | null;
  is_default: boolean;
}

const CAT_ICONS: Record<string, typeof Inbox> = {
  all: Inbox,
  inquiry: MessageCircleQuestion,
  business: Briefcase,
  complaint: MessageSquareWarning,
  supplier: Truck,
  other: Mails,
};

const CATS = ['all', 'inquiry', 'business', 'complaint', 'supplier', 'other'] as const;

export default function EmailsPage() {
  const t = useTranslations('emails');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();

  const [emails, setEmails] = useState<Email[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cat, setCat] = useState<string>('all');
  const [selected, setSelected] = useState<Email | null>(null);
  const [draft, setDraft] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const genRef = useRef(false);

  const load = useCallback(async (category: string) => {
    const data = await safeFetchJson(`/api/emails?category=${category}`);
    setEmails(data?.emails ?? []);
    setCounts(data?.counts ?? {});
    setAccounts(data?.accounts ?? []);
    const def = (data?.accounts ?? []).find((a: Account) => a.is_default) ?? (data?.accounts ?? [])[0];
    if (def) setAccountId(def.id);
  }, []);

  useEffect(() => {
    load(cat);
  }, [cat, load]);

  const openEmail = async (e: Email) => {
    setSelected(e);
    setDraft(e.reply_draft ?? '');
    setSendMsg(null);
    if (e.status === 'unread') {
      await fetch('/api/emails', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: e.id, status: 'read' }),
      });
      setEmails((prev) => prev.map((x) => (x.id === e.id ? { ...x, status: 'read' } : x)));
    }
    if (!e.ai_summary) {
      setSummarizing(true);
      try {
        const data = await safeFetchJson('/api/emails/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailId: e.id, action: 'summarize', locale }),
        });
        if (data?.summary) {
          setSelected((prev) => (prev && prev.id === e.id ? { ...prev, ai_summary: data.summary } : prev));
        }
      } finally {
        setSummarizing(false);
      }
    }
  };

  const markAllRead = async () => {
    await fetch('/api/emails', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    });
    await load(cat);
  };

  const generateReply = async () => {
    if (!selected || genRef.current) return;
    genRef.current = true;
    setGenerating(true);
    setDraft('');
    try {
      const res = await fetch('/api/emails/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: selected.id, action: 'reply', locale }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
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
              if (j.text) {
                full += j.text;
                setDraft(full);
              }
            } catch {
              // skip
            }
          }
        }
      }
      // 自动保存草稿
      if (full.trim()) {
        await fetch('/api/emails', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: selected.id, reply_draft: full }),
        });
      }
    } finally {
      setGenerating(false);
      genRef.current = false;
    }
  };

  const saveDraft = async () => {
    if (!selected) return;
    // P0-7：草稿保存失败不得误报「已保存」
    try {
      await saveJson('/api/emails', {
        method: 'PATCH',
        body: { id: selected.id, reply_draft: draft },
      });
      setSendMsg({ ok: true, text: t('draftSaved') });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('saveFail');
      setSendMsg({ ok: false, text: message });
    }
    setTimeout(() => setSendMsg(null), 2500);
  };

  const sendReply = async () => {
    if (!selected || !draft.trim()) return;
    setSending(true);
    setSendMsg(null);
    try {
      const res = await fetch('/api/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: selected.id, reply: draft, accountId }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSendMsg({ ok: true, text: t('sentOk') });
        setSelected({ ...selected, status: 'replied' });
        setEmails((prev) => prev.map((x) => (x.id === selected.id ? { ...x, status: 'replied' } : x)));
      } else if (data.error === 'no_account' || data.error === 'account_incomplete') {
        setSendMsg({ ok: false, text: t('noAccount') });
      } else {
        setSendMsg({ ok: false, text: `${t('sentFail')}: ${data.message ?? ''}` });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex-1 min-w-0 flex bg-background">
      {/* 左栏：分类 */}
      <div className="w-44 shrink-0 border-r border-outline-variant/20 bg-surface p-3 space-y-0.5">
        {CATS.map((c) => {
          const Icon = CAT_ICONS[c];
          const active = cat === c;
          const count = counts[c] ?? 0;
          return (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active ? 'bg-primary/10 text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon className="w-4 h-4" />
                {t(`categories.${c}`)}
              </span>
              {c === 'complaint' && count > 0 ? (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-error/15 text-error">{count}</span>
              ) : (
                <span className="text-xs">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 中栏：邮件列表 */}
      <div className="w-80 shrink-0 border-r border-outline-variant/20 bg-surface overflow-y-auto">
        <div className="px-4 py-3 border-b border-outline-variant/20 flex items-center justify-between">
          <h1 className="text-sm font-semibold">{t('title')}</h1>
          <button onClick={markAllRead} className="text-xs text-primary hover:underline inline-flex items-center gap-1">
            <CheckCheck className="w-3 h-3" />
            {t('markAllRead')}
          </button>
        </div>
        <div className="divide-y divide-outline-variant/20">
          {emails.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</p>
          ) : (
            emails.map((e) => (
              <button
                key={e.id}
                onClick={() => openEmail(e)}
                className={`w-full text-left px-4 py-3.5 hover:bg-surface-container/50 transition-colors ${
                  selected?.id === e.id ? 'bg-primary-container/40' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold flex items-center gap-1.5">
                    {e.status === 'unread' && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                    {e.from_name ?? e.from_addr}
                  </span>
                  <span className="text-xs text-on-surface-variant">{fmtDateTime(e.created_at, locale)}</span>
                </div>
                <p className="text-sm font-medium truncate mb-0.5">{e.subject}</p>
                <p className="text-xs text-on-surface-variant truncate">{e.content}</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium ${
                      e.category === 'complaint'
                        ? 'bg-error/15 text-error'
                        : e.category === 'business'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    {t(`categories.${e.category}` as 'categories.other')}
                  </span>
                  {e.priority === 'high' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-error/15 text-error">
                      {t('highPriority')}
                    </span>
                  )}
                  {e.status === 'replied' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-success/15 text-success">
                      {t('replied')}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* 右栏：邮件详情 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-sm text-on-surface-variant/60">{t('selectEmail')}</div>
        ) : (
          <>
            {/* 邮件头部 */}
            <div className="bg-surface rounded-lg shadow-card p-5 mb-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h2 className="text-base font-bold">{selected.subject}</h2>
                  <p className="text-xs text-on-surface-variant mt-1">
                    {selected.from_name ?? ''} &lt;{selected.from_addr}&gt; · {fmtDateTime(selected.created_at, locale)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${
                      selected.category === 'complaint'
                        ? 'bg-error/15 text-error'
                        : selected.category === 'business'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    {t(`categories.${selected.category}` as 'categories.other')}
                  </span>
                  {selected.priority === 'high' && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-error/15 text-error">
                      {t('highPriority')}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-sm leading-relaxed text-on-surface-variant whitespace-pre-wrap">{selected.content}</p>
            </div>

            {/* AI 摘要 */}
            <div className="rounded-md bg-primary-container/50 p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-primary">{t('aiSummary')}</span>
              </div>
              <p className="text-xs leading-relaxed text-on-surface">
                {summarizing ? tc('generating') : (selected.ai_summary ?? t('noSummary'))}
              </p>
            </div>

            {/* 回复草稿 */}
            <div className="bg-surface rounded-lg shadow-card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">{t('replyDraft')}</h3>
                <button
                  onClick={generateReply}
                  disabled={generating}
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  {generating ? tc('generating') : t('regenerate')}
                </button>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                placeholder={t('draftPlaceholder')}
                className="w-full bg-surface-container border-none rounded-md px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none mb-4"
              />
              {/* 发件账号指示 */}
              <div className="flex items-center gap-2 mb-3 text-xs text-on-surface-variant">
                <Inbox className="w-3.5 h-3.5" />
                <span>{t('sendVia')}</span>
                {accounts.length > 0 ? (
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="bg-surface-container border-none rounded-sm px-2 py-1 text-xs font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email}
                        {a.is_default ? `（${t('default')}）` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-warning font-medium">{t('noAccountShort')}</span>
                )}
                <span>{t('realSend')}</span>
                <span className="text-on-surface-variant/50">·</span>
                <button onClick={() => router.push('/settings')} className="text-primary hover:underline">
                  {t('manageAccounts')}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  {sendMsg && (
                    <span className={`text-xs font-medium ${sendMsg.ok ? 'text-success' : 'text-error'}`}>{sendMsg.text}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={saveDraft}
                    className="bg-surface-container text-on-surface border-none px-4 py-2 rounded-md text-sm font-medium hover:bg-surface-container-high active:scale-[0.98] transition-all"
                  >
                    {tc('save')}
                  </button>
                  <button
                    onClick={sendReply}
                    disabled={sending || !draft.trim() || accounts.length === 0}
                    className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2 disabled:opacity-60"
                  >
                    <SendHorizontal className="w-3.5 h-3.5" />
                    {sending ? t('sending') : t('sendReply')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
