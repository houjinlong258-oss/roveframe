'use client';

import React from 'react';
import { CheckCircle2, Circle, MapPin, Phone, Receipt, X } from 'lucide-react';
import type { CustomerOrderSummary, Locale } from '@/types';
import { fmtCurrency, fmtDateTime } from '@/lib/format';
import { getTranslations } from '@/lib/i18n';

/**
 * 配送状态追踪（替换原型里的 `DeliveryTrackerMap`）。
 *
 * ## 为什么不是地图
 *
 * 原型的组件（_pwa-review/src/components/delivery/DeliveryTrackerMap.tsx）是
 * 17KB 的 Google Maps 封装 + **伪造的 GPS**：
 *
 *   · 一个每 2 秒触发一次的定时器把 `simProgress` 加 1.2，让地图上的骑手标记
 *     自己往前走；
 *   · 骑手档案整段写死（姓名、头像、评分 4.96、车型、车牌），还有车载遥测：
 *     电池 84%、体温 36.4°C、时速 24 km/h、"已通过实名健康认证"；
 *   · 距离与 ETA 由那个假的 `simProgress` 反推出来（"剩余 1.2 km / 预计 11 分钟"）。
 *
 * （本文件特意不出现定时器 API 与地图 SDK 的字面量，`tests/pwa-tier.test.ts`
 *   对这两个字符串做的是**原文**匹配，注释里写出来也会被判为回归。）
 *
 * 后端没有任何一项的数据源：`src/lib/api.ts` 的 `toDeliveryItem` 明确不返回
 * `rider` / `coordinates`，注释里写着"原型里它们是写死的演示数据，填上去等于让
 * 员工看到假的实时位置"。顾客端同理：把"骑手体温 36.4°C 正常"渲染给食客，等于
 * 让顾客以为自己在看一份健康监测数据。
 *
 * ## 这个组件显示什么
 *
 * 只显示订单记录里真实存在的字段：配送状态四步时间线
 * （unclaimed → claimed → picked_up → delivered）、承诺送达时间 `promised_at`、
 * 收餐地址、餐品明细与总额。没有骑手就直说没有；没有承诺时间就说没有。
 * 不做模拟位移、不猜 ETA、不编遥测。
 *
 * 导出名沿用 `DeliveryTrackerMap`，这样 `CustomerPwa` 除了 import 路径之外不用改。
 */

interface DeliveryTrackerProps {
  order: CustomerOrderSummary;
  onClose?: () => void;
  /** 币种取自站点配置/菜单；拿不到时由 fmtCurrency 回落 USD。 */
  currency?: string;
  locale: Locale;
}

/** 配送状态的四步。顺序即业务流程顺序，不要按字母重排。 */
const STEPS = ['unclaimed', 'claimed', 'picked_up', 'delivered'] as const;
type DeliveryStep = (typeof STEPS)[number];

type DeliveryDict = ReturnType<typeof getTranslations>['delivery'];

const STEP_LABEL: Record<DeliveryStep, keyof DeliveryDict> = {
  unclaimed: 'status_pending',
  claimed: 'status_claimed',
  picked_up: 'status_picked_up',
  delivered: 'status_delivered',
};

