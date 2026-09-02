'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, X, Sparkles, Bot, RefreshCw, Factory, QrCode, Download, Copy, Check, Trash2, ImagePlus, Video, ExternalLink, Pencil } from 'lucide-react';
import QRCode from 'qrcode';
import { fmtCurrency, fmtDateTime } from '@/lib/format';
import { Link } from '@/i18n/navigation';

type Tab = 'products' | 'orders' | 'inventory' | 'qr';

interface Product {
  id: string;
  name: string;
  category: string;
  price: string;
  cost: string;
  stock: number;
  sales_count: number;
  status: string;
  description: string | null;
  image_url: string | null;
  video_url: string | null;
  week_qty: number;
  week_revenue: number;
}

interface QrCodeRow {
  id: string;
  table_no: string;
  remark: string | null;
  is_active: boolean;
  scan_count: number;
  created_at: string;
}

const TABLES = [
  ...['A1', 'A2', 'A3', 'A4'],
  ...['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'],
];

interface Order {
  id: string;
  order_no: string;
  customer_name: string | null;
  items: { name: string; qty: number; price: number }[];
  total: string;
  channel: string;
  status: string;
  source: string;
  external_id: string | null;
  table_no: string | null;
  notes: string | null;
  created_at: string;
}

interface InventoryItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  current_stock: string;
  safety_stock: string;
  supplier: string | null;
  synced_at: string | null;
}

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  preparing: 'bg-primary/10 text-primary',
  done: 'bg-success/15 text-success',
  cancelled: 'bg-surface-container text-on-surface-variant',
};

const CHANNEL_BADGE: Record<string, string> = {
  dine_in: 'bg-surface-container text-on-surface-variant',
  takeout: 'bg-surface-container text-on-surface-variant',
  delivery: 'bg-primary/10 text-primary',
  online_store: 'bg-warning/15 text-warning',
};

