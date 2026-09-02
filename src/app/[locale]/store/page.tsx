'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  UtensilsCrossed, Plus, Minus, ShoppingCart, X, CheckCircle2, Play, Store as StoreIcon, ClipboardList,
} from 'lucide-react';
import { fmtCurrency } from '@/lib/format';

interface Product {
  id: string;
  name: string;
  category: string;
  price: string | number;
  description: string | null;
  image_url: string | null;
  video_url: string | null;
  sales_count: number;
}

interface MenuData {
  store: { name: string; intro: string; hours: string; currency: string };
  table: string | null;
  categories: string[];
  products: Product[];
}

function Storefront() {
  const t = useTranslations('store');
  const params = useSearchParams();
  const table = params.get('table');

  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [activeCat, setActiveCat] = useState<string>('__all__');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ order_no: string; total: number } | null>(null);

  useEffect(() => {
    fetch(`/api/store/menu${table ? `?table=${encodeURIComponent(table)}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setMenu)
      .catch(() => setLoadError(true));
  }, [table]);

  const byId = useMemo(() => new Map((menu?.products ?? []).map((p) => [p.id, p])), [menu]);
  const visible = useMemo(
    () => (menu?.products ?? []).filter((p) => activeCat === '__all__' || p.category === activeCat),
    [menu, activeCat]
  );
  const cartCount = Object.values(cart).reduce((s, q) => s + q, 0);
  const cartTotal = Object.entries(cart).reduce((s, [id, q]) => s + Number(byId.get(id)?.price ?? 0) * q, 0);

  const add = (id: string, delta: number) => {
    setCart((c) => {
      const next = { ...c };
      const q = (next[id] ?? 0) + delta;
      if (q <= 0) delete next[id];
      else next[id] = Math.min(q, 99);
      return next;
    });
  };

  const placeOrder = async () => {
    if (placing || cartCount === 0) return;
    setPlacing(true);
    try {
      const res = await fetch('/api/store/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_no: table,
          note: note || null,
          items: Object.entries(cart).map(([product_id, qty]) => ({ product_id, qty })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPlaced({ order_no: data.order.order_no, total: Number(data.order.total) });
      setCart({});
      setCartOpen(false);
    } catch {
      alert(t('placeFailed'));
    } finally {
      setPlacing(false);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 text-on-surface-variant">
        <StoreIcon className="w-10 h-10" />
        <p className="text-sm">{t('loadFailed')}</p>
      </div>
    );
  }

  if (!menu) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (placed) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 text-center">
        <CheckCircle2 className="w-16 h-16 text-success mb-4" />
        <h1 className="text-xl font-bold text-on-surface mb-1">{t('orderSuccess')}</h1>
        <p className="text-sm text-on-surface-variant mb-2">{t('orderSuccessDesc')}</p>
        <div className="bg-surface rounded-xl shadow-card px-6 py-4 mb-6 w-full max-w-xs">
          <div className="flex justify-between text-sm py-1">
            <span className="text-on-surface-variant">{t('orderNo')}</span>
            <span className="font-semibold text-on-surface">{placed.order_no}</span>
          </div>
          {table && (
            <div className="flex justify-between text-sm py-1">
              <span className="text-on-surface-variant">{t('table')}</span>
              <span className="font-semibold text-on-surface">{table}</span>
            </div>
          )}
          <div className="flex justify-between text-sm py-1">
            <span className="text-on-surface-variant">{t('total')}</span>
            <span className="font-semibold text-primary">{fmtCurrency(placed.total)}</span>
          </div>
        </div>
        <button
          onClick={() => setPlaced(null)}
          className="px-6 py-2.5 rounded-lg bg-primary text-on-primary text-sm font-semibold shadow-float"
        >
          {t('backToMenu')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background max-w-lg mx-auto pb-24">
      {/* 头部 */}
      <header className="bg-surface shadow-card sticky top-0 z-20">
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-on-surface truncate">{menu.store.name}</h1>
              <p className="text-xs text-on-surface-variant truncate">{menu.store.hours}</p>
            </div>
            {table && (
              <span className="shrink-0 ml-3 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-sm font-bold shadow-float">
                {t('table')} {table}
              </span>
            )}
          </div>
        </div>
        {/* 分类 */}
        <div className="flex gap-2 overflow-x-auto px-4 pb-3 no-scrollbar">
          {['__all__', ...menu.categories].map((c) => (
            <button
              key={c}
              onClick={() => setActiveCat(c)}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeCat === c
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container text-on-surface-variant'
              }`}
            >
              {c === '__all__' ? t('all') : c}
            </button>
          ))}
        </div>
      </header>

      {/* 商品列表 */}
      <main className="px-4 py-4 space-y-3">
        {visible.map((p) => {
          const qty = cart[p.id] ?? 0;
          return (
            <div
              key={p.id}
              className="bg-surface rounded-xl shadow-card p-3 flex gap-3 cursor-pointer"
              onClick={() => setDetail(p)}
            >
              <div className="w-24 h-24 rounded-lg bg-surface-container overflow-hidden shrink-0 relative">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant/40">
                    <UtensilsCrossed className="w-8 h-8" />
                  </div>
                )}
                {p.video_url && (
                  <span className="absolute bottom-1 right-1 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
                    <Play className="w-3 h-3 text-white fill-white" />
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col">
                <h3 className="text-sm font-semibold text-on-surface leading-snug line-clamp-1">{p.name}</h3>
                {p.description && (
                  <p className="text-xs text-on-surface-variant line-clamp-2 mt-0.5 flex-1">{p.description}</p>
                )}
                <div className="flex items-center justify-between mt-auto pt-2">
                  <span className="text-base font-bold text-primary">{fmtCurrency(Number(p.price))}</span>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {qty > 0 && (
                      <>
                        <button
                          onClick={() => add(p.id, -1)}
                          className="w-7 h-7 rounded-full bg-surface-container text-on-surface flex items-center justify-center"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-semibold text-on-surface w-5 text-center">{qty}</span>
                      </>
                    )}
                    <button
                      onClick={() => add(p.id, 1)}
                      className="w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-float"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="py-16 text-center text-sm text-on-surface-variant">{t('empty')}</div>
        )}
      </main>

      {/* 购物车底栏 */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-30">
          <div className="max-w-lg mx-auto px-4 pb-4">
            <button
              onClick={() => setCartOpen(true)}
              className="w-full bg-primary text-on-primary rounded-xl shadow-float px-5 py-3.5 flex items-center justify-between"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <ShoppingCart className="w-5 h-5" />
                {t('cart')} · {cartCount}
              </span>
              <span className="text-base font-bold">{fmtCurrency(cartTotal)}</span>
            </button>
          </div>
        </div>
      )}

      {/* 商品详情弹窗 */}
      {detail && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDetail(null)} />
          <div className="relative bg-surface rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-dialog">
            <div className="relative aspect-video bg-surface-container">
              {detail.video_url ? (
                <video src={detail.video_url} controls autoPlay className="w-full h-full object-cover" poster={detail.image_url ?? undefined} />
              ) : detail.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={detail.image_url} alt={detail.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-on-surface-variant/40">
                  <UtensilsCrossed className="w-12 h-12" />
                </div>
              )}
              <button
                onClick={() => setDetail(null)}
                className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              <h2 className="text-lg font-bold text-on-surface">{detail.name}</h2>
              <p className="text-xs text-on-surface-variant mt-1">{detail.category} · {t('sold', { count: detail.sales_count })}</p>
              {detail.description && <p className="text-sm text-on-surface-variant mt-3 leading-relaxed">{detail.description}</p>}
              <div className="flex items-center justify-between mt-5">
                <span className="text-xl font-bold text-primary">{fmtCurrency(Number(detail.price))}</span>
                <div className="flex items-center gap-3">
                  {(cart[detail.id] ?? 0) > 0 && (
                    <>
                      <button onClick={() => add(detail.id, -1)} className="w-8 h-8 rounded-full bg-surface-container text-on-surface flex items-center justify-center">
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="text-base font-semibold text-on-surface w-6 text-center">{cart[detail.id]}</span>
                    </>
                  )}
                  <button onClick={() => add(detail.id, 1)} className="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-float">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 购物车抽屉 */}
      {cartOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setCartOpen(false)} />
          <div className="relative bg-surface rounded-t-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-dialog">
            <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant">
              <h2 className="text-base font-bold text-on-surface flex items-center gap-2">
                <ClipboardList className="w-5 h-5" />
                {t('cart')}
                {table && <span className="text-xs font-medium text-on-surface-variant">· {t('table')} {table}</span>}
              </h2>
              <button onClick={() => setCartOpen(false)} className="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {Object.entries(cart).map(([id, qty]) => {
                const p = byId.get(id);
                if (!p) return null;
                return (
                  <div key={id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-on-surface truncate">{p.name}</p>
                      <p className="text-xs text-primary font-semibold">{fmtCurrency(Number(p.price))}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => add(id, -1)} className="w-7 h-7 rounded-full bg-surface-container text-on-surface flex items-center justify-center">
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="text-sm font-semibold w-5 text-center text-on-surface">{qty}</span>
                      <button onClick={() => add(id, 1)} className="w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={t('notePlaceholder')}
                className="w-full bg-surface-container border-none rounded-lg px-3 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>
            <div className="px-4 py-3 border-t border-outline-variant">
              <div className="flex justify-between text-sm mb-3">
                <span className="text-on-surface-variant">{t('total')}</span>
                <span className="text-lg font-bold text-primary">{fmtCurrency(cartTotal)}</span>
              </div>
              <button
                onClick={placeOrder}
                disabled={placing}
                className="w-full py-3 rounded-xl bg-primary text-on-primary text-sm font-bold shadow-float disabled:opacity-60"
              >
                {placing ? t('placing') : t('placeOrder')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function StorePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      }
    >
      <Storefront />
    </Suspense>
  );
}