export const DeliveryTrackerMap: React.FC<DeliveryTrackerProps> = ({
  order,
  onClose,
  currency,
  locale,
}) => {
  const t = getTranslations(locale);
  // 后端偶发不返回 rider_status（老单/非外卖单）。缺值时按"还没骑手"处理，
  // 而不是假装进行中。
  const current: DeliveryStep = order.rider_status ?? 'unclaimed';
  const currentIndex = STEPS.indexOf(current);
  const items = order.items ?? [];

  return (
    <div
      id={`delivery-tracker-${order.id}`}
      className="rf-delivery-tracker bg-stone-900 border border-stone-800 text-stone-100 rounded-3xl overflow-hidden shadow-2xl w-full"
    >
      {/* 头部：单号 + 关闭 */}
      <div className="bg-gradient-to-r from-emerald-950/90 via-stone-900 to-stone-900 px-5 py-4 border-b border-stone-800/80 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
            <Receipt className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-base text-white tracking-wide">配送状态</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-[11px] font-semibold border border-emerald-500/30">
                {order.order_no}
              </span>
            </div>
            {/* 承诺送达时间：后端给了就显示，没给就说没给（原型这里写死"预计 11 分钟"） */}
            <p className="text-xs text-stone-400 mt-0.5">
              {order.promised_at
                ? `${t.delivery.eta_prefix} ${fmtDateTime(order.promised_at, locale)}`
                : '商家未提供承诺送达时间'}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 hover:bg-stone-700 text-stone-300 hover:text-white flex items-center justify-center transition border border-stone-700/60"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 状态时间线 */}
      <div className="p-5 space-y-5">
        <ol className="space-y-0">
          {STEPS.map((step, index) => {
            const reached = index <= currentIndex;
            const isCurrent = index === currentIndex;
            return (
              <li key={step} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                      reached
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                        : 'bg-stone-800 text-stone-600 border border-stone-700'
                    }`}
                  >
                    {reached ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3 h-3" />}
                  </span>
                  {index < STEPS.length - 1 && (
                    <span
                      className={`w-px flex-1 min-h-[26px] ${
                        index < currentIndex ? 'bg-emerald-500/50' : 'bg-stone-800'
                      }`}
                    />
                  )}
                </div>
                <div className={index < STEPS.length - 1 ? 'pb-4' : ''}>
                  <div
                    className={`text-xs ${
                      isCurrent ? 'font-semibold text-white' : reached ? 'text-stone-200' : 'text-stone-500'
                    }`}
                  >
                    {t.delivery[STEP_LABEL[step]]}
                  </div>
                  {isCurrent && (
                    <div className="text-[11px] text-stone-500 mt-0.5">
                      {index === 0 ? '等待餐厅或骑手接单' : '当前状态'}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* 骑手：有就显示能联系到的人，没有就明说没有 */}
        <div className="bg-stone-800/60 border border-stone-700/70 rounded-2xl p-3.5 space-y-1.5">
          <div className="text-[11px] text-stone-400 font-semibold uppercase tracking-wider">
            {t.delivery.rider_info}
          </div>
          {current === 'unclaimed' ? (
            <p className="text-xs text-stone-300">尚未分配骑手，本单还在等待接单。</p>
          ) : order.rider?.name ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-white">{order.rider.name}</div>
                <div className="text-[11px] text-stone-400 mt-0.5">订单记录中的配送员</div>
              </div>
              {order.rider.phone && (
                <a
                  href={`tel:${order.rider.phone}`}
                  className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shrink-0"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>{t.delivery.contact_rider}</span>
                </a>
              )}
            </div>
          ) : (
            <p className="text-xs text-stone-300">
              订单已进入配送流程，但这条订单记录里没有骑手姓名与电话。
            </p>
          )}
        </div>

        {/* 收餐地址 */}
        <div className="bg-stone-800/60 border border-stone-700/70 rounded-2xl p-3.5 space-y-1">
          <div className="text-[11px] text-stone-400 font-semibold uppercase tracking-wider flex items-center gap-1.5">
            <MapPin className="w-3 h-3" />
            <span>{t.delivery.address_line}</span>
          </div>
          <p className="text-xs text-stone-200">{order.address_line || '订单未提供收餐地址'}</p>
          {order.address_note && <p className="text-[11px] text-stone-400">备注：{order.address_note}</p>}
          {(order.recipient_name || order.recipient_phone) && (
            <p className="text-[11px] text-stone-400">
              {t.delivery.recipient_name}: {order.recipient_name || '—'}
              {order.recipient_phone ? ` · ${order.recipient_phone}` : ''}
            </p>
          )}
        </div>

        {/* 餐品明细与总额 */}
        <div className="bg-stone-800/60 border border-stone-700/70 rounded-2xl p-3.5 space-y-2">
          <div className="text-[11px] text-stone-400 font-semibold uppercase tracking-wider">
            餐品明细（{items.length} 项）
          </div>
          {items.length === 0 ? (
            <p className="text-[11px] text-stone-400">订单记录里没有餐品明细。</p>
          ) : (
            <div className="space-y-1">
              {items.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex items-center justify-between text-[11px] text-stone-300"
                >
                  <span>
                    {item.name} × {item.qty}
                  </span>
                  <span className="font-mono text-stone-400">
                    {fmtCurrency(Number(item.price) * item.qty, currency, locale)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-stone-700/60">
            <span className="text-xs text-stone-400">支付总额</span>
            <span className="text-sm font-bold text-amber-400 font-mono">
              {fmtCurrency(order.total, currency, locale)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
