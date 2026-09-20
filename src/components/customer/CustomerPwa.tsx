'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Utensils,
  Bike,
  CalendarCheck,
  BookOpen,
  User,
  ShoppingBag,
  Plus,
  Minus,
  CheckCircle2,
  Clock,
  MapPin,
  AlertCircle,
  X,
  Navigation,
  ChevronRight,
  ChevronLeft,
  Percent,
  Sparkles,
  LayoutGrid,
  SlidersHorizontal,
  Home,
  Search,
  ReceiptText,
  ChefHat,
} from 'lucide-react';
import {
  CustomerMode,
  Locale,
  MenuItem,
  StoreMenuResponse,
  SiteConfigResponse,
  CustomerAccount,
  CustomerAddress,
  CustomerOrderSummary,
} from '@/types';
import { customerApi, newIdempotencyKey } from '@/lib/api';
import { fmtCurrency, fmtDateTime } from '@/lib/format';
import { getTranslations } from '@/lib/i18n';
import { fadeClass, slideUpClass, usePresence } from '@/components/pwa/presence';
import { TierInstallPrompt } from '@/components/pwa/tier-install-prompt';
import { DeliveryTrackerMap } from '@/components/delivery/delivery-tracker';
import { DishDetailModal } from './DishDetailModal';
import { FlyingDishOverlay, FlyingDishParticle } from './FlyingDishOverlay';

/** 把 PwaApiError / 任意异常收敛成一条能显示的消息（原型读的就是 `e.error`）。 */
function describeError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const message = (err as { error?: unknown }).error;
    if (typeof message === 'string' && message) return message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * `/api/site/config` 返回的网页点单 token。
 *
 * 后端确实返回它（src/app/api/site/config/route.ts 的 `orderToken`），但已 vendor 的
 * `SiteConfigResponse`（src/types/index.ts，本次不允许改）里没有这个字段，所以在这里
 * 做一次带收窄的读取：拿不到就是 null，绝不猜一个能过校验的值。
 */
function readWebOrderToken(config: SiteConfigResponse | null): string | null {
  if (!config) return null;
  const value = (config as SiteConfigResponse & { orderToken?: unknown }).orderToken;
  return typeof value === 'string' && value ? value : null;
}

type DeliveryDict = ReturnType<typeof getTranslations>['delivery'];

/** rider_status → 配送文案。后端的 `pending` 在 UI 里叫 `unclaimed`（见 api.ts 的映射）。 */
const RIDER_STATUS_LABEL: Record<
  NonNullable<CustomerOrderSummary['rider_status']>,
  keyof DeliveryDict
> = {
  unclaimed: 'status_pending',
  claimed: 'status_claimed',
  picked_up: 'status_picked_up',
  delivered: 'status_delivered',
};

interface CustomerPwaProps {
  locale: Locale;
  /** 页面从 `?token=` 读到的门店二维码 token。 */
  token?: string;
  /** 页面按 token 反查到的**已发布**站点 slug；没有已发布站点时不传。 */
  slug?: string;
  initialMode?: CustomerMode;
  onModeChange?: (mode: CustomerMode) => void;
}

/**
 * 顾客端 PWA（Phase 18）。
 *
 * 与原型的三处**行为**差异，都不是美化，是接真数据时必须改的：
 *
 *   1. `token` 由页面传入并真正参与请求。原型把 token 写成 `tbl_A1` 与 `'WEB'`
 *      两个字面量 —— 前者不是合法 token（`resolvePublicStore` 要求 32-64 位十六进制），
 *      后者同样不是，扫码进来的每一单都会 404。
 *   2. `slug` 不再有写死的默认值 `'grove-bistro'`：库里不存在这个 slug，而原型把
 *      6 个请求塞进同一个 Promise.all，一个 404 会让菜单数据一起丢。"没有 slug"
 *      是合法状态（扫码顾客本来就没有），此时只按堂食 / 菜单渲染。
 *   3. 后厨巡检与上传入口整体移除，理由见同目录后厨巡检弹窗的文件头。
 */
