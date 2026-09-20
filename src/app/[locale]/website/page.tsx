'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Globe, Sparkles, ExternalLink, Save, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Link } from '@/i18n/navigation';

/**
 * 商户官网管理页（Phase 17）。
 *
 * 三个动作对应三段真实链路：
 *   起草  → POST /api/website/generate（读真实经营数据 → 模型 → 写成草稿）
 *   发布  → PATCH /api/website { enabled: true }（发布前必须先备好点单入口）
 *   域名  → PATCH /api/website { custom_domain }（只置 pending_dns，证书由边缘签发）
 */

interface SiteRow {
  id: string;
  slug: string;
  enabled: boolean;
  tagline: string;
  about: string;
  sections: { id: string; kind: string; heading: string; body: string }[];
  custom_domain: string | null;
  domain_status: string;
  web_order_token: string | null;
  generated_at: string | null;
}

interface SiteResponse {
  site: SiteRow | null;
  orderToken: string | null;
}

export default function WebsitePage() {
  const t = useTranslations('website');
  const locale = useLocale();

  const [loading, setLoading] = useState(true);
  const [site, setSite] = useState<SiteRow | null>(null);
  const [orderToken, setOrderToken] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState<'idle' | 'generating' | 'saving' | 'publishing'>('idle');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/website');
      if (!response.ok) {
        setNotice({ kind: 'error', text: `${t('saveError')} (HTTP ${response.status})` });
        return;
      }
      const payload = (await response.json()) as SiteResponse;
      setSite(payload.site);
      setOrderToken(payload.orderToken);
      setSlug(payload.site?.slug ?? '');
      setDomain(payload.site?.custom_domain ?? '');
    } catch {
      setNotice({ kind: 'error', text: t('saveError') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function generate() {
    setBusy('generating');
    setNotice(null);
    try {
      const response = await fetch('/api/website/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice({ kind: 'error', text: payload.error ?? t('saveError') });
        return;
      }
      await load();
      setNotice({ kind: 'ok', text: t('saved') });
    } catch {
      setNotice({ kind: 'error', text: t('saveError') });
    } finally {
      setBusy('idle');
    }
  }

  async function patch(body: Record<string, unknown>, mode: 'saving' | 'publishing') {
    setBusy(mode);
    setNotice(null);
    try {
      const response = await fetch('/api/website', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice({ kind: 'error', text: payload.error ?? t('saveError') });
        return false;
      }
      await load();
      setNotice({ kind: 'ok', text: t('saved') });
      return true;
    } catch {
      setNotice({ kind: 'error', text: t('saveError') });
      return false;
    } finally {
      setBusy('idle');
    }
  }

  const card = 'bg-surface rounded-lg shadow-card p-5';
  const input = 'w-full rounded-md border border-outline-variant bg-background px-3 py-2 text-sm';
  const primaryButton = 'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-60';
  const ghostButton = 'inline-flex items-center gap-2 rounded-md border border-outline-variant px-4 py-2 text-sm disabled:opacity-60';

  if (loading) {
    return (
      <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
        <div className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('subtitle')}
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="w-5 h-5" />
          {t('title')}
        </h1>
        <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
      </div>

      {notice && (
        <div
          role="status"
          className={`mb-4 flex items-center gap-2 rounded-md px-4 py-2 text-sm ${
            notice.kind === 'ok' ? 'bg-primary/10 text-primary' : 'bg-error/10 text-error'
          }`}
        >
          {notice.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {notice.text}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={`${card} lg:col-span-2`}>
          <div className="flex flex-wrap items-center gap-2">
            <button className={primaryButton} onClick={generate} disabled={busy !== 'idle'}>
              {busy === 'generating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {busy === 'generating' ? t('regenerating') : site ? t('regenerate') : t('generate')}
            </button>
            {site && (
              <Link className={ghostButton} href={`/site/${site.slug}`} target="_blank">
                <ExternalLink className="w-4 h-4" />
                {site.enabled ? t('openSite') : t('preview')}
              </Link>
            )}
            {site && (
              <span className="ml-auto rounded-full bg-surface-variant px-3 py-1 text-xs">
                {site.enabled ? t('live') : t('draft')}
              </span>
            )}
          </div>

          {!site && (
            <p className="mt-4 text-sm text-on-surface-variant">{t('notGenerated')}</p>
          )}

          {site && (
            <div className="mt-5 space-y-4">
              <div>
                <p className="text-sm font-medium">{site.tagline || '—'}</p>
                <p className="mt-2 whitespace-pre-line text-sm text-on-surface-variant">{site.about}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-on-surface-variant">{t('sections')}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {site.sections.map((section) => (
                    <li key={section.id} className="rounded-full bg-surface-variant px-3 py-1 text-xs">
                      {section.kind}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-on-surface-variant">{t('aiNote')}</p>
            </div>
          )}
        </section>

        <section className={card}>
          <h2 className="text-sm font-semibold">{t('address')}</h2>
          <input
            className={`${input} mt-2`}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="my-store"
            maxLength={63}
          />
          <p className="mt-1 text-xs text-on-surface-variant">{t('addressHint')}</p>

          <h2 className="mt-5 text-sm font-semibold">{t('domain')}</h2>
          <input
            className={`${input} mt-2`}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="shop.example.com"
            maxLength={253}
          />
          <p className="mt-1 text-xs text-on-surface-variant">
            {domain ? t('domainHint') : t('domainEmpty')}
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className={primaryButton}
              disabled={busy !== 'idle'}
              onClick={() => void patch({ slug, custom_domain: domain }, 'saving')}
            >
              {busy === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {busy === 'saving' ? t('saving') : t('save')}
            </button>
            <button
              className={ghostButton}
              disabled={busy !== 'idle' || !site}
              onClick={() => void patch({ enabled: !site?.enabled }, 'publishing')}
            >
              {busy === 'publishing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
              {site?.enabled ? t('unpublish') : t('publish')}
            </button>
          </div>

          <h2 className="mt-5 text-sm font-semibold">{t('orderLink')}</h2>
          {orderToken ? (
            <code className="mt-2 block truncate rounded-md bg-surface-variant px-3 py-2 text-xs">
              /{locale}/store?token={orderToken}
            </code>
          ) : (
            <p className="mt-2 text-xs text-on-surface-variant">{t('orderLinkMissing')}</p>
          )}
          <p className="mt-1 text-xs text-on-surface-variant">{t('orderLinkHint')}</p>
          <p className="mt-4 text-xs text-on-surface-variant">{t('contactNote')}</p>
        </section>
      </div>
    </main>
  );
}
