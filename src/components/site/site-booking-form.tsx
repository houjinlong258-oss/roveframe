'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * 官网预约表单（公开页面上唯一的写入口）。
 *
 * 只做两件事：收集字段、把结果如实告诉访客。所有校验都在服务端
 * （src/app/api/site/reservations/route.ts）再走一遍 —— 客户端校验只是体验，
 * 不是边界。
 */
export function SiteBookingForm({ slug, primary }: { slug: string; primary: string }) {
  const t = useTranslations('site');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [partySize, setPartySize] = useState('2');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('sending');
    setMessage('');
    try {
      const response = await fetch('/api/site/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          customer_name: name,
          phone,
          party_size: Number(partySize),
          // datetime-local 给的是本地时间；这里显式转成 UTC ISO，
          // 服务端只接受 ISO 时间戳。
          reserved_at: when ? new Date(when).toISOString() : '',
          notes,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setState('error');
        setMessage(payload.error ?? t('bookFailed'));
        return;
      }
      setState('done');
      setMessage(t('bookDone'));
      setName(''); setPhone(''); setNotes(''); setWhen('');
    } catch {
      setState('error');
      setMessage(t('bookFailed'));
    }
  }

  if (state === 'done') {
    return (
      <p className="mt-6 rounded-2xl bg-white p-5 text-stone-700" role="status">
        {message}
      </p>
    );
  }

  const field = 'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-stone-900 outline-none focus:border-stone-500';

  return (
    <form className="mt-6 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      <label className="text-sm text-stone-600">
        {t('fieldName')}
        <input className={`${field} mt-1`} value={name} onChange={(e) => setName(e.target.value)}
          required maxLength={80} autoComplete="name" />
      </label>
      <label className="text-sm text-stone-600">
        {t('fieldPhone')}
        <input className={`${field} mt-1`} value={phone} onChange={(e) => setPhone(e.target.value)}
          required maxLength={40} autoComplete="tel" inputMode="tel" />
      </label>
      <label className="text-sm text-stone-600">
        {t('fieldParty')}
        <input className={`${field} mt-1`} type="number" min={1} max={40} value={partySize}
          onChange={(e) => setPartySize(e.target.value)} required />
      </label>
      <label className="text-sm text-stone-600">
        {t('fieldWhen')}
        <input className={`${field} mt-1`} type="datetime-local" value={when}
          onChange={(e) => setWhen(e.target.value)} required />
      </label>
      <label className="text-sm text-stone-600 sm:col-span-2">
        {t('fieldNotes')}
        <textarea className={`${field} mt-1`} rows={3} maxLength={500} value={notes}
          onChange={(e) => setNotes(e.target.value)} />
      </label>
      {state === 'error' && (
        <p className="text-sm text-red-600 sm:col-span-2" role="alert">{message}</p>
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={state === 'sending'}
          className="rounded-full px-7 py-3 font-medium text-white disabled:opacity-60"
          style={{ background: primary }}
        >
          {state === 'sending' ? t('booking') : t('bookNow')}
        </button>
      </div>
    </form>
  );
}
