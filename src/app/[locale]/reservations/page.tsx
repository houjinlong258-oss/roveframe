'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, CalendarCheck, Clock, UserCheck, CalendarX, X, Sparkles, WandSparkles } from 'lucide-react';

interface Reservation {
  id: string;
  customer_name: string;
  phone: string;
  party_size: number;
  table_no: string | null;
  reserved_at: string;
  status: string;
  source: string;
  notes: string | null;
}

interface Stats {
  today: number;
  pending: number;
  arrived: number;
  cancelRate: number;
}

const TABLES = [
  { no: 'A1', area: 'private', cap: 8 },
  { no: 'A2', area: 'private', cap: 10 },
  { no: 'A3', area: 'private', cap: 6 },
  { no: 'A4', area: 'private', cap: 4 },
  { no: 'B1', area: 'hall', cap: 2 },
  { no: 'B2', area: 'hall', cap: 2 },
  { no: 'B3', area: 'hall', cap: 4 },
  { no: 'B4', area: 'hall', cap: 4 },
  { no: 'B5', area: 'hall', cap: 4 },
  { no: 'B6', area: 'hall', cap: 6 },
  { no: 'B7', area: 'hall', cap: 4 },
  { no: 'B8', area: 'hall', cap: 4 },
];

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-primary/10 text-primary',
  arrived: 'bg-success/15 text-success',
  cancelled: 'bg-surface-container text-on-surface-variant',
  completed: 'bg-surface-container text-on-surface-variant',
};

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ReservationsPage() {
  const t = useTranslations('reservations');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [selectedDate, setSelectedDate] = useState<string>(() => toLocalDateStr(new Date()));
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [occupancy, setOccupancy] = useState<{ date: string; count: number }[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    customer_name: '',
    phone: '',
    party_size: 2,
    date: toLocalDateStr(new Date()),
    time: '19:00',
    table_no: '',
    notes: '',
  });

  const load = useCallback(async (date: string) => {
    const res = await fetch(`/api/reservations?date=${date}`);
    const data = await res.json();
    setReservations(data.reservations ?? []);
    setStats(data.stats ?? null);
    setOccupancy(data.occupancy ?? []);
  }, []);

  useEffect(() => {
    load(selectedDate);
  }, [selectedDate, load]);

  const weekDays = useMemo(() => {
    const base = new Date();
    const day = base.getDay() || 7; // 周一为 1
    const monday = new Date(base);
    monday.setDate(base.getDate() - day + 1);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, []);

  const updateStatus = async (id: string, status: string) => {
    await fetch('/api/reservations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    await load(selectedDate);
  };

  const createReservation = async () => {
    if (!form.customer_name.trim() || !form.phone.trim()) return;
    setSaving(true);
    try {
      await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: form.customer_name,
          phone: form.phone,
          party_size: form.party_size,
          table_no: form.table_no || null,
          reserved_at: new Date(`${form.date}T${form.time}:00`).toISOString(),
          notes: form.notes || null,
        }),
      });
      setShowModal(false);
      setForm({ customer_name: '', phone: '', party_size: 2, date: selectedDate, time: '19:00', table_no: '', notes: '' });
      setSelectedDate(form.date);
    } finally {
      setSaving(false);
    }
  };

  // 桌位状态推导：arrived→用餐中，confirmed/pending→已订，其余空闲
  const tableStatus = useMemo(() => {
    const map: Record<string, 'occupied' | 'reserved'> = {};
    for (const r of reservations) {
      if (!r.table_no) continue;
      if (r.status === 'arrived') map[r.table_no] = 'occupied';
      else if ((r.status === 'confirmed' || r.status === 'pending') && !map[r.table_no]) map[r.table_no] = 'reserved';
    }
    return map;
  }, [reservations]);

  const filtered = reservations.filter((r) => statusFilter === 'all' || r.status === statusFilter);

  const todayStr = toLocalDateStr(new Date());
  const selectedDateLabel = useMemo(() => {
    const d = new Date(`${selectedDate}T00:00:00`);
    const loc = locale === 'zh' ? 'zh-CN' : locale === 'es' ? 'es-ES' : 'en-US';
    return d.toLocaleDateString(loc, { month: 'long', day: 'numeric', weekday: 'long' });
  }, [selectedDate, locale]);

  const statCards = [
    { icon: CalendarCheck, bg: 'bg-primary/10 text-primary', value: stats?.today ?? '—', label: t('statToday') },
    { icon: Clock, bg: 'bg-warning/15 text-warning', value: stats?.pending ?? '—', label: t('statPending') },
    { icon: UserCheck, bg: 'bg-success/15 text-success', value: stats?.arrived ?? '—', label: t('statArrived') },
    { icon: CalendarX, bg: 'bg-error/15 text-error', value: stats ? `${stats.cancelRate}%` : '—', label: t('statCancelRate') },
  ];

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      {/* 标题 */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={() => {
            setForm((f) => ({ ...f, date: selectedDate }));
            setShowModal(true);
          }}
          className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('newReservation')}
        </button>
      </div>

      {/* 统计条 */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {statCards.map((s, i) => (
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

      {/* 日期周条 */}
      <div className="flex items-center gap-2 mb-5">
        {weekDays.map((d, i) => {
          const ds = toLocalDateStr(d);
          const active = ds === selectedDate;
          const isToday = ds === todayStr;
          const occ = occupancy.find((o) => o.date === ds)?.count ?? 0;
          return (
            <button
              key={ds}
              onClick={() => setSelectedDate(ds)}
              className={`flex-1 rounded-md py-2.5 text-center transition-colors shadow-card ${
                active ? 'bg-primary text-on-primary' : 'bg-surface hover:bg-surface-container'
              }`}
            >
              <span className={`block text-xs ${active ? 'opacity-80' : 'text-on-surface-variant'}`}>
                {t(`weekdays.${weekdayKeys[i]}`)}
                {isToday ? ` · ${t('today')}` : ''}
              </span>
              <span className="block text-sm font-semibold mt-0.5">{`${d.getMonth() + 1}/${d.getDate()}`}</span>
              {occ > 0 && !active && (
                <span className={`block text-[10px] font-medium mt-0.5 ${occ >= 8 ? 'text-error' : 'text-warning'}`}>
                  {t('bookedCount', { count: occ })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-4 items-start">
        {/* 左：预约时间线 */}
        <div className="bg-surface rounded-lg shadow-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">{t('timelineTitle', { date: selectedDateLabel })}</h2>
            <div className="flex items-center gap-1.5">
              {['all', 'pending', 'confirmed', 'arrived'].map((st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1 rounded-sm text-xs font-medium transition-all ${
                    statusFilter === st
                      ? 'bg-primary/10 text-primary'
                      : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {t(`statuses.${st}` as 'statuses.pending')}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5">
            {filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</p>
            ) : (
              filtered.map((r) => {
                const time = new Date(r.reserved_at).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                });
                const isPending = r.status === 'pending';
                return (
                  <div key={r.id} className={`rounded-md p-4 ${isPending ? 'bg-warning/5' : 'bg-surface-container/60'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold w-12">{time}</span>
                        <span className="w-px h-8 bg-outline-variant" />
                        <div>
                          <p className="text-sm font-semibold">
                            {r.customer_name} · {t('partySize', { count: r.party_size })}
                          </p>
                          <p className="text-xs text-on-surface-variant mt-0.5">
                            {r.table_no ?? t('unassigned')} · {r.phone} · {t(`sources.${r.source}` as 'sources.phone')}
                          </p>
                        </div>
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLORS[r.status] ?? STATUS_COLORS.pending}`}>
                        {t(`statuses.${r.status}` as 'statuses.pending')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pl-[3.75rem]">
                      <span className="text-xs text-on-surface-variant">
                        {r.notes ? `${t('notesPrefix')}${r.notes}` : ''}
                      </span>
                      <div className="flex items-center gap-3">
                        {r.status === 'pending' && (
                          <>
                            <button onClick={() => updateStatus(r.id, 'confirmed')} className="text-xs font-medium text-primary hover:underline">
                              {t('confirm')}
                            </button>
                            <button onClick={() => updateStatus(r.id, 'cancelled')} className="text-xs font-medium text-error hover:underline">
                              {t('cancel')}
                            </button>
                          </>
                        )}
                        {r.status === 'confirmed' && (
                          <button onClick={() => updateStatus(r.id, 'arrived')} className="text-xs font-medium text-success hover:underline">
                            {t('markArrived')}
                          </button>
                        )}
                        {r.status === 'arrived' && (
                          <button onClick={() => updateStatus(r.id, 'completed')} className="text-xs font-medium text-on-surface-variant hover:underline">
                            {t('markCompleted')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右：桌位状态 */}
        <div className="space-y-4">
          <div className="bg-surface rounded-lg shadow-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">{t('tableStatus')}</h2>
              <div className="flex items-center gap-3 text-xs text-on-surface-variant">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-surface-container-highest" />
                  {t('tableFree')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  {t('tableReserved')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-success" />
                  {t('tableOccupied')}
                </span>
              </div>
            </div>
            <p className="text-xs font-medium text-on-surface-variant mb-2">{t('privateRooms')}</p>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {TABLES.filter((tb) => tb.area === 'private').map((tb) => {
                const st = tableStatus[tb.no];
                return (
                  <div
                    key={tb.no}
                    className={`rounded-md py-2.5 text-center ${
                      st === 'occupied'
                        ? 'bg-success/10 border border-success/20'
                        : st === 'reserved'
                          ? 'bg-primary/10 border border-primary/20'
                          : 'bg-surface-container'
                    }`}
                  >
                    <span className={`block text-sm font-semibold ${st === 'occupied' ? 'text-success' : st === 'reserved' ? 'text-primary' : ''}`}>
                      {tb.no}
                    </span>
                    <span className="block text-[10px] text-on-surface-variant mt-0.5">
                      {st === 'occupied' ? t('tableOccupied') : st === 'reserved' ? t('tableReserved') : t('tableFree')}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs font-medium text-on-surface-variant mb-2">{t('mainHall')}</p>
            <div className="grid grid-cols-4 gap-2">
              {TABLES.filter((tb) => tb.area === 'hall').map((tb) => {
                const st = tableStatus[tb.no];
                return (
                  <div
                    key={tb.no}
                    className={`rounded-md py-2.5 text-center ${
                      st === 'occupied'
                        ? 'bg-success/10 border border-success/20'
                        : st === 'reserved'
                          ? 'bg-primary/10 border border-primary/20'
                          : 'bg-surface-container'
                    }`}
                  >
                    <span className={`block text-sm font-semibold ${st === 'occupied' ? 'text-success' : st === 'reserved' ? 'text-primary' : ''}`}>
                      {tb.no}
                    </span>
                    <span className="block text-[10px] text-on-surface-variant mt-0.5">
                      {st === 'occupied' ? t('tableOccupied') : st === 'reserved' ? t('tableReserved') : t('tableFree')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI 排台建议 */}
          <div className="rounded-md bg-primary-container/50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-primary">{t('aiHint')}</span>
            </div>
            <p className="text-xs leading-relaxed text-on-surface">{t('aiHintText')}</p>
            <button className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-medium bg-primary text-on-primary hover:opacity-90 active:scale-[0.98] transition-all">
              <WandSparkles className="w-3 h-3" />
              {t('aiOptimize')}
            </button>
          </div>
        </div>
      </div>

      {/* 新建预约弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setShowModal(false)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">{t('newReservation')}</h3>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formName')}</label>
                  <input
                    value={form.customer_name}
                    onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                    type="text"
                    placeholder="Michael Chen"
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formPhone')}</label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    type="text"
                    placeholder="+1 ..."
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formSize')}</label>
                  <input
                    value={form.party_size}
                    onChange={(e) => setForm({ ...form, party_size: Number(e.target.value) || 1 })}
                    type="number"
                    min={1}
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formDate')}</label>
                  <input
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    type="date"
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formTime')}</label>
                  <input
                    value={form.time}
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                    type="time"
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formTable')}</label>
                <select
                  value={form.table_no}
                  onChange={(e) => setForm({ ...form, table_no: e.target.value })}
                  className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                >
                  <option value="">{t('autoAssign')}</option>
                  {TABLES.filter((tb) => !tableStatus[tb.no]).map((tb) => (
                    <option key={tb.no} value={tb.no}>
                      {tb.no}（{tb.cap} {t('seats')}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('formNotes')}</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  placeholder={t('formNotesPlaceholder')}
                  className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="bg-surface-container text-on-surface border-none px-4 py-2 rounded-md text-sm font-medium hover:bg-surface-container-high active:scale-[0.98] transition-all"
              >
                {tc('cancel')}
              </button>
              <button
                onClick={createReservation}
                disabled={saving || !form.customer_name.trim() || !form.phone.trim()}
                className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {saving ? tc('loading') : t('saveReservation')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
