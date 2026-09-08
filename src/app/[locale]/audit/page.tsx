'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ScrollText, RefreshCw, Download, ShieldCheck } from 'lucide-react';
import { safeFetchJson } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';

interface AuditEvent {
  id: string;
  created_at: string;
  action: string;
  tool_name: string | null;
  agent_id: string | null;
  user_id: string | null;
  arguments_hash: string | null;
  approval_id: string | null;
  execution_id: string | null;
  status: string | null;
  result: unknown;
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  executed: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-800',
  executing: 'bg-blue-100 text-blue-800',
  rejected: 'bg-gray-200 text-gray-600',
  failed: 'bg-red-100 text-red-800',
};

function AuditContent() {
  const t = useTranslations('audit');
  const searchParams = useSearchParams();
  const approvalFilter = searchParams.get('approval_id') ?? '';
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const url = approvalFilter
      ? '/api/audit?limit=100&approval_id=' + encodeURIComponent(approvalFilter)
      : '/api/audit?limit=100';
    const data = await safeFetchJson<{ events: AuditEvent[]; total: number; error?: string }>(url);
    if (data?.error) setNotice(data.error);
    else setNotice(null);
    setEvents(data?.events ?? []);
    setTotal(data?.total ?? 0);
    setLoading(false);
  }, [approvalFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-primary" />
            {t.has('title') ? t('title') : 'Audit Trail'}
          </h1>
          <p className="text-sm text-on-surface-variant mt-1">
            {t.has('subtitle') ? t('subtitle') : 'Approval and execution events for this business'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-outline hover:bg-surface-container transition-colors"
          >
            <RefreshCw className="w-4 h-4" /> {t.has('refresh') ? t('refresh') : 'Refresh'}
          </button>
          <a
            href={approvalFilter ? '/api/audit/export?approval_id=' + encodeURIComponent(approvalFilter) : '/api/audit/export'}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            <Download className="w-4 h-4" /> {t.has('export') ? t('export') : 'Export CSV'}
          </a>
        </div>
      </div>

      {approvalFilter && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-surface-container/60 border border-outline text-sm">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <span className="text-on-surface-variant">{t.has('filterApproval') ? t('filterApproval') : 'Filtered by approval'}:</span>
          <span className="font-mono text-xs">{approvalFilter}</span>
          <Link href="/audit" className="text-primary hover:underline text-xs ml-2">{t.has('clear') ? t('clear') : 'Clear'}</Link>
        </div>
      )}

      {notice && (
        <div className="px-4 py-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 whitespace-pre-wrap">{notice}</div>
      )}

      <div className="rounded-lg border border-outline bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-outline text-sm font-semibold">
          {t.has('count') ? t('count') : 'Events'} ({total})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-on-surface-variant border-b border-outline">
                <th className="px-4 py-2 font-medium">{t.has('time') ? t('time') : 'Time'}</th>
                <th className="px-4 py-2 font-medium">{t.has('action') ? t('action') : 'Action'}</th>
                <th className="px-4 py-2 font-medium">{t.has('tool') ? t('tool') : 'Tool'}</th>
                <th className="px-4 py-2 font-medium">{t.has('agent') ? t('agent') : 'Agent'}</th>
                <th className="px-4 py-2 font-medium">{t.has('approval') ? t('approval') : 'Approval'}</th>
                <th className="px-4 py-2 font-medium">{t.has('execution') ? t('execution') : 'Execution'}</th>
                <th className="px-4 py-2 font-medium">{t.has('status') ? t('status') : 'Status'}</th>
                <th className="px-4 py-2 font-medium">{t.has('result') ? t('result') : 'Result'}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="px-4 py-6 text-on-surface-variant">{t.has('loading') ? t('loading') : 'Loading…'}</td></tr>
              )}
              {!loading && events.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-on-surface-variant">{t.has('empty') ? t('empty') : 'No audit events yet.'}</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b border-outline/50 align-top">
                  <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(e.created_at)}</td>
                  <td className="px-4 py-2 font-mono">{e.action}</td>
                  <td className="px-4 py-2 font-mono">{e.tool_name ?? '—'}</td>
                  <td className="px-4 py-2 font-mono">{e.agent_id ?? '—'}</td>
                  <td className="px-4 py-2 font-mono">
                    {e.approval_id ? (
                      <a href={'/approvals'} className="text-primary hover:underline">{e.approval_id.slice(0, 8)}</a>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono">{e.execution_id ? e.execution_id.slice(0, 8) : '—'}</td>
                  <td className="px-4 py-2">
                    <span className={'px-1.5 py-0.5 rounded text-[11px] ' + (STATUS_STYLES[e.status ?? 'ok'] ?? STATUS_STYLES.ok)}>
                      {e.status ?? 'ok'}
                    </span>
                  </td>
                  <td className="px-4 py-2 max-w-[320px]">
                    {e.result !== null && e.result !== undefined ? (
                      <span className="break-all text-on-surface-variant">
                        {typeof e.result === 'string' ? e.result : JSON.stringify(e.result)}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-on-surface-variant">Loading…</div>}>
      <AuditContent />
    </Suspense>
  );
}