export const CustomerPwa: React.FC<CustomerPwaProps> = ({
  locale,
  token: qrToken,
  slug,
  initialMode = 'dine_in',
  onModeChange,
}) => {
  const t = getTranslations(locale);

  // Mode state synced with URL/prop
  const [mode, setMode] = useState<CustomerMode>(initialMode);
  const [customerSection, setCustomerSection] = useState<'home' | 'explore'>(
    initialMode === 'dine_in' ? 'home' : 'explore'
  );
  const [config, setConfig] = useState<SiteConfigResponse | null>(null);
  const [menuData, setMenuData] = useState<StoreMenuResponse | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [cart, setCart] = useState<{ [productId: string]: number }>({});
  
  // Tipping state: default 10% tip rate as requested by user
  const [tipRate, setTipRate] = useState<number>(10);
  const [isCustomTip, setIsCustomTip] = useState<boolean>(false);
  const [customTipAmt, setCustomTipAmt] = useState<string>('');
  const [orderNotes, setOrderNotes] = useState<string>('');
  // 桌号来自二维码：服务端按 token 解析 table_no，客户端只负责显示。
  // 原型这里配了一个写死的桌位选择器（['A1','A2','B3','V8']，其中 V8 连 seed
  // 约定里都不存在），顾客可以把自己"换"到任意桌 —— 而服务端计价与出单根本不读
  // 这个值，它只影响页面上印出来的桌号。选择器连同那块 UI 一起删掉。
  const [tableNo, setTableNo] = useState<string>('');

  // Culinary detail state。
  //
  // Phase 18：后厨巡检 / 上传**不接入渲染树**。合规横幅是写死的
  // 「Grade A / 1.8-2.3°C / 4 次全区巡查」，上传者还能给自己发 verified。
  // 组件文件保留（后端真做出来再接回来），入口与状态一并删除。
  const [selectedDish, setSelectedDish] = useState<MenuItem | null>(null);
  // "打开"与"当前餐品"分开：关闭时数据要留到退出动画播完，否则 usePresence
  // 期间 selectedDish 已经是 null，弹层会闪空。
  const [dishOpen, setDishOpen] = useState(false);
  const closeDish = () => setDishOpen(false);
  const openDish = (product: MenuItem) => {
    setSelectedDish(product);
    setDishOpen(true);
  };

  // Delivery form state
  // 原型把收餐人预填成 'Jane Doe' / '+1 (555) 345-6789' / '742 Evergreen Terrace'，
  // 那是演示数据：顾客不填就能把一单寄给一个不存在的人。留空并在提交前校验。
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [addressNote, setAddressNote] = useState('');
  const [saveToBook, setSaveToBook] = useState(false);

  // Booking form state
  const [partySize, setPartySize] = useState<number>(2);
  // 预约时间的默认值（明天 19:00）只能在挂载后算：服务端渲染与浏览器不是同一
  // 时刻，写在 useState 初值里会造成 hydration 不一致
  // （AGENTS.md 明令禁止渲染期用 Date.now()）。
  const [bookingTime, setBookingTime] = useState<string>('');
  useEffect(() => {
    const d = new Date(Date.now() + 24 * 3600000);
    setBookingTime(`${d.toISOString().slice(0, 10)}T19:00`);
  }, []);
  // 同收餐人：原型预填的 'Jane Doe' 是演示数据。
  const [bookingName, setBookingName] = useState('');
  const [bookingPhone, setBookingPhone] = useState('');
  const [bookingNotes, setBookingNotes] = useState('');

  // Customer Auth & Account state
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showOrdersModal, setShowOrdersModal] = useState(false);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrderSummary[]>([]);
  const [savedAddresses, setSavedAddresses] = useState<CustomerAddress[]>([]);
  const [selectedTrackingOrder, setSelectedTrackingOrder] = useState<CustomerOrderSummary | null>(null);
  const [showTrackingModal, setShowTrackingModal] = useState<boolean>(false);

  // Feedback states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionSuccess, setSubmissionSuccess] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showCartDrawer, setShowCartDrawer] = useState(false);

  // Apple Animation States (Fluid Flying Dish & Dynamic Island)
  const [flyingParticles, setFlyingParticles] = useState<FlyingDishParticle[]>([]);
  const [cartBouncing, setCartBouncing] = useState(false);
  const [activeToast, setActiveToast] = useState<{ name: string; imageUrl?: string; price?: string } | null>(null);

  // Apple Frosted Glass View Mode: 'slider' (滑动的方框) or 'bento' (毛玻璃双列方框)
  const [viewMode, setViewMode] = useState<'slider' | 'bento'>('slider');
  const sliderRef = useRef<HTMLDivElement>(null);

  const scrollSlider = (direction: 'left' | 'right') => {
    if (sliderRef.current) {
      const scrollAmount = direction === 'left' ? -310 : 310;
      sliderRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  const webOrderToken = readWebOrderToken(config);

  /**
   * 下单与取菜单用的 token。
   *
   * 堂食 / 菜单：扫码进来的二维码 token（服务端按它定位租户、桌号并计价）。
   * 外卖：商家站点的网页点单 token（`/api/site/config` 的 orderToken），没有它
   *       就没有可用的 WEB 桌码。
   * 两个都拿不到时传空串，让后端的 404 明确失败 —— 不编一个能过校验的假 token。
   */
  const orderToken = mode === 'delivery' ? webOrderToken ?? qrToken ?? '' : qrToken ?? '';

  // 站点配置与菜单**分开**加载。
  //
  // 原型用一个 Promise.all 拉 6 个接口：其中任何一个失败（例如商家没发布官网，
  // /api/site/config 404）都会让菜单数据一起丢，顾客看到的是空白菜单。拆开后，
  // 配置失败只降级 tab 可见性，菜单照常渲染；失败原因照旧写进页面顶部的错误条。
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    customerApi
      .getSiteConfig(slug)
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch((err: unknown) => {
        if (!cancelled) setErrorMessage(describeError(err, 'Failed to load store configuration'));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [menu, user, addresses, orders] = await Promise.all([
          customerApi.getMenu(orderToken),
          customerApi.getCustomerAccount(),
          customerApi.getCustomerAddresses(),
          customerApi.getCustomerOrders(),
        ]);
        setMenuData(menu);
        setCustomer(user);
        setSavedAddresses(addresses);
        setCustomerOrders(orders);
      } catch (err: unknown) {
        setErrorMessage(describeError(err, 'Failed to load restaurant menu'));
      }
    };
    loadData();
  }, [orderToken]);

  // 桌号以服务端解析出来的为准（二维码 → store_qr_codes.table_no）。
  useEffect(() => {
    if (menuData?.table) setTableNo(menuData.table);
  }, [menuData]);

  const handleModeSwitch = (newMode: CustomerMode) => {
    setMode(newMode);
    setCustomerSection('explore');
    onModeChange?.(newMode);
    setSubmissionSuccess(null);
    setErrorMessage(null);
  };

  // Apple-grade Flying Dish Trigger
  const triggerFlyingDish = (prod: MenuItem, e?: React.MouseEvent) => {
    let startX = window.innerWidth / 2;
    let startY = window.innerHeight / 2;

    if (e && e.currentTarget) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      startX = rect.left + rect.width / 2;
      startY = rect.top + rect.height / 2;
    }

    const particleId = `particle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setFlyingParticles((prev) => [
      ...prev,
      {
        id: particleId,
        startX,
        startY,
        targetX: window.innerWidth / 2,
        targetY: window.innerHeight - 44,
        imageUrl: prod.image_url,
        name: prod.name,
      },
    ]);

    setActiveToast({
      name: prod.name,
      imageUrl: prod.image_url,
      price: fmtCurrency(prod.price, currency, locale),
    });

    setTimeout(() => {
      setActiveToast((curr) => (curr?.name === prod.name ? null : curr));
    }, 2400);
  };

  const handleParticleComplete = (id: string) => {
    setFlyingParticles((prev) => prev.filter((p) => p.id !== id));
    // Trigger Apple haptic cart spring bounce
    setCartBouncing(true);
    setTimeout(() => setCartBouncing(false), 550);
  };

  // Cart operations
  const updateQuantity = (productId: string, delta: number, e?: React.MouseEvent) => {
    if (delta > 0) {
      const prod = menuData?.products.find((p) => p.id === productId);
      if (prod) {
        triggerFlyingDish(prod, e);
      }
    }
    setCart((prev) => {
      const next = { ...prev };
      const current = next[productId] || 0;
      const updated = current + delta;
      if (updated <= 0) {
        delete next[productId];
      } else {
        next[productId] = updated;
      }
      return next;
    });
  };

  const getSubtotal = () => {
    if (!menuData) return 0;
    return Object.entries(cart).reduce((sum, [pId, qty]) => {
      const p = menuData.products.find((prod) => prod.id === pId);
      return sum + (p ? parseFloat(p.price) * qty : 0);
    }, 0);
  };

  const totalItemCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const subtotal = getSubtotal();

  // 店名 / 简介 / 营业时间 / 币种 / 头图：全部取后端已经返回的字段。
  // 原型在这些位置写死了 'Grove Bistro & Café'、'10:00 - 22:00'、
  // 'LE JARDIN · GROVE BISTRO'、★4.8、'320+ 位宾客推荐' 与一张 Unsplash 库存照 ——
  // 顾客看到的会是一个不存在的店名、一段编出来的营业时间与一个假评分。
  const storeName = config?.store.name || menuData?.store.name || '';
  const storeIntro = menuData?.store.intro || '';
  const storeHours = config?.store.hours || menuData?.store.hours || '';
  const storeMonogram = storeName.trim().slice(0, 2).toUpperCase();
  const heroImageUrl = menuData?.products[0]?.image_url || '';
  const currency = (config ? config.store.currency : undefined) || menuData?.store.currency;

  // 配送规则缺失时**不能下单**：下面几个派生值会退化成 0 元配送费 / 0 元门槛，
  // 那等于替商家编一条配送规则。
  const minOrder = config?.delivery.minOrderAmount ?? 0;
  const deliveryFee = config
    ? subtotal >= config.delivery.freeDeliveryAbove
      ? 0
      : config.delivery.fee
    : 0;
  const isBelowMin = mode === 'delivery' && subtotal < minOrder;
  const minDiff = Math.max(0, minOrder - subtotal);
  const deliveryUnavailable = mode === 'delivery' && !config;

  // 在途外卖单：只有它才有配送状态可看。
  const activeDelivery =
    customerOrders.find(
      (o) => o.channel === 'delivery' && o.status !== 'completed' && o.status !== 'cancelled'
    ) ?? null;

  // 三个弹层的进出场：usePresence 负责"退场播完再卸载"，时长与各自 CSS 的
  // transition-duration 一致（200 / 250 / 250），不一致会切断动画或留下空节点。
  const cartIslandPresence = usePresence(
    customerSection === 'explore' && mode !== 'menu' && mode !== 'booking' && totalItemCount > 0,
    200,
  );
  const cartDrawerPresence = usePresence(showCartDrawer, 250);
  const dishPresence = usePresence(dishOpen, 250);

  // Computed tip based on default 10% rate, user-selected rate, or custom amount
  const computedTip = isCustomTip
    ? Math.max(0, parseFloat(customTipAmt) || 0)
    : tipRate > 0
      ? Number(((subtotal * tipRate) / 100).toFixed(2))
      : 0;

  // Submit dine-in order
  const handleDineInSubmit = async () => {
    if (totalItemCount === 0) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const payload = {
        // 堂食的 token 就是二维码 token：服务端按它取租户与桌号。
        token: orderToken,
        items: Object.entries(cart).map(([product_id, qty]) => ({ product_id, qty })),
        notes: orderNotes,
        tip: computedTip,
        tip_rate: isCustomTip ? undefined : tipRate,
        // 用 api 层导出的 newIdempotencyKey，而不是"idemp_ + 毫秒时间戳"：
        // 同一毫秒内的两次点击会撞成同一个键，那不是可以碰运气的地方。
        idempotency_key: newIdempotencyKey('dinein'),
      };
      const res = await customerApi.createDineInOrder(payload);
      setSubmissionSuccess(`堂食下单成功！订单号: ${res.order_no}，桌号: ${tableNo}，含服务小费 ${fmtCurrency(computedTip, currency, locale)}`);
      setCart({});
      setShowCartDrawer(false);
    } catch (err: unknown) {
      const e = err as { error?: string };
      setErrorMessage(e.error || 'Failed to submit dine-in order');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit delivery order
  const handleDeliverySubmit = async () => {
    if (totalItemCount === 0 || isBelowMin || deliveryUnavailable) return;
    // 收餐人信息留空时不要带着空字段去下单（后端会 400，而顾客看不懂）。
    if (!recipientName.trim() || !recipientPhone.trim() || !addressLine.trim()) {
      setErrorMessage('请填写收餐人姓名、联系电话与详细收货地址');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const payload = {
        // 外卖用网页点单 token（WEB 桌码），不是扫码进来的桌码。
        token: orderToken,
        items: Object.entries(cart).map(([product_id, qty]) => ({ product_id, qty })),
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        address_line: addressLine,
        address_note: addressNote,
        notes: orderNotes,
        tip: computedTip,
        tip_rate: isCustomTip ? undefined : tipRate,
        idempotency_key: newIdempotencyKey('delivery'),
      };
      const res = await customerApi.createDeliveryOrder(payload);
      const freshOrders = await customerApi.getCustomerOrders();
      setCustomerOrders(freshOrders);
      const createdOrder = freshOrders.find((o) => o.id === res.order_id || o.order_no === res.order_no) || freshOrders[0];
      if (createdOrder) {
        setSelectedTrackingOrder(createdOrder);
        setShowTrackingModal(true);
      }
      setSubmissionSuccess(
        `外卖订单已送达餐厅！单号: ${res.order_no}，总计: ${fmtCurrency(res.total, currency, locale)}，预计送达: ${fmtDateTime(res.promised_at, locale)}`
      );
      if (saveToBook && customer) {
        await customerApi.saveCustomerAddress({
          label: 'Custom',
          recipient_name: recipientName,
          recipient_phone: recipientPhone,
          address_line: addressLine,
          address_note: addressNote,
          is_default: false,
        });
      }
      setCart({});
      setShowCartDrawer(false);
    } catch (err: unknown) {
      const e = err as { error?: string };
      setErrorMessage(e.error || 'Failed to submit delivery order');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit reservation
  const handleBookingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await customerApi.createReservation({
        // 预约接口按 slug 定位商家。没有已发布站点时传空串让后端明确 400 ——
        // 预约入口本来也只在拿到站点配置（modes.booking）后才显示。
        slug: slug ?? '',
        customer_name: bookingName,
        phone: bookingPhone,
        party_size: partySize,
        reserved_at: new Date(bookingTime).toISOString(),
        notes: bookingNotes,
      });
      setSubmissionSuccess(`座位预约已成功提交 (ID: ${res.id.slice(-6)})，我们将为您保留座位！`);
    } catch (err: unknown) {
      setErrorMessage(describeError(err, 'Booking submission failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auth handler。
  //
  // Phase 18：注册分支真的走注册接口。原型里 authMode 只影响文案 —— 点"立即注册"
  // 再提交，走的仍然是登录接口，新用户只会收到一句 Authentication error，
  // 查不出原因。邮箱 / 手机号按形态分流（注册接口把两者当两个字段）。
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authEmail) return;
    try {
      const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(authEmail) ? authEmail : '';
      const user =
        authMode === 'register'
          ? await customerApi.customerRegister({
              slug: slug ?? '',
              email,
              phone: email ? '' : authEmail,
              password: authPassword,
              locale,
            })
          : await customerApi.customerLogin(authEmail, authPassword);
      setCustomer(user);
      setShowAuthModal(false);
      setAuthPassword('');
    } catch (err: unknown) {
      setErrorMessage(describeError(err, 'Authentication error'));
    }
  };

  const handleOpenOrders = async () => {
    const orders = await customerApi.getCustomerOrders();
    setCustomerOrders(orders);
    setShowOrdersModal(true);
  };

  const categories = menuData ? ['All', ...menuData.categories] : ['All'];
  const filteredProducts =
    menuData?.products.filter((p) => activeCategory === 'All' || p.category === activeCategory) || [];

  return (
    <div className={`rf-customer ${customerSection === 'home' ? 'rf-customer--home' : ''} min-h-screen bg-[#F5F5F7] text-[#1D1D1F] pb-28 font-sans select-none antialiased`}>
      {/* PWA Install Banner */}
      <div className="p-3 max-w-lg mx-auto">
        <TierInstallPrompt appName={storeName || 'RoveFrame'} />
      </div>

      {/* Top Header with Apple Navigation Bar */}
      <header className="rf-customer-header sticky top-0 z-30 apple-glass-nav px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#1D1D1F] text-white flex items-center justify-center font-bold text-xs shadow-xs">
              {storeMonogram || 'RF'}
            </div>
            <div>
              <h1 className="font-bold text-[15px] leading-tight text-[#1D1D1F] tracking-tight">
                {storeName}
              </h1>
              <div className="flex items-center gap-1.5 text-[11px] text-[#86868B] mt-0.5">
                {storeHours && <Clock className="w-3 h-3 text-[#86868B]" />}
                <span>{storeHours}</span>
                {mode === 'dine_in' && tableNo && (
                  <span className="bg-black/5 text-[#1D1D1F] px-2 py-0.5 rounded-full font-medium text-[10px]">
                    {t.store.table_label}: {tableNo}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {customer ? (
              <button
                onClick={handleOpenOrders}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-black/[0.08] text-[#1D1D1F] text-xs font-medium shadow-2xs hover:bg-stone-50 transition active:scale-95"
                id="customer-my-orders-btn"
              >
                <User className="w-3.5 h-3.5 text-stone-500" />
                <span className="max-w-[75px] truncate">{customer.display_name}</span>
              </button>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-black/[0.08] text-xs text-[#1D1D1F] font-medium shadow-2xs hover:bg-stone-50 transition active:scale-95"
                id="customer-login-btn"
              >
                <User className="w-3.5 h-3.5 text-stone-500" />
                <span>登录</span>
              </button>
            )}
          </div>
        </div>

        {/* Apple Segmented Control for 4 Modes */}
        <div className="max-w-lg mx-auto mt-2.5">
          <div className="relative p-1 rounded-xl apple-segmented-track flex items-center justify-between gap-1">
            {[
              { key: 'dine_in' as CustomerMode, label: t.store.dine_in, icon: Utensils, id: 'mode-dine-in-btn' },
              ...(config?.modes.delivery
                ? [{ key: 'delivery' as CustomerMode, label: t.store.delivery, icon: Bike, id: 'mode-delivery-btn' }]
                : []),
              ...(config?.modes.booking
                ? [{ key: 'booking' as CustomerMode, label: t.store.booking, icon: CalendarCheck, id: 'mode-booking-btn' }]
                : []),
              { key: 'menu' as CustomerMode, label: t.store.menu_only, icon: BookOpen, id: 'mode-menu-btn' },
            ].map((m) => {
              const isSelected = mode === m.key;
              const IconComp = m.icon;
              return (
                <button
                  key={m.key}
                  onClick={() => handleModeSwitch(m.key)}
                  id={m.id}
                  className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 ${
                    isSelected ? 'text-[#1D1D1F] font-semibold' : 'text-[#86868B] hover:text-[#1D1D1F]'
                  }`}
                >
                  {/* 选中态滑块。原型用 motion 的 layoutId（跨按钮的共享布局动画），
                      滑块会从旧按钮"飞"到新按钮上；CSS 没有共享布局，改成滑块只属于
                      选中项、以缩放淡入进场 —— 视觉结果（滑块落在选中项上）一致，
                      差别只在于没有横跨两个按钮的那段位移。 */}
                  {isSelected && (
                    <div className="rf-enter-pop absolute inset-0 apple-segmented-thumb rounded-lg" />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    <IconComp className="w-3.5 h-3.5" />
                    <span>{m.label}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Reassurance strip */}
          {/* 原型这里是一个"后厨卫生实况 (4)"的入口：数字写死
              （kitchenPhotos.length || 4），点进去是那张编造合规数据的横幅。
              入口删掉，只留下有出处的文案。 */}
          <div className="mt-2 flex items-center gap-1.5 text-[11px] px-1 text-[#86868B]">
            <Sparkles className="w-3 h-3 text-amber-600" />
            <span>原产地冷链直达 · 主厨当日鲜烹</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="rf-customer-main max-w-lg mx-auto px-4 py-4 space-y-4">
        {/* Alerts / Banner Feedback */}
        {submissionSuccess && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">{t.store.order_success}</div>
              <div className="mt-0.5 leading-relaxed">{submissionSuccess}</div>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">操作提示</div>
              <div className="mt-0.5 leading-relaxed">{errorMessage}</div>
            </div>
          </div>
        )}

        {customerSection === 'home' && (
          <section className="rf-customer-home space-y-5">
            {/* 首屏大图。原型的店名（LE JARDIN · GROVE BISTRO）、评分（★4.8）、
                "320+ 位宾客推荐"与营业时间都是写死的字面量，背景还是一张 Unsplash
                库存照。这里改成：店名 / 简介 / 营业时间取后端字段，背景图取**本店
                第一道菜的实拍图**；评分和推荐数没有数据源，直接不显示 ——
                编一个 4.8 分和编 "Grade A" 是同一类问题。 */}
            <div
              className="rf-customer-hero rf-enter-rise"
              style={
                heroImageUrl
                  ? {
                      backgroundImage: `linear-gradient(180deg, rgba(16,12,8,.12), rgba(16,12,8,.82)), url('${heroImageUrl}')`,
                    }
                  : undefined
              }
            >
              <div className="rf-customer-hero-top">
                <span className="rf-monogram">✦</span>
              </div>
              <div className="rf-customer-hero-copy">
                <p>{storeName}</p>
                {storeIntro && <h2>{storeIntro}</h2>}
                {storeHours && (
                  <div className="rf-hero-meta">
                    <span>{storeHours}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="rf-mode-grid" aria-label="用餐方式">
              {[
                { key: 'dine_in' as CustomerMode, label: '堂食', caption: 'Dine in', icon: Utensils },
                { key: 'delivery' as CustomerMode, label: '外卖', caption: 'Delivery', icon: Bike },
                { key: 'booking' as CustomerMode, label: '预订', caption: 'Reservation', icon: CalendarCheck },
                { key: 'menu' as CustomerMode, label: '菜单', caption: 'Menu', icon: BookOpen },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.key} onClick={() => handleModeSwitch(item.key)} className="rf-mode-card">
                    <Icon className="w-5 h-5" />
                    <strong>{item.label}</strong>
                    <span>{item.caption}</span>
                  </button>
                );
              })}
            </div>

            <div className="rf-section-heading">
              <div>
                {/* 撇号必须转义：JSX 文本里的裸 ' 会触发 react/no-unescaped-entities。 */}
                <p>CHEF&apos;S RECOMMENDATION</p>
                <h3>主厨推荐</h3>
              </div>
              <button onClick={() => handleModeSwitch('menu')}>查看全部 <ChevronRight className="w-4 h-4" /></button>
            </div>

            <div className="rf-home-dishes">
              {(menuData?.products || []).slice(0, 2).map((product, index) => (
                // 原型的入场动画是 motion 的 opacity/y + 逐项延迟，这里用
                // .rf-enter-rise 关键帧 + animationDelay 复刻同一条曲线。
                <article
                  key={product.id}
                  className="rf-home-dish rf-enter-rise"
                  style={{ animationDelay: `${0.08 + index * 0.06}s` }}
                  onClick={() => openDish(product)}
                >
                  <img src={product.image_url} alt={product.name} referrerPolicy="no-referrer" />
                  <div>
                    <span><ChefHat className="w-3.5 h-3.5" /> 主厨甄选</span>
                    <h4>{product.name}</h4>
                    <p>{product.description}</p>
                    <footer>
                      <strong>{fmtCurrency(product.price, currency, locale)}</strong>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          updateQuantity(product.id, 1, event);
                        }}
                        aria-label={`添加 ${product.name}`}
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </footer>
                  </div>
                </article>
              ))}
            </div>

            {/* "今日厨房"卡片删除：两张图是 Unsplash 库存照，点进去是那张编造
                合规数据的后厨巡检弹窗。没有真实的后厨照片数据源之前，这里什么都不放。 */}
          </section>
        )}

        {/* MODE 1 & 2: DINE-IN / DELIVERY / MENU (Menu Catalog) */}
        {customerSection === 'explore' && (mode === 'dine_in' || mode === 'delivery' || mode === 'menu') && (
          <section className="space-y-3">
            {/* 外卖模式：只显示订单记录里**真实存在**的配送信息。
                原型这里是一整块"实时雷达"：写死的骑手姓名 / 头像 / 评分 / 车型、
                每 2 秒自己往前走的 GPS 进度条、"预计 11 分钟 / 剩余 1.2 km"，外加一个
                Google 地图依赖。后端没有其中任何一项的数据源（见 src/lib/api.ts 文件头
                第 3 条），所以整块删除，只留下有出处的：配送规则（/api/site/config）、
                在途单的骑手状态与承诺送达时间。 */}
            {mode === 'delivery' && config && (
              <div className="space-y-3">
                {/* 1. Delivery Pricing & ETA Terms */}
                <div className="p-3.5 bg-gradient-to-r from-amber-50/90 to-amber-100/50 border border-amber-200/80 rounded-2xl text-xs text-amber-950 flex items-center justify-between shadow-xs">
                  <div className="space-y-0.5">
                    <div className="font-semibold flex items-center gap-1.5">
                      <Bike className="w-3.5 h-3.5 text-amber-700" />
                      <span>起送门槛: {fmtCurrency(minOrder, currency, locale)}</span>
                      <span className="text-amber-400">·</span>
                      <span>满 {fmtCurrency(config?.delivery.freeDeliveryAbove, currency, locale)} 免配送费</span>
                    </div>
                    <div className="text-[11px] text-amber-800/85">
                      {t.delivery.prep_time_prefix} {config?.delivery.prepMinutes} {t.delivery.prep_time_unit}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="inline-block px-2.5 py-1 bg-amber-200/90 text-amber-950 rounded-lg font-bold text-[10px] shadow-2xs">
                      {t.delivery.delivery_fee} {fmtCurrency(config?.delivery.fee, currency, locale)}
                    </span>
                  </div>
                </div>

                {/* 原型这里是"实时雷达"：unsplash 头像、写死的骑手姓名与评分、
                    每 2 秒自己往前走的进度条、"预计 11 分钟 / 剩余 1.2 km"、
                    以及"GPS 实时轨迹透明"的承诺。后端一项都不提供，所以只剩
                    订单记录里真实存在的骑手状态与承诺送达时间。 */}
                <div className="bg-white px-4 py-3 rounded-2xl border border-stone-200/90 shadow-2xs flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-800 flex items-center justify-center">
                      <Navigation className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-stone-900">
                        {activeDelivery
                          ? t.delivery[RIDER_STATUS_LABEL[activeDelivery.rider_status ?? 'unclaimed']]
                          : '当前没有在途的外卖订单'}
                      </div>
                      <div className="text-[11px] text-stone-500">
                        {activeDelivery?.promised_at
                          ? `${t.delivery.eta_prefix} ${fmtDateTime(activeDelivery.promised_at, locale)}`
                          : activeDelivery
                            ? `订单 ${activeDelivery.order_no}`
                            : '下单后这里会显示配送进度'}
                      </div>
                    </div>
                  </div>
                  {activeDelivery && (
                    <button
                      onClick={() => {
                        setSelectedTrackingOrder(activeDelivery);
                        setShowTrackingModal(true);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-medium transition"
                      id="open-tracker-btn"
                    >
                      查看配送状态
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 配送规则没拿到就不能显示"满 X 免配送费"这类规则（下面会退化成 0），
                明确说不提供外卖，而不是拿 0 元规则糊过去。 */}
            {mode === 'delivery' && !config && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs">
                {t.delivery.not_enabled}
              </div>
            )}

            {/* 桌位选择器删除（见上面 tableNo 的注释）：桌号由二维码决定，
                不由顾客自己挑；服务端本来也不读它。 */}

            {/* Category Filter & View Mode Controls Bar */}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              {/* Category Pills */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none flex-1">
                {categories.map((cat) => {
                  const isSelected = activeCategory === cat;
                  return (
                    <button
                      key={cat}
                      onClick={() => setActiveCategory(cat)}
                      className={`px-3.5 py-1.5 rounded-full text-xs transition-colors duration-150 whitespace-nowrap ${
                        isSelected
                          ? 'bg-[#1D1D1F] text-white font-semibold shadow-xs'
                          : 'bg-white/80 backdrop-blur-md text-stone-600 border border-black/[0.06] hover:bg-white'
                      }`}
                    >
                      {cat === 'All' ? '全部餐品' : cat}
                    </button>
                  );
                })}
              </div>

              {/* View Layout Toggle: Sliding Cards vs Bento Grid */}
              <div className="flex items-center p-0.5 rounded-lg bg-black/[0.06] shrink-0">
                <button
                  onClick={() => setViewMode('slider')}
                  title="滑动方框画廊"
                  className={`p-1.5 rounded-md text-xs transition-all ${
                    viewMode === 'slider'
                      ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                      : 'text-stone-500 hover:text-[#1D1D1F]'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('bento')}
                  title="双列方框网格"
                  className={`p-1.5 rounded-md text-xs transition-all ${
                    viewMode === 'bento'
                      ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                      : 'text-stone-500 hover:text-[#1D1D1F]'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Header Hint & Slider Controls */}
            {viewMode === 'slider' && (
              <div className="flex items-center justify-between px-1 text-xs text-[#86868B]">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  <span className="font-medium text-[#1D1D1F]">
                    滑动方框选餐
                  </span>
                  <span className="text-[11px] text-[#86868B]">
                    · 左右滑动浏览 {filteredProducts.length} 款美味
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => scrollSlider('left')}
                    aria-label="向左滑动"
                    className="w-7 h-7 rounded-full bg-white/90 border border-black/[0.06] text-[#1D1D1F] flex items-center justify-center hover:bg-white active:scale-95 shadow-2xs transition"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => scrollSlider('right')}
                    aria-label="向右滑动"
                    className="w-7 h-7 rounded-full bg-white/90 border border-black/[0.06] text-[#1D1D1F] flex items-center justify-center hover:bg-white active:scale-95 shadow-2xs transition"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* VIEW MODE 1: 滑动的毛玻璃方框画廊 (Apple Sliding Frosted Glass Square Carousel) */}
            {viewMode === 'slider' ? (
              <div className="relative">
                <div
                  ref={sliderRef}
                  className="flex gap-4 overflow-x-auto snap-x snap-mandatory py-2 px-1 -mx-1 scrollbar-none scroll-smooth"
                >
                  {filteredProducts.map((product: MenuItem) => {
                    const qty = cart[product.id] || 0;
                    return (
                      <div
                        key={product.id}
                        onClick={() => setSelectedDish(product)}
                        className="w-[280px] sm:w-[320px] shrink-0 snap-center rounded-[28px] overflow-hidden apple-glass-square flex flex-col group cursor-pointer transition-all duration-300 relative select-none"
                        id={`dish-card-${product.id}`}
                      >
                        {/* Upper Square Photo Section with Apple Glass Overlay */}
                        <div className="relative aspect-square w-full overflow-hidden bg-stone-100">
                          <img
                            src={product.image_url}
                            alt={product.name}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent pointer-events-none" />

                          {/* Top Floating Glass Badges */}
                          <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 z-10">
                            {product.chef_badge && (
                              <span className="px-2.5 py-1 rounded-full apple-glass-badge text-[#1D1D1F] font-bold text-[10px] flex items-center gap-1 shadow-xs">
                                <Sparkles className="w-2.5 h-2.5 text-amber-600" />
                                <span>{product.chef_badge}</span>
                              </span>
                            )}
                            <span className="px-2.5 py-1 rounded-full apple-glass-dark-badge text-white text-[10px] font-medium backdrop-blur-md">
                              {product.cuisine_type || product.category}
                            </span>
                          </div>

                          {/* Top Right Price Tag in Apple Glass Pill */}
                          <div className="absolute top-3 right-3 z-10">
                            <span className="px-3 py-1 rounded-full apple-glass-dark-badge text-white font-mono font-bold text-xs shadow-md">
                              {fmtCurrency(product.price, currency, locale)}
                            </span>
                          </div>

                          {/* Bottom Overlay on Image: Title & Caloric info */}
                          <div className="absolute bottom-3 left-3.5 right-3.5 z-10 text-white">
                            <h3 className="font-bold text-lg leading-tight tracking-tight drop-shadow-md line-clamp-1">
                              {product.name}
                            </h3>
                            <div className="flex items-center gap-2 mt-1 text-[11px] text-stone-200">
                              {product.calories && (
                                <span>约 {product.calories} kcal</span>
                              )}
                              <span>· 已售 {product.sales_count}</span>
                            </div>
                          </div>
                        </div>

                        {/* Bottom Apple Frosted Glass Info & Action Dock */}
                        <div className="apple-glass-dock p-3.5 flex flex-col justify-between flex-1 gap-2.5">
                          <p className="text-xs text-[#86868B] line-clamp-2 leading-relaxed">
                            {product.story || product.description}
                          </p>

                          <div className="flex items-center justify-between pt-2 border-t border-black/[0.04]">
                            <div className="text-[11px] text-[#1D1D1F] font-medium flex items-center gap-1 group-hover:text-emerald-700 transition-colors">
                              <span>品鉴手记</span>
                              <ChevronRight className="w-3 h-3 text-[#86868B]" />
                            </div>

                            {/* Quantity Controls */}
                            {mode !== 'menu' && (
                              <div
                                className="flex items-center gap-1.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {qty > 0 ? (
                                  <div className="flex items-center gap-2 bg-white/95 px-2 py-1 rounded-full shadow-xs border border-black/[0.06] backdrop-blur-md">
                                    <button
                                      onClick={(e) => updateQuantity(product.id, -1, e)}
                                      className="w-6 h-6 rounded-full bg-[#F5F5F7] text-[#1D1D1F] hover:bg-stone-200 flex items-center justify-center transition active:scale-90"
                                    >
                                      <Minus className="w-3 h-3" />
                                    </button>
                                    <span className="text-xs font-bold font-mono w-4 text-center text-[#1D1D1F]">
                                      {qty}
                                    </span>
                                    <button
                                      onClick={(e) => updateQuantity(product.id, 1, e)}
                                      className="w-6 h-6 rounded-full bg-[#1D1D1F] text-white hover:bg-black flex items-center justify-center transition active:scale-90"
                                    >
                                      <Plus className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={(e) => updateQuantity(product.id, 1, e)}
                                    className="px-3.5 py-1.5 rounded-full bg-[#1D1D1F] text-white text-xs font-medium hover:bg-black flex items-center gap-1.5 shadow-xs transition active:scale-90"
                                    id={`add-btn-${product.id}`}
                                  >
                                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                                    <span>点餐</span>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Subtitle Swipe Helper */}
                <div className="text-center mt-1 text-[11px] text-[#86868B] flex items-center justify-center gap-1.5">
                  <span>← 左右滑动方框探索更多餐品 · 点击卡片查看赏鉴手记 →</span>
                </div>
              </div>
            ) : (
              /* VIEW MODE 2: 双列毛玻璃方框网格 (Apple Glass Bento Grid) */
              <div className="grid grid-cols-2 gap-3.5 pt-1">
                {filteredProducts.map((product: MenuItem) => {
                  const qty = cart[product.id] || 0;
                  return (
                    <div
                      key={product.id}
                      onClick={() => setSelectedDish(product)}
                      className="rounded-2xl overflow-hidden apple-glass-square flex flex-col cursor-pointer transition-all duration-200 hover:scale-[1.015] active:scale-[0.985] relative"
                      id={`dish-bento-${product.id}`}
                    >
                      <div className="relative aspect-square w-full overflow-hidden bg-stone-100">
                        <img
                          src={product.image_url}
                          alt={product.name}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />

                        {product.chef_badge && (
                          <div className="absolute top-2 left-2">
                            <span className="px-2 py-0.5 rounded-md apple-glass-badge text-[#1D1D1F] font-bold text-[9px]">
                              {product.chef_badge}
                            </span>
                          </div>
                        )}

                        <div className="absolute top-2 right-2">
                          <span className="px-2 py-0.5 rounded-full apple-glass-dark-badge text-white font-mono font-bold text-[11px]">
                            {fmtCurrency(product.price, currency, locale)}
                          </span>
                        </div>

                        <div className="absolute bottom-2 left-2.5 right-2.5 text-white">
                          <h3 className="font-bold text-sm leading-tight line-clamp-1">
                            {product.name}
                          </h3>
                        </div>
                      </div>

                      <div className="apple-glass-dock p-2.5 flex items-center justify-between gap-1 mt-auto">
                        <span className="text-[10px] text-[#86868B] line-clamp-1">
                          已售 {product.sales_count}
                        </span>

                        {mode !== 'menu' && (
                          <div
                            className="flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {qty > 0 ? (
                              <div className="flex items-center gap-1 bg-white/95 px-1.5 py-0.5 rounded-full shadow-2xs border border-black/[0.06]">
                                <button
                                  onClick={(e) => updateQuantity(product.id, -1, e)}
                                  className="w-5 h-5 rounded-full bg-[#F5F5F7] text-[#1D1D1F] flex items-center justify-center text-xs"
                                >
                                  -
                                </button>
                                <span className="text-[11px] font-bold font-mono w-3.5 text-center">
                                  {qty}
                                </span>
                                <button
                                  onClick={(e) => updateQuantity(product.id, 1, e)}
                                  className="w-5 h-5 rounded-full bg-[#1D1D1F] text-white flex items-center justify-center text-xs"
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={(e) => updateQuantity(product.id, 1, e)}
                                className="w-7 h-7 rounded-full bg-[#1D1D1F] text-white flex items-center justify-center shadow-xs transition active:scale-90"
                              >
                                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* MODE 3: RESERVATION BOOKING */}
        {customerSection === 'explore' && mode === 'booking' && (
          <section className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs space-y-4">
            <div>
              <h2 className="font-bold text-sm text-slate-900">{t.site.reserve_table}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{t.site.window_limit_tip}</p>
            </div>

            <form onSubmit={handleBookingSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">{t.site.party_size}</label>
                <div className="grid grid-cols-6 gap-1.5">
                  {[1, 2, 4, 6, 8, 10].map((num) => (
                    <button
                      type="button"
                      key={num}
                      onClick={() => setPartySize(num)}
                      className={`py-2 rounded-lg font-semibold border transition ${
                        partySize === num
                          ? 'bg-teal-800 text-white border-teal-800'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {num} 人
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">{t.site.date_time}</label>
                <input
                  type="datetime-local"
                  required
                  value={bookingTime}
                  onChange={(e) => setBookingTime(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-teal-600 focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.site.contact_name}</label>
                  <input
                    type="text"
                    required
                    value={bookingName}
                    onChange={(e) => setBookingName(e.target.value)}
                    placeholder="您的称呼"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-teal-600 focus:outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.site.contact_phone}</label>
                  <input
                    type="tel"
                    required
                    value={bookingPhone}
                    onChange={(e) => setBookingPhone(e.target.value)}
                    placeholder="联系电话"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-teal-600 focus:outline-hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">{t.site.special_requests}</label>
                <textarea
                  rows={2}
                  value={bookingNotes}
                  onChange={(e) => setBookingNotes(e.target.value)}
                  placeholder="纪念日、宝宝椅、靠窗座位或过敏需求"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-teal-600 focus:outline-hidden"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2.5 rounded-xl bg-teal-800 hover:bg-teal-900 text-white font-semibold text-xs shadow-md transition disabled:opacity-50"
                id="submit-booking-btn"
              >
                {isSubmitting ? '提交预约中...' : t.site.submit_booking}
              </button>
            </form>
          </section>
        )}
      </main>

      {/* Apple Dynamic Island Floating Cart Bar */}
      {cartIslandPresence.mounted && (
        // 原型的进场/退场是弹簧（y 70↔50、scale .9↔1、cartBouncing 时 1.04）。
        // CSS 给不了弹簧的过冲，改成等价幅度的 200ms ease-out 过渡：
        // 位移与缩放都在，只是没有回弹。"退场播完再卸载"由 usePresence 负责。
        <div
          className={`rf-cart-island fixed bottom-5 left-0 right-0 z-40 px-4 pointer-events-none transition-all duration-200 ease-out ${cartIslandPresence.visible ? (cartBouncing ? 'translate-y-0 opacity-100 scale-[1.04]' : 'translate-y-0 opacity-100 scale-100') : 'translate-y-[70px] opacity-0 scale-90'}`}
        >
            <div className="max-w-md mx-auto bg-[#1D1D1F]/95 text-white rounded-full p-2 pl-3.5 pr-2 shadow-2xl border border-white/10 flex items-center justify-between gap-3 pointer-events-auto backdrop-blur-md">
              <button
                onClick={() => setShowCartDrawer(!showCartDrawer)}
                className="flex items-center gap-2.5 text-left focus:outline-hidden"
              >
                <div className="relative w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center">
                  <ShoppingBag className="w-4 h-4 text-white" />
                  <span className="absolute -top-1 -right-1 bg-white text-[#1D1D1F] text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shadow-xs">
                    {totalItemCount}
                  </span>
                </div>
                <div>
                  <div className="font-bold font-mono text-sm text-white flex items-center gap-1.5 tracking-tight">
                    <span>{fmtCurrency(subtotal, currency, locale)}</span>
                    <span className="text-[11px] font-sans font-normal text-stone-400">
                      ({totalItemCount} 份)
                    </span>
                  </div>
                  <div className="text-[10px] text-stone-400">
                    {mode === 'delivery'
                      ? isBelowMin
                        ? `差 ${fmtCurrency(minDiff, currency, locale)} 起送`
                        : deliveryFee === 0
                        ? '免配送费'
                        : `配送费 ${fmtCurrency(deliveryFee, currency, locale)}`
                      : `就餐桌号 · ${tableNo}`}
                  </div>
                </div>
              </button>

              <button
                disabled={isSubmitting || isBelowMin || deliveryUnavailable}
                onClick={() => {
                  if (!showCartDrawer) {
                    setShowCartDrawer(true);
                  } else {
                    if (mode === 'dine_in') handleDineInSubmit();
                    if (mode === 'delivery') handleDeliverySubmit();
                  }
                }}
                className={`px-5 py-2 rounded-full font-semibold text-xs transition active:scale-95 flex items-center gap-1 ${
                  isBelowMin
                    ? 'bg-stone-800 text-stone-500 cursor-not-allowed'
                    : 'bg-white text-[#1D1D1F] hover:bg-stone-100 shadow-xs'
                }`}
                id="checkout-bottom-btn"
              >
                <span>{isBelowMin ? `差 ${fmtCurrency(minDiff, currency, locale)}` : '结算'}</span>
                <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
        </div>
      )}

      {/* Cart & Delivery Drawer Modal (iOS Liquid Sheet) */}
      {cartDrawerPresence.mounted && (
        <div
          className={`fixed inset-0 z-50 bg-black/50 flex items-end justify-center ${fadeClass(cartDrawerPresence.visible)}`}
          onClick={() => setShowCartDrawer(false)}
        >
          <div
            className={`w-full max-w-lg bg-white text-[#1D1D1F] rounded-t-[28px] max-h-[88vh] overflow-y-auto p-5 space-y-4 shadow-2xl border-t border-black/[0.06] ${slideUpClass(cartDrawerPresence.visible)}`}
            onClick={(e) => e.stopPropagation()}
          >
              {/* iOS Grabber */}
              <div className="w-full flex justify-center pb-1">
                <div className="w-9 h-1 rounded-full bg-stone-300" />
              </div>

              <div className="flex items-center justify-between pb-2 border-b border-stone-100">
                <div className="font-bold text-sm text-[#1D1D1F] flex items-center gap-1.5">
                  <ShoppingBag className="w-4 h-4 text-[#1D1D1F]" />
                  <span>{mode === 'delivery' ? '外送订单明细' : `堂食点单确认 (${tableNo} 桌)`}</span>
                </div>
                <button
                  onClick={() => setShowCartDrawer(false)}
                  className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center text-stone-500 hover:text-stone-800 transition active:scale-90"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

            {/* Selected Items List */}
            <div className="divide-y divide-slate-100 space-y-1">
              {Object.entries(cart).map(([pId, qty]) => {
                const prod = menuData?.products.find((p) => p.id === pId);
                if (!prod) return null;
                return (
                  <div key={pId} className="py-2.5 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-semibold text-slate-800">{prod.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {fmtCurrency(prod.price, currency, locale)} / 份
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => updateQuantity(pId, -1)}
                        className="w-5 h-5 rounded bg-slate-100 flex items-center justify-center text-slate-600"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="font-bold text-xs w-4 text-center">{qty}</span>
                      <button
                        onClick={() => updateQuantity(pId, 1)}
                        className="w-5 h-5 rounded bg-teal-700 text-white flex items-center justify-center"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                      <span className="font-bold text-xs w-14 text-right text-slate-900">
                        {fmtCurrency(parseFloat(prod.price) * qty, currency, locale)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* DELIVERY SPECIFIC FORM (conforming to §4.2) */}
            {mode === 'delivery' && (
              <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3 text-xs">
                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-teal-700" />
                  <span>配送收餐信息</span>
                </div>

                {savedAddresses.length > 0 && (
                  <div>
                    <label className="text-[11px] text-slate-500 mb-1 block">从常用地址选取：</label>
                    <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                      {savedAddresses.map((addr) => (
                        <button
                          key={addr.id}
                          type="button"
                          onClick={() => {
                            setRecipientName(addr.recipient_name);
                            setRecipientPhone(addr.recipient_phone);
                            setAddressLine(addr.address_line);
                            setAddressNote(addr.address_note);
                          }}
                          className="px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:border-teal-600 text-[11px] text-slate-700 whitespace-nowrap shrink-0"
                        >
                          {addr.label}: {addr.address_line.slice(0, 16)}...
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-slate-600 block mb-0.5">收餐人姓名</label>
                    <input
                      type="text"
                      required
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-600 block mb-0.5">联系电话</label>
                    <input
                      type="tel"
                      required
                      value={recipientPhone}
                      onChange={(e) => setRecipientPhone(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] text-slate-600 block mb-0.5">详细收货地址</label>
                  <input
                    type="text"
                    required
                    value={addressLine}
                    onChange={(e) => setAddressLine(e.target.value)}
                    placeholder="街道门牌号"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                  />
                </div>

                <div>
                  <label className="text-[11px] text-slate-600 block mb-0.5">门牌/备用说明（可选）</label>
                  <input
                    type="text"
                    value={addressNote}
                    onChange={(e) => setAddressNote(e.target.value)}
                    placeholder="如：放前台或到达电联"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                  />
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="saveToBookCheck"
                    checked={saveToBook}
                    onChange={(e) => setSaveToBook(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-teal-600"
                  />
                  <label htmlFor="saveToBookCheck" className="text-[11px] text-slate-600 cursor-pointer">
                    保存至我的常用地址簿
                  </label>
                </div>
              </div>
            )}

            {/* HIGH-END MODERN BISTRO TIPPING MODULE (10% DEFAULT WITH CANCEL OPTION) */}
            <div className="bg-stone-50 border border-stone-200/90 rounded-2xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-800 flex items-center justify-center font-bold text-xs border border-amber-500/20">
                    <Percent className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <div className="font-serif font-bold text-stone-900 text-xs flex items-center gap-1.5">
                      <span>后厨与服务激励小费</span>
                      {tipRate === 10 && !isCustomTip && (
                        <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-bold">
                          默认10%
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-stone-500 mt-0.5">
                      {tipRate > 0 || isCustomTip
                        ? `当前计入: ${fmtCurrency(computedTip, currency, locale)} (${isCustomTip ? '自定义' : tipRate + '%'})`
                        : '小费已取消 (支付 0%)'}
                    </div>
                  </div>
                </div>

                {/* Cancel Default Tip Button */}
                {(tipRate > 0 || isCustomTip) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTipRate(0);
                      setIsCustomTip(false);
                      setCustomTipAmt('');
                    }}
                    className="px-2.5 py-1 rounded-lg border border-stone-300 bg-white text-[11px] font-semibold text-stone-600 hover:bg-stone-100 transition shadow-2xs"
                    id="cancel-default-tip-btn"
                  >
                    取消小费
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setTipRate(10);
                      setIsCustomTip(false);
                    }}
                    className="px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 transition shadow-2xs"
                    id="restore-default-tip-btn"
                  >
                    恢复默认10%
                  </button>
                )}
              </div>

              {/* Tip Selection Grid */}
              <div className="grid grid-cols-4 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTipRate(0);
                    setIsCustomTip(false);
                    setCustomTipAmt('');
                  }}
                  className={`py-2 px-1 rounded-xl text-center border font-semibold text-[11px] transition ${
                    tipRate === 0 && !isCustomTip
                      ? 'bg-stone-800 text-white border-stone-800 shadow-2xs'
                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                  }`}
                  id="tip-opt-0"
                >
                  <span className="block">0%</span>
                  <span className="block text-[9px] font-normal opacity-80">取消</span>
                </button>

                {[10, 15, 20].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      setTipRate(pct);
                      setIsCustomTip(false);
                      setCustomTipAmt('');
                    }}
                    className={`py-2 px-1 rounded-xl text-center border font-semibold text-[11px] transition relative ${
                      tipRate === pct && !isCustomTip
                        ? 'bg-emerald-800 text-white border-emerald-800 shadow-2xs ring-2 ring-emerald-800/20'
                        : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                    }`}
                    id={`tip-opt-${pct}`}
                  >
                    <span className="block">{pct}%</span>
                    <span className="block text-[9px] font-normal">
                      {pct === 10 ? '默认推荐' : pct === 15 ? '卓越满意' : '极致尊荣'}
                    </span>
                    {pct === 10 && (
                      <span className="absolute -top-1.5 -right-1 px-1 rounded-full bg-amber-400 text-stone-950 font-bold text-[8px] shadow-2xs">
                        默认
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* Automatic rule indicator conforming to user prompt */}
              <div className="text-[10px] text-stone-500 bg-stone-100/80 p-2 rounded-xl leading-relaxed border border-stone-200/50">
                ✦ 提示：系统<strong>默认按餐品小计的 10% 自动计算服务激励小费</strong>。如您不想支付，可点击上方「取消小费」或「0%」。未点击取消将自动计入结账，款项直接归属于出品主厨与服务人员。
              </div>

              {/* 点单备注 */}
              <div>
                <label className="font-semibold text-stone-700 block mb-1 text-[11px]">点单备注 / 忌口与出品要求</label>
                <input
                  type="text"
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  placeholder="如：免葱姜蒜、酱汁另放、少冰或餐具偏好"
                  className="w-full px-3 py-1.5 rounded-xl border border-stone-300 text-xs bg-white focus:ring-2 focus:ring-emerald-700 focus:outline-hidden"
                />
              </div>
            </div>

            {/* Price Breakdown */}
            <div className="pt-2 border-t border-stone-200 text-xs space-y-1.5">
              <div className="flex justify-between text-stone-600">
                <span>菜品小计</span>
                <span className="font-mono font-medium">{fmtCurrency(subtotal, currency, locale)}</span>
              </div>
              {mode === 'delivery' && (
                <div className="flex justify-between text-stone-600">
                  <span>配送费</span>
                  <span className="font-mono">
                    {deliveryFee === 0 ? '已免配送费' : fmtCurrency(deliveryFee, currency, locale)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-stone-600">
                <span className="flex items-center gap-1">
                  <span>服务激励小费</span>
                  <span className="text-[10px] text-stone-400">
                    {tipRate > 0 ? `(${tipRate}%)` : '(已取消)'}
                  </span>
                </span>
                <span className="font-mono font-medium text-emerald-800">
                  {computedTip > 0 ? fmtCurrency(computedTip, currency, locale) : '$0.00'}
                </span>
              </div>
              <div className="flex justify-between font-bold text-sm text-stone-900 pt-2 border-t border-stone-200">
                <span>实付总额</span>
                <span className="text-emerald-900 font-mono text-base font-bold">
                  {fmtCurrency(
                    subtotal + (mode === 'delivery' ? deliveryFee : 0) + computedTip,
                    currency,
                    locale
                  )}
                </span>
              </div>
            </div>

            {/* Confirm Submit Action */}
            <button
              disabled={isSubmitting || isBelowMin || deliveryUnavailable}
              onClick={() => {
                if (mode === 'dine_in') handleDineInSubmit();
                if (mode === 'delivery') handleDeliverySubmit();
              }}
              className="w-full py-3.5 rounded-2xl bg-[#1D1D1F] hover:bg-black text-white font-semibold text-xs shadow-md transition-all active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2"
              id="confirm-checkout-btn"
            >
              {isSubmitting ? (
                '提交订单处理中...'
              ) : (
                <>
                  <span>
                    确认支付 {fmtCurrency(subtotal + (mode === 'delivery' ? deliveryFee : 0) + computedTip, currency, locale)}
                  </span>
                  {computedTip > 0 && (
                    <span className="text-[10px] font-normal text-stone-400">
                      (含 {tipRate}% 小费)
                    </span>
                  )}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* CUSTOMER AUTH MODAL */}
      {showAuthModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setShowAuthModal(false)}
        >
          <div
            className="w-full max-w-xs bg-white rounded-2xl p-5 shadow-2xl space-y-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <div className="font-bold text-sm text-slate-900">
                {authMode === 'login' ? '顾客登录' : '顾客注册'}
              </div>
              <button onClick={() => setShowAuthModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[11px] text-slate-500">
              登录后即可保存地址簿并随时查看外卖送达进度。（游客可直接下单）
            </p>

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              <div>
                <label className="block text-slate-600 font-medium mb-1">邮箱或手机号</label>
                <input
                  type="text"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">密码</label>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-teal-800 text-white font-semibold text-xs shadow-xs"
              >
                {authMode === 'login' ? '立即登录' : '创建新账号'}
              </button>
            </form>

            <div className="text-center pt-1 text-[11px] text-slate-500">
              {authMode === 'login' ? (
                <span>
                  没有账号？{' '}
                  <button
                    onClick={() => setAuthMode('register')}
                    className="text-teal-700 font-semibold hover:underline"
                  >
                    立即注册
                  </button>
                </span>
              ) : (
                <span>
                  已有账号？{' '}
                  <button
                    onClick={() => setAuthMode('login')}
                    className="text-teal-700 font-semibold hover:underline"
                  >
                    直接登录
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MY ORDERS MODAL */}
      {showOrdersModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setShowOrdersModal(false)}
        >
          <div
            className="w-full max-w-md bg-white rounded-2xl p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <User className="w-4 h-4 text-teal-700" />
                <span>我的历史订单 ({customerOrders.length})</span>
              </div>
              <button onClick={() => setShowOrdersModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {customerOrders.length === 0 ? (
              <div className="text-center py-8 text-slate-400">暂无下单记录</div>
            ) : (
              <div className="space-y-3">
                {customerOrders.map((ord) => (
                  <div key={ord.id} className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                    <div className="flex items-center justify-between font-semibold">
                      <span>{ord.order_no}</span>
                      <span className="text-teal-800">
                        {fmtCurrency(ord.total, currency, locale)}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center justify-between">
                      <span>{ord.channel === 'delivery' ? '外卖配送' : '堂食'}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800">
                        {ord.rider_status || ord.status}
                      </span>
                    </div>
                    {ord.items && (
                      <div className="text-[11px] text-slate-600 pt-1 border-t border-slate-200/60">
                        {ord.items.map((it) => `${it.name} x${it.qty}`).join(', ')}
                      </div>
                    )}
                    {ord.channel === 'delivery' && (
                      <button
                        onClick={() => {
                          setSelectedTrackingOrder(ord);
                          setShowTrackingModal(true);
                          setShowOrdersModal(false);
                        }}
                        className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-xs transition"
                      >
                        <Navigation className="w-3.5 h-3.5" />
                        <span>查看配送状态</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={async () => {
                await customerApi.customerLogout();
                setCustomer(null);
                setShowOrdersModal(false);
              }}
              className="w-full py-2 bg-slate-100 text-rose-600 font-semibold rounded-xl text-xs hover:bg-slate-200 transition"
            >
              退出顾客账号
            </button>
          </div>
        </div>
      )}

      {/* DELIVERY TRACKER MODAL */}
      {showTrackingModal && selectedTrackingOrder && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-5 backdrop-blur-md overflow-y-auto"
          onClick={() => setShowTrackingModal(false)}
        >
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <DeliveryTrackerMap
              order={selectedTrackingOrder}
              onClose={() => setShowTrackingModal(false)}
              currency={currency}
              locale={locale}
            />
          </div>
        </div>
      )}

      {/* DISH DETAIL & CULINARY INTRO MODAL */}
      {dishPresence.mounted && selectedDish && (
        <DishDetailModal
          item={selectedDish}
          cartQty={cart[selectedDish.id] || 0}
          onUpdateCart={(delta, e) => updateQuantity(selectedDish.id, delta, e)}
          onClose={closeDish}
          visible={dishPresence.visible}
          // 菜单浏览模式（mode === 'menu'）不允许加购：原型这里没传 canOrder，
          // 默认 true，于是"只浏览菜单"的顾客也能把菜加进购物袋。
          canOrder={mode !== 'menu'}
          currency={currency}
          locale={locale}
        />
      )}

      {/* Phase 18：后厨巡检弹窗与后厨照片上传弹窗**故意不挂载**。
          合规横幅（Grade A / 1.8-2.3°C / 4 次全区巡查）是写死的字面量，上传者还能
          给自己发 verified —— 食品安全结论不能由前端编。组件文件仍保留在同目录
          （文件头写了前因后果），等后端真的有了「照片 + 独立审核」再接回来。 */}

      <nav className="rf-customer-bottom-nav" aria-label="顾客端主导航">
        <div>
          <button
            className={customerSection === 'home' ? 'is-active' : ''}
            onClick={() => setCustomerSection('home')}
          >
            <Home className="w-5 h-5" />
            <span>首页</span>
          </button>
          <button
            className={customerSection === 'explore' ? 'is-active' : ''}
            onClick={() => {
              if (mode === 'booking') handleModeSwitch('menu');
              else setCustomerSection('explore');
            }}
          >
            <Search className="w-5 h-5" />
            <span>探索</span>
          </button>
          <button
            className="rf-customer-cart-tab"
            onClick={() => setShowCartDrawer(true)}
          >
            <span className="rf-customer-cart-icon">
              <ShoppingBag className="w-5 h-5" />
              {totalItemCount > 0 && <b>{totalItemCount}</b>}
            </span>
            <span>购物车</span>
          </button>
          <button onClick={handleOpenOrders}>
            <ReceiptText className="w-5 h-5" />
            <span>订单</span>
          </button>
          <button onClick={() => customer ? handleOpenOrders() : setShowAuthModal(true)}>
            <User className="w-5 h-5" />
            <span>我的</span>
          </button>
        </div>
      </nav>

      {/* Apple Fluid Flying Dish Overlay & Dynamic Island Toast */}
      <FlyingDishOverlay
        particles={flyingParticles}
        onParticleComplete={handleParticleComplete}
        activeToast={activeToast}
      />
    </div>
  );
};
