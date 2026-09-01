'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Sparkles, Users, UserPlus, Wallet, UserX, Search, X, HeartHandshake } from 'lucide-react';
import { fmtCurrency, fmtDate } from '@/lib/format';
import { Markdown } from '@/components/markdown';

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  total_spent: string;
  visit_count: number;
  last_visit_at: string | null;
  ai_score: number | null;
  churn_risk: string;
  preference_notes: string | null;
}

interface CustomerOrder {
  id: string;
  order_no: string;
  items: { name: string; qty: number; price: number }[];
  total: string;
  created_at: string;
}

interface Stats {
  total: number;
  newThisMonth: number;
  avgTicket: number;
  highRisk: number;
}

const TAG_COLORS: Record<string, string> = {
  vip: 'bg-warning/15 text-warning',
  regular: 'bg-primary/10 text-primary',
  new: 'bg-success/15 text-success',
  risk: 'bg-error/15 text-error',
  corporate: 'bg-surface-container text-on-surface-variant',
  delivery: 'bg-surface-container text-on-surface-variant',
  family: 'bg-surface-container text-on-surface-variant',
};

function scoreColor(score: number) {
  return score >= 70 ? 'bg-success' : score >= 45 ? 'bg-warning' : 'bg-error';
}

export default function CustomersPage() {
  const t = useTranslations('customers');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [scoring, setScoring] = useState(false);

  const [selected, setSelected] = useState<Customer | null>(null);
  const [detailOrders, setDetailOrders] = useState<CustomerOrder[]>([]);
  const [plan, setPlan] = useState('');
  const [planning, setPlanning] = useState(false);
  const planRef = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/customers');
    const data = await res.json();
    setCustomers(data.customers ?? []);
    setStats(data.stats ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runBatchScore = async () => {
    setScoring(true);
    try {
      await fetch('/api/customers/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'score' }),
      });
      await load();
    } finally {
      setScoring(false);
    }
  };

  const openDrawer = async (c: Customer) => {
    setSelected(c);
    setPlan('');
    setDetailOrders([]);
    const res = await fetch(`/api/customers?id=${c.id}`);
    const data = await res.json();
    setDetailOrders(data.orders ?? []);
  };

  const generatePlan = async () => {
    if (!selected || planRef.current) return;
    planRef.current = true;
    setPlanning(true);
    setPlan('');
    try {
      const res = await fetch('/api/customers/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'retention', customerId: selected.id, locale }),
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
              if (j.text) setPlan((prev) => prev + j.text);
            } catch {
              // skip
            }
          }
        }
      }
    } finally {
      setPlanning(false);
      planRef.current = false;
    }
  };

  const filtered = customers.filter((c) => {
    const kw = search.trim().toLowerCase();
    const matchKw = !kw || c.name.toLowerCase().includes(kw) || (c.phone ?? '').includes(kw);
    const matchTag = tagFilter === 'all' || c.tags.includes(tagFilter) || (tagFilter === 'risk' && c.churn_risk === 'high');
    return matchKw && matchTag;
  });

  const allTags = Array.from(new Set(customers.flatMap((c) => c.tags)));

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      {/* 标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={runBatchScore}
          disabled={scoring}
          className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2 disabled:opacity-60"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {scoring ? t('scoring') : t('batchScore')}
        </button>
      </div>

      {/* 统计条 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { icon: Users, bg: 'bg-primary/10 text-primary', value: stats?.total ?? '—', label: t('totalCustomers') },
          { icon: UserPlus, bg: 'bg-success/15 text-success', value: stats?.newThisMonth ?? '—', label: t('newThisMonth') },
          { icon: Wallet, bg: 'bg-warning/15 text-warning', value: stats ? fmtCurrency(stats.avgTicket) : '—', label: t('avgTicket') },
          { icon: UserX, bg: 'bg-error/15 text-error', value: stats?.highRisk ?? '—', label: t('highRisk') },
        ].map((s, i) => (
          <div key={i} className="bg-surface rounded-lg shadow-card p-4 flex items-center gap-3">
            <span className={`w-10 h-10 rounded-md ${s.bg} flex items-center justify-center`}>
              <s.icon className="w-4.5 h-4.5" />
            </span>
            <div>
              <div className="text-xl font-bold">{s.value}</div>
              <div className="text-xs text-on-surface-variant">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 工具行 */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-on-surface-variant/50 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            type="text"
            placeholder={t('searchPlaceholder')}
            className="w-full bg-surface-container border-none rounded-md pl-9 pr-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
          />
        </div>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
        >
          <option value="all">{t('allTags')}</option>
          <option value="risk">{t('tagRisk')}</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {t(`tags.${tag}` as 'tags.vip')}
            </option>
          ))}
        </select>
      </div>

      {/* 客户表格 */}
      <div className="bg-surface rounded-lg shadow-card overflow-hidden">
        <div className="grid grid-cols-[1.4fr_1.4fr_1fr_0.8fr_1fr_1.2fr_0.9fr] gap-3 px-5 py-3 bg-surface-container text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
          <span>{t('colCustomer')}</span>
          <span>{t('colTags')}</span>
          <span>{t('colTotalSpent')}</span>
          <span>{t('colVisits')}</span>
          <span>{t('colLastVisit')}</span>
          <span>{t('colScore')}</span>
          <span>{t('colChurn')}</span>
        </div>
        <div className="divide-y divide-outline-variant/20">
          {loading ? (
            <div className="px-5 py-10 text-center text-sm text-on-surface-variant">{tc('loading')}</div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</div>
          ) : (
            filtered.map((c) => {
              const score = c.ai_score ?? 0;
              return (
                <button
                  key={c.id}
                  onClick={() => openDrawer(c)}
                  className="w-full grid grid-cols-[1.4fr_1.4fr_1fr_0.8fr_1fr_1.2fr_0.9fr] gap-3 px-5 py-3.5 hover:bg-surface-container/50 transition-colors text-left items-center"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{c.name}</span>
                      <span className="block text-xs text-on-surface-variant">{c.phone ?? c.email ?? '—'}</span>
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {c.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium ${TAG_COLORS[tag] ?? 'bg-surface-container text-on-surface-variant'}`}
                      >
                        {t(`tags.${tag}` as 'tags.vip')}
                      </span>
                    ))}
                    {c.churn_risk === 'high' && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-error/15 text-error">
                        {t('tagRisk')}
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-semibold">{fmtCurrency(c.total_spent)}</span>
                  <span className="text-sm">{c.visit_count}</span>
                  <span className="text-sm text-on-surface-variant">{c.last_visit_at ? fmtDate(c.last_visit_at, locale) : '—'}</span>
                  <span className="flex items-center gap-2">
                    <span className="flex-1 h-1.5 bg-surface-container rounded-full overflow-hidden">
                      <span className={`block h-full rounded-full ${scoreColor(score)}`} style={{ width: `${score}%` }} />
                    </span>
                    <span className="text-xs font-semibold w-7">{c.ai_score ?? '—'}</span>
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium w-fit ${
                      c.churn_risk === 'high'
                        ? 'bg-error/15 text-error'
                        : c.churn_risk === 'medium'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-success/15 text-success'
                    }`}
                  >
                    {t(`churn.${c.churn_risk}` as 'churn.low')}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 客户 360 抽屉 */}
      {selected && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSelected(null)} />
          <div className="absolute right-0 top-0 bottom-0 w-[26rem] bg-surface shadow-dialog flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20">
              <h3 className="text-base font-semibold">{t('drawerTitle')}</h3>
              <button
                onClick={() => setSelected(null)}
                className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* 基础信息 */}
              <div className="flex items-center gap-4">
                <span className="w-14 h-14 rounded-full bg-error/15 text-error flex items-center justify-center text-lg font-semibold">
                  {selected.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold">{selected.name}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${
                        selected.churn_risk === 'high'
                          ? 'bg-error/15 text-error'
                          : selected.churn_risk === 'medium'
                            ? 'bg-warning/15 text-warning'
                            : 'bg-success/15 text-success'
                      }`}
                    >
                      {t(`churn.${selected.churn_risk}` as 'churn.low')}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface-variant mt-1">{selected.phone ?? selected.email ?? ''}</p>
                </div>
              </div>

              {/* 消费统计 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-md bg-surface-container/60 p-3 text-center">
                  <div className="text-base font-bold">{fmtCurrency(selected.total_spent)}</div>
                  <div className="text-xs text-on-surface-variant mt-0.5">{t('colTotalSpent')}</div>
                </div>
                <div className="rounded-md bg-surface-container/60 p-3 text-center">
                  <div className="text-base font-bold">{selected.visit_count}</div>
                  <div className="text-xs text-on-surface-variant mt-0.5">{t('colVisits')}</div>
                </div>
                <div className="rounded-md bg-surface-container/60 p-3 text-center">
                  <div className="text-base font-bold">
                    {selected.visit_count > 0 ? fmtCurrency(Number(selected.total_spent) / selected.visit_count) : '—'}
                  </div>
                  <div className="text-xs text-on-surface-variant mt-0.5">{t('avgTicket')}</div>
                </div>
              </div>

              {/* AI 评分 */}
              <div className="rounded-md bg-surface-container/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-primary" />
                    {t('aiScoreTitle')}
                  </span>
                  <span className={`text-lg font-bold ${(selected.ai_score ?? 0) >= 70 ? 'text-success' : (selected.ai_score ?? 0) >= 45 ? 'text-warning' : 'text-error'}`}>
                    {selected.ai_score ?? '—'}
                    <span className="text-xs font-normal text-on-surface-variant"> / 100</span>
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  {selected.preference_notes ?? t('noNotes')}
                </p>
              </div>

              {/* 标签画像 */}
              {selected.tags.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2.5">{t('profileTitle')}</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center px-2 py-1 rounded-sm text-xs bg-surface-container text-on-surface">
                        {t(`tags.${tag}` as 'tags.vip')}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 近期订单 */}
              <div>
                <h4 className="text-sm font-semibold mb-2.5">{t('recentOrders')}</h4>
                <div className="space-y-2">
                  {detailOrders.length === 0 ? (
                    <p className="text-xs text-on-surface-variant">{tc('noData')}</p>
                  ) : (
                    detailOrders.slice(0, 5).map((o) => (
                      <div key={o.id} className="flex items-center justify-between rounded-md bg-surface-container/60 px-3.5 py-2.5">
                        <span className="text-xs truncate mr-2">
                          {o.items.map((it) => `${it.name} ×${it.qty}`).join('、')}
                        </span>
                        <span className="text-xs text-on-surface-variant shrink-0">
                          {fmtDate(o.created_at, locale)} · {fmtCurrency(o.total)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* 挽留方案 */}
              <button
                onClick={generatePlan}
                disabled={planning}
                className="w-full bg-primary text-on-primary px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <HeartHandshake className="w-4 h-4" />
                {planning ? t('planning') : t('genPlan')}
              </button>
              {(plan || planning) && (
                <div className="rounded-md bg-surface-container/60 p-4 text-xs leading-relaxed">
                  <Markdown content={plan || t('planning')} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