export default function BusinessPage() {
  const t = useTranslations('business');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [tab, setTab] = useState<Tab>('products');

  // 产品
  const [products, setProducts] = useState<Product[]>([]);
  const [prodCats, setProdCats] = useState<string[]>([]);
  const [prodCatFilter, setProdCatFilter] = useState('all');
  const [showProdModal, setShowProdModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [prodForm, setProdForm] = useState({ name: '', category: '招牌菜', price: '', cost: '', description: '', image_url: '', video_url: '' });
  const [prodSaving, setProdSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // 点餐二维码
  const [qrCodes, setQrCodes] = useState<QrCodeRow[]>([]);
  const [qrTable, setQrTable] = useState('A1');
  const [qrRemark, setQrRemark] = useState('');
  const [qrSaving, setQrSaving] = useState(false);
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // 订单
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderStatusFilter, setOrderStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // 库存
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [invStats, setInvStats] = useState<{ total: number; lowStock: number; outOfStock: number } | null>(null);
  const [erpSource, setErpSource] = useState<{ connected: boolean; lastSyncAt: string | null } | null>(null);

  const loadProducts = useCallback(async () => {
    const res = await fetch('/api/business/products');
    const data = await res.json();
    setProducts(data.products ?? []);
    setProdCats(data.categories ?? []);
  }, []);

  const loadOrders = useCallback(async (status: string) => {
    const res = await fetch(`/api/business/orders?status=${status}`);
    const data = await res.json();
    setOrders(data.orders ?? []);
  }, []);

  const loadInventory = useCallback(async () => {
    const res = await fetch('/api/business/inventory');
    const data = await res.json();
    setInventory(data.items ?? []);
    setInvStats(data.stats ?? null);
    setErpSource(data.source ?? null);
  }, []);

  const loadQrCodes = useCallback(async () => {
    const res = await fetch('/api/store/qr-codes');
    const data = await res.json();
    const codes: QrCodeRow[] = data.codes ?? [];
    setQrCodes(codes);
    // 为每个码生成二维码图片
    const images: Record<string, string> = {};
    for (const c of codes) {
      const url = `${window.location.origin}/store?table=${encodeURIComponent(c.table_no)}`;
      images[c.id] = await QRCode.toDataURL(url, { width: 512, margin: 1, color: { dark: '#131B2E', light: '#FFFFFF' } });
    }
    setQrImages(images);
  }, []);

  useEffect(() => {
    if (tab === 'products') loadProducts();
    else if (tab === 'orders') loadOrders(orderStatusFilter);
    else if (tab === 'inventory') loadInventory();
    else loadQrCodes();
  }, [tab, orderStatusFilter, loadProducts, loadOrders, loadInventory, loadQrCodes]);

  const filteredProducts = useMemo(
    () => (prodCatFilter === 'all' ? products : products.filter((p) => p.category === prodCatFilter)),
    [products, prodCatFilter]
  );

  const toggleProductStatus = async (p: Product) => {
    const next = p.status === 'active' ? 'inactive' : 'active';
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)));
    await fetch('/api/business/products', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, status: next }),
    });
  };

  const openCreateProduct = () => {
    setEditingProduct(null);
    setProdForm({ name: '', category: '招牌菜', price: '', cost: '', description: '', image_url: '', video_url: '' });
    setShowProdModal(true);
  };

  const openEditProduct = (p: Product) => {
    setEditingProduct(p);
    setProdForm({
      name: p.name,
      category: p.category,
      price: String(p.price),
      cost: String(p.cost),
      description: p.description ?? '',
      image_url: p.image_url ?? '',
      video_url: p.video_url ?? '',
    });
    setShowProdModal(true);
  };

  const uploadMedia = async (file: File, kind: 'image' | 'video') => {
    const setLoading = kind === 'image' ? setUploadingImage : setUploadingVideo;
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProdForm((f) => ({ ...f, [kind === 'image' ? 'image_url' : 'video_url']: data.url }));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  const saveProduct = async () => {
    if (!prodForm.name.trim() || !prodForm.price) return;
    setProdSaving(true);
    try {
      const payload = {
        name: prodForm.name,
        category: prodForm.category,
        price: Number(prodForm.price),
        cost: Number(prodForm.cost) || 0,
        description: prodForm.description || null,
        image_url: prodForm.image_url || null,
        video_url: prodForm.video_url || null,
      };
      if (editingProduct) {
        await fetch('/api/business/products', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingProduct.id, ...payload }),
        });
      } else {
        await fetch('/api/business/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      setShowProdModal(false);
      setEditingProduct(null);
      setProdForm({ name: '', category: '招牌菜', price: '', cost: '', description: '', image_url: '', video_url: '' });
      await loadProducts();
    } finally {
      setProdSaving(false);
    }
  };

  const createQrCode = async () => {
    setQrSaving(true);
    try {
      await fetch('/api/store/qr-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_no: qrTable, remark: qrRemark }),
      });
      setQrRemark('');
      await loadQrCodes();
    } finally {
      setQrSaving(false);
    }
  };

  const removeQrCode = async (id: string) => {
    await fetch(`/api/store/qr-codes?id=${id}`, { method: 'DELETE' });
    await loadQrCodes();
  };

  const storeUrl = (table: string) => `${origin}/store?table=${encodeURIComponent(table)}`;

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const downloadQr = (c: QrCodeRow) => {
    const img = qrImages[c.id];
    if (!img) return;
    const a = document.createElement('a');
    a.href = img;
    a.download = `table-${c.table_no}-qr.png`;
    a.click();
  };

  const updateOrderStatus = async (id: string, status: string) => {
    await fetch('/api/business/orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    setSelectedOrder(null);
    await loadOrders(orderStatusFilter);
  };

  const stockState = (item: InventoryItem) => {
    const cur = Number(item.current_stock);
    if (cur <= 0) return 'out';
    if (cur < Number(item.safety_stock)) return 'low';
    return 'ok';
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'products', label: t('tabProducts') },
    { key: 'orders', label: t('tabOrders') },
    { key: 'inventory', label: t('tabInventory') },
    { key: 'qr', label: t('tabQr') },
  ];

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      {/* 标题 + Tab */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 bg-surface-container rounded-md p-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-all ${
                tab === tb.key ? 'bg-surface text-on-surface shadow-card' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {/* 产品管理面板 */}
      {tab === 'products' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setProdCatFilter('all')}
                className={`px-3 py-1.5 rounded-sm text-xs font-medium transition-all ${
                  prodCatFilter === 'all' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {tc('all')}
              </button>
              {prodCats.map((c) => (
                <button
                  key={c}
                  onClick={() => setProdCatFilter(c)}
                  className={`px-3 py-1.5 rounded-sm text-xs font-medium transition-all ${
                    prodCatFilter === c ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <button
              onClick={openCreateProduct}
              className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('newProduct')}
            </button>
          </div>

          <div className="bg-surface rounded-lg shadow-card overflow-hidden">
            <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_1fr_1fr_0.8fr] gap-3 px-5 py-3 bg-surface-container text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
              <span>{t('colName')}</span>
              <span>{t('colCategory')}</span>
              <span>{t('colPrice')}</span>
              <span>{t('colWeekSales')}</span>
              <span>{t('colWeekRevenue')}</span>
              <span>{t('colStatus')}</span>
            </div>
            <div className="divide-y divide-outline-variant/20">
              {filteredProducts.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</p>
              ) : (
                filteredProducts.map((p) => {
                  const on = p.status === 'active';
                  return (
                    <div
                      key={p.id}
                      className="grid grid-cols-[1.6fr_0.8fr_0.8fr_1fr_1fr_0.8fr] gap-3 px-5 py-3.5 items-center hover:bg-surface-container/50 transition-colors"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image_url} alt="" className="w-9 h-9 rounded-md object-cover shrink-0" />
                        ) : (
                          <span className="w-9 h-9 rounded-md bg-surface-container flex items-center justify-center shrink-0 text-on-surface-variant/40">
                            <ImagePlus className="w-4 h-4" />
                          </span>
                        )}
                        <span className="text-sm font-medium truncate">{p.name}</span>
                        <button
                          onClick={() => openEditProduct(p)}
                          title={tc('edit')}
                          className="shrink-0 w-6 h-6 rounded-sm hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-primary/10 text-primary w-fit">
                        {p.category}
                      </span>
                      <span className="text-sm">{fmtCurrency(p.price)}</span>
                      <span className="text-sm">{t('salesUnit', { count: p.week_qty })}</span>
                      <span className="text-sm font-semibold">{fmtCurrency(p.week_revenue)}</span>
                      <button onClick={() => toggleProductStatus(p)} className="inline-flex items-center gap-1.5 w-fit">
                        <span className={`w-8 h-4.5 rounded-full relative transition-colors ${on ? 'bg-success' : 'bg-surface-container-highest'}`}>
                          <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${on ? 'right-0.5' : 'left-0.5'}`} />
                        </span>
                        <span className={`text-xs font-medium ${on ? 'text-success' : 'text-on-surface-variant'}`}>
                          {on ? t('statusOn') : t('statusOff')}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* 订单管理面板 */}
      {tab === 'orders' && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            {['all', 'pending', 'preparing', 'done', 'cancelled'].map((st) => (
              <button
                key={st}
                onClick={() => setOrderStatusFilter(st)}
                className={`px-3 py-1.5 rounded-sm text-xs font-medium transition-all ${
                  orderStatusFilter === st ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {st === 'all' ? tc('all') : t(`orderStatuses.${st}` as 'orderStatuses.pending')}
              </button>
            ))}
          </div>
          <div className="bg-surface rounded-lg shadow-card overflow-hidden">
            <div className="grid grid-cols-[1.1fr_1fr_1.8fr_0.8fr_0.9fr_0.8fr] gap-3 px-5 py-3 bg-surface-container text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
              <span>{t('colOrderNo')}</span>
              <span>{t('colTime')}</span>
              <span>{t('colItems')}</span>
              <span>{t('colTotal')}</span>
              <span>{t('colChannel')}</span>
              <span>{t('colOrderStatus')}</span>
            </div>
            <div className="divide-y divide-outline-variant/20">
              {orders.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</p>
              ) : (
                orders.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setSelectedOrder(o)}
                    className="w-full grid grid-cols-[1.1fr_1fr_1.8fr_0.8fr_0.9fr_0.8fr] gap-3 px-5 py-3.5 items-center hover:bg-surface-container/50 transition-colors text-left"
                  >
                    <span className="text-sm font-medium">
                      {o.order_no}
                      {o.table_no && (
                        <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-semibold bg-primary/10 text-primary align-middle">
                          {o.table_no}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-on-surface-variant">{fmtDateTime(o.created_at, locale)}</span>
                    <span className="text-sm truncate">{o.items.map((it) => `${it.name} ×${it.qty}`).join('、')}</span>
                    <span className="text-sm font-semibold">{fmtCurrency(o.total)}</span>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium w-fit ${CHANNEL_BADGE[o.channel] ?? CHANNEL_BADGE.dine_in}`}>
                      {t(`channels.${o.channel}` as 'channels.dine_in')}
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium w-fit ${ORDER_STATUS_COLORS[o.status] ?? ORDER_STATUS_COLORS.pending}`}>
                      {t(`orderStatuses.${o.status}` as 'orderStatuses.pending')}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 库存管理面板 */}
      {tab === 'inventory' && (
        <div>
          {/* 数据源状态条 */}
          <div className="bg-surface rounded-lg shadow-card px-5 py-3.5 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                <Factory className="w-4 h-4" />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {t('erpSource')}
                  {erpSource?.connected ? '' : `（${t('erpNotConnected')}）`}
                </p>
                <p className="text-xs text-on-surface-variant">
                  {erpSource?.connected && erpSource.lastSyncAt
                    ? t('erpSyncedAt', { time: fmtDateTime(erpSource.lastSyncAt, locale) })
                    : t('erpFallback')}
                </p>
              </div>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium ${
                  erpSource?.connected ? 'bg-success/15 text-success' : 'bg-surface-container text-on-surface-variant'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${erpSource?.connected ? 'bg-success' : 'bg-on-surface-variant'}`} />
                {erpSource?.connected ? tc('connected') : tc('notConfigured')}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/settings" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                {t('manageIntegration')}
              </Link>
              <button className="text-sm text-primary font-medium hover:underline inline-flex items-center gap-1">
                <RefreshCw className="w-3.5 h-3.5" />
                {tc('syncNow')}
              </button>
            </div>
          </div>

          {/* 库存统计 */}
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="bg-surface rounded-lg shadow-card p-4">
              <p className="text-xs text-on-surface-variant">{t('invTotal')}</p>
              <p className="text-xl font-bold mt-1">
                {invStats?.total ?? '—'} <span className="text-xs font-normal text-on-surface-variant">{t('itemUnit')}</span>
              </p>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-4">
              <p className="text-xs text-on-surface-variant">{t('invLow')}</p>
              <p className="text-xl font-bold mt-1 text-warning">
                {invStats?.lowStock ?? '—'} <span className="text-xs font-normal text-on-surface-variant">{t('itemUnit')}</span>
              </p>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-4">
              <p className="text-xs text-on-surface-variant">{t('invOut')}</p>
              <p className="text-xl font-bold mt-1 text-error">
                {invStats?.outOfStock ?? '—'} <span className="text-xs font-normal text-on-surface-variant">{t('itemUnit')}</span>
              </p>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-4">
              <p className="text-xs text-on-surface-variant">{t('invPendingPO')}</p>
              <p className="text-xl font-bold mt-1">
                0 <span className="text-xs font-normal text-on-surface-variant">{t('poUnit')}</span>
              </p>
            </div>
          </div>

          {/* AI 采购建议卡 */}
          <div className="rounded-lg bg-primary/5 shadow-card p-4 mb-4 flex items-start gap-3">
            <span className="w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-0.5">{t('aiPurchaseTitle')}</p>
              <p className="text-sm text-on-surface-variant leading-relaxed">{t('aiPurchaseText')}</p>
            </div>
            <Link
              href="/agent"
              className="shrink-0 inline-flex items-center gap-1.5 bg-primary text-on-primary px-3.5 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all"
            >
              <Bot className="w-3.5 h-3.5" />
              {t('genPurchaseOrder')}
            </Link>
          </div>

          {/* 库存表格 */}
          <div className="bg-surface rounded-lg shadow-card overflow-hidden">
            <div className="grid grid-cols-[1.5fr_0.8fr_1fr_1fr_0.7fr_0.9fr_1fr] gap-3 px-5 py-3 bg-surface-container text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
              <span>{t('invColName')}</span>
              <span>{t('invColCategory')}</span>
              <span>{t('invColCurrent')}</span>
              <span>{t('invColSafety')}</span>
              <span>{t('invColUnit')}</span>
              <span>{t('colStatus')}</span>
              <span>{t('invColSupplier')}</span>
            </div>
            <div className="divide-y divide-outline-variant/20">
              {inventory.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-on-surface-variant">{tc('noData')}</p>
              ) : (
                inventory.map((item) => {
                  const st = stockState(item);
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[1.5fr_0.8fr_1fr_1fr_0.7fr_0.9fr_1fr] gap-3 px-5 py-3.5 items-center hover:bg-surface-container/50 transition-colors"
                    >
                      <span className="text-sm font-medium">{item.name}</span>
                      <span className="text-xs text-on-surface-variant">{item.category}</span>
                      <span className={`text-sm font-semibold ${st === 'out' ? 'text-error' : st === 'low' ? 'text-warning' : ''}`}>
                        {item.current_stock}
                      </span>
                      <span className="text-sm text-on-surface-variant">{item.safety_stock}</span>
                      <span className="text-sm">{item.unit}</span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium w-fit ${
                          st === 'out' ? 'bg-error/15 text-error' : st === 'low' ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'
                        }`}
                      >
                        {t(`stockStates.${st}`)}
                      </span>
                      <span className="text-xs text-on-surface-variant">{item.supplier ?? '—'}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* 点餐二维码面板 */}
      {tab === 'qr' && (
        <div className="space-y-5">
          {/* 店铺链接与菜单 API */}
          <div className="bg-surface rounded-lg shadow-card p-5">
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <ExternalLink className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold">{t('storeLinks')}</h3>
                <p className="text-xs text-on-surface-variant mt-0.5">{t('storeLinksNote')}</p>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-on-surface-variant w-20 shrink-0">{t('storefrontUrl')}</span>
                    <code className="flex-1 min-w-0 truncate bg-surface-container rounded-md px-3 py-2 text-xs">{origin}/store</code>
                    <button
                      onClick={() => copyText('store', `${origin}/store`)}
                      className="shrink-0 w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                      title={tc('copy')}
                    >
                      {copied === 'store' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <Link
                      href="/store"
                      target="_blank"
                      className="shrink-0 w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                      title={t('openStore')}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-on-surface-variant w-20 shrink-0">{t('menuApi')}</span>
                    <code className="flex-1 min-w-0 truncate bg-surface-container rounded-md px-3 py-2 text-xs">{origin}/api/store/menu</code>
                    <button
                      onClick={() => copyText('api', `${origin}/api/store/menu`)}
                      className="shrink-0 w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                      title={tc('copy')}
                    >
                      {copied === 'api' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-on-surface-variant/70 mt-2">{t('menuApiNote')}</p>
              </div>
            </div>
          </div>

          {/* 生成二维码 */}
          <div className="bg-surface rounded-lg shadow-card p-5">
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <QrCode className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold">{t('qrGenerate')}</h3>
                <p className="text-xs text-on-surface-variant mt-0.5">{t('qrGenerateNote')}</p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <select
                    value={qrTable}
                    onChange={(e) => setQrTable(e.target.value)}
                    className="bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <optgroup label={t('qrPrivateRooms')}>
                      {TABLES.slice(0, 4).map((tb) => <option key={tb} value={tb}>{tb}</option>)}
                    </optgroup>
                    <optgroup label={t('qrMainHall')}>
                      {TABLES.slice(4).map((tb) => <option key={tb} value={tb}>{tb}</option>)}
                    </optgroup>
                  </select>
                  <input
                    value={qrRemark}
                    onChange={(e) => setQrRemark(e.target.value)}
                    placeholder={t('qrRemarkPlaceholder')}
                    className="flex-1 min-w-48 bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={createQrCode}
                    disabled={qrSaving}
                    className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60"
                  >
                    {qrSaving ? tc('loading') : t('qrGenerateBtn')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 二维码列表 */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {qrCodes.map((c) => (
              <div key={c.id} className="bg-surface rounded-lg shadow-card p-4 flex flex-col items-center text-center">
                <div className="w-full aspect-square rounded-md overflow-hidden bg-white mb-3">
                  {qrImages[c.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qrImages[c.id]} alt={`QR ${c.table_no}`} className="w-full h-full object-contain" />
                  ) : (
                    <div className="w-full h-full bg-surface-container animate-pulse" />
                  )}
                </div>
                <p className="text-base font-bold">{t('qrTable', { table: c.table_no })}</p>
                <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-1">{c.remark || t('qrNoRemark')}</p>
                <p className="text-[11px] text-on-surface-variant/70 mt-1">{t('qrScans', { count: c.scan_count })}</p>
                <div className="flex items-center gap-1.5 mt-3">
                  <button
                    onClick={() => downloadQr(c)}
                    className="w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                    title={t('qrDownload')}
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => copyText(c.id, storeUrl(c.table_no))}
                    className="w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                    title={tc('copy')}
                  >
                    {copied === c.id ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <a
                    href={storeUrl(c.table_no)}
                    target="_blank"
                    rel="noreferrer"
                    className="w-8 h-8 rounded-md bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"
                    title={t('openStore')}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => removeQrCode(c.id)}
                    className="w-8 h-8 rounded-md bg-error/10 hover:bg-error/20 flex items-center justify-center text-error transition-colors"
                    title={tc('delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {qrCodes.length === 0 && (
              <div className="col-span-full bg-surface rounded-lg shadow-card py-12 text-center text-sm text-on-surface-variant">
                {t('qrEmpty')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 产品表单弹窗 */}
      {showProdModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setShowProdModal(false)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">{editingProduct ? t('editProduct') : t('newProduct')}</h3>
              <button
                onClick={() => setShowProdModal(false)}
                className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('prodName')}</label>
                <input
                  value={prodForm.name}
                  onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })}
                  type="text"
                  className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('colCategory')}</label>
                  <input
                    value={prodForm.category}
                    onChange={(e) => setProdForm({ ...prodForm, category: e.target.value })}
                    type="text"
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('colPrice')}</label>
                  <input
                    value={prodForm.price}
                    onChange={(e) => setProdForm({ ...prodForm, price: e.target.value })}
                    type="number"
                    min="0"
                    className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('prodCost')}</label>
                <input
                  value={prodForm.cost}
                  onChange={(e) => setProdForm({ ...prodForm, cost: e.target.value })}
                  type="number"
                  min="0"
                  className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('prodDesc')}</label>
                <textarea
                  value={prodForm.description}
                  onChange={(e) => setProdForm({ ...prodForm, description: e.target.value })}
                  rows={3}
                  placeholder={t('prodDescPlaceholder')}
                  className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('prodImage')}</label>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadMedia(f, 'image');
                      e.target.value = '';
                    }}
                  />
                  {prodForm.image_url ? (
                    <div className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={prodForm.image_url} alt="" className="w-full h-24 rounded-md object-cover" />
                      <button
                        onClick={() => setProdForm({ ...prodForm, image_url: '' })}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      disabled={uploadingImage}
                      className="w-full h-24 rounded-md border-2 border-dashed border-outline-variant bg-surface-container/50 flex flex-col items-center justify-center gap-1 text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-60"
                    >
                      {uploadingImage ? (
                        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      ) : (
                        <>
                          <ImagePlus className="w-5 h-5" />
                          <span className="text-[11px]">{t('uploadImage')}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1.5">{t('prodVideo')}</label>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadMedia(f, 'video');
                      e.target.value = '';
                    }}
                  />
                  {prodForm.video_url ? (
                    <div className="relative group">
                      <video src={prodForm.video_url} className="w-full h-24 rounded-md object-cover" muted />
                      <button
                        onClick={() => setProdForm({ ...prodForm, video_url: '' })}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => videoInputRef.current?.click()}
                      disabled={uploadingVideo}
                      className="w-full h-24 rounded-md border-2 border-dashed border-outline-variant bg-surface-container/50 flex flex-col items-center justify-center gap-1 text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-60"
                    >
                      {uploadingVideo ? (
                        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      ) : (
                        <>
                          <Video className="w-5 h-5" />
                          <span className="text-[11px]">{t('uploadVideo')}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-on-surface-variant/70">{t('mediaNote')}</p>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowProdModal(false)}
                className="bg-surface-container text-on-surface border-none px-4 py-2 rounded-md text-sm font-medium hover:bg-surface-container-high active:scale-[0.98] transition-all"
              >
                {tc('cancel')}
              </button>
              <button
                onClick={saveProduct}
                disabled={prodSaving || !prodForm.name.trim() || !prodForm.price}
                className="bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {prodSaving ? tc('loading') : tc('save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 订单详情抽屉 */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSelectedOrder(null)} />
          <div className="absolute right-0 top-0 bottom-0 w-96 bg-surface shadow-dialog flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20">
              <h3 className="text-base font-semibold">{t('orderDetail')}</h3>
              <button
                onClick={() => setSelectedOrder(null)}
                className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div>
                <p className="text-lg font-bold">{selectedOrder.order_no}</p>
                <p className="text-xs text-on-surface-variant mt-1">{fmtDateTime(selectedOrder.created_at, locale)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium ${CHANNEL_BADGE[selectedOrder.channel] ?? CHANNEL_BADGE.dine_in}`}>
                  {t(`channels.${selectedOrder.channel}` as 'channels.dine_in')}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${ORDER_STATUS_COLORS[selectedOrder.status] ?? ORDER_STATUS_COLORS.pending}`}>
                  {t(`orderStatuses.${selectedOrder.status}` as 'orderStatuses.pending')}
                </span>
                {selectedOrder.source !== 'native' && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-warning/15 text-warning">
                    {selectedOrder.source === 'square' ? 'Square POS' : selectedOrder.source === 'shopify' ? 'Shopify' : selectedOrder.source}
                  </span>
                )}
              </div>
              {selectedOrder.customer_name && (
                <div className="rounded-md bg-surface-container/60 p-3">
                  <p className="text-xs text-on-surface-variant">{t('orderCustomer')}</p>
                  <p className="text-sm font-medium mt-0.5">{selectedOrder.customer_name}</p>
                </div>
              )}
              {selectedOrder.table_no && (
                <div>
                  <p className="text-xs text-on-surface-variant">{t('orderTable')}</p>
                  <p className="text-sm font-medium mt-0.5">{selectedOrder.table_no}</p>
                </div>
              )}
              {selectedOrder.notes && (
                <div>
                  <p className="text-xs text-on-surface-variant">{t('orderNotes')}</p>
                  <p className="text-sm mt-0.5">{selectedOrder.notes}</p>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-on-surface-variant mb-2">{t('colItems')}</p>
                <div className="space-y-1.5">
                  {selectedOrder.items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between rounded-md bg-surface-container/60 px-3 py-2">
                      <span className="text-sm">{it.name} ×{it.qty}</span>
                      <span className="text-sm font-medium">{fmtCurrency(it.qty * it.price)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-outline-variant/20 pt-3">
                <span className="text-sm font-medium">{t('colTotal')}</span>
                <span className="text-lg font-bold">{fmtCurrency(selectedOrder.total)}</span>
              </div>
              {selectedOrder.status === 'pending' && (
                <button
                  onClick={() => updateOrderStatus(selectedOrder.id, 'preparing')}
                  className="w-full bg-primary text-on-primary px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all"
                >
                  {t('acceptOrder')}
                </button>
              )}
              {selectedOrder.status === 'preparing' && (
                <button
                  onClick={() => updateOrderStatus(selectedOrder.id, 'done')}
                  className="w-full bg-success text-white px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all"
                >
                  {t('completeOrder')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
