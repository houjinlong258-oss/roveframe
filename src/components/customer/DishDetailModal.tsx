'use client';

import React from 'react';
import {
  X,
  Sparkles,
  Wine,
  Flame,
  ShieldAlert,
  MapPin,
  Layers,
  CheckCircle2,
  Plus,
  Minus,
  UtensilsCrossed,
} from 'lucide-react';
import { MenuItem, Locale } from '@/types';
import { fmtCurrency } from '@/lib/format';
import { getTranslations } from '@/lib/i18n';
import { fadeClass, slideUpClass } from '@/components/pwa/presence';

interface DishDetailModalProps {
  item: MenuItem;
  onClose: () => void;
  currency?: string;
  locale: Locale;
  cartQty: number;
  onUpdateCart: (delta: number, e?: React.MouseEvent) => void;
  /**
   * 是否允许加购。**默认 false（fail-closed）**。
   *
   * 原型默认 true，而 `CustomerPwa` 根本没传这个 prop —— 于是"浏览菜单"
   * （mode === 'menu'）的顾客照样能把菜加进购物袋。少一个按钮是可恢复的，
   * 让顾客在只看不点的模式下下单是不可恢复的，所以默认值反过来。
   */
  canOrder?: boolean;
  /**
   * 是否处于"可见"状态。退出动画的挂载保持由父层的 `usePresence` 负责，
   * 这里只把状态翻译成类名。不传 = 一直可见（独立使用时的语义）。
   */
  visible?: boolean;
}

export const DishDetailModal: React.FC<DishDetailModalProps> = ({
  item,
  onClose,
  currency = 'USD',
  locale,
  cartQty,
  onUpdateCart,
  canOrder = false,
  visible = true,
}) => {
  const t = getTranslations(locale);

  return (
    <div
      id="dish-detail-backdrop"
      // 遮罩：200ms 淡入淡出（与 presence.tsx 的 fadeClass 时长一致）。
      className={`fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto ${fadeClass(visible)}`}
      onClick={onClose}
    >
      <div
        id="dish-detail-sheet"
        // 面板：从下方 100% 滑入（原型的 motion `y: '100%' → 0`）。
        // 原型用的是弹簧，CSS 给不了弹簧的过冲，250ms 的 ease-out 是它的
        // 单调近似 —— 观感差异在 250ms 内不可分辨。
        className={`w-full max-w-lg bg-[#1C1C1E] text-stone-100 rounded-t-[28px] sm:rounded-[28px] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col relative border-t sm:border border-white/10 ${slideUpClass(visible)}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* iOS Grabber */}
        <div className="w-full flex justify-center pt-2.5 pb-1 sm:hidden">
          <div className="w-9 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header Hero Image */}
        <div className="relative w-full h-60 sm:h-64 bg-stone-950 shrink-0 overflow-hidden">
          <img
            src={item.image_url}
            alt={item.name}
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#1C1C1E] via-black/30 to-black/20" />

          {/* Close Button */}
          <button
            onClick={onClose}
            id="close-dish-detail-btn"
            className="absolute top-3.5 right-3.5 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Tags */}
          <div className="absolute top-3.5 left-3.5 flex flex-wrap gap-1.5">
            <span className="px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-xs text-white text-[11px] font-medium border border-white/20 flex items-center gap-1">
              <UtensilsCrossed className="w-3 h-3 text-stone-300" />
              <span>{item.cuisine_type || '精致料理'}</span>
            </span>
            {item.chef_badge && (
              <span className="px-2 py-0.5 rounded-full bg-amber-400 text-stone-950 text-[11px] font-bold">
                {item.chef_badge}
              </span>
            )}
          </div>

          {/* Title & Price */}
          <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="font-bold text-xl sm:text-2xl text-white tracking-tight">
                {item.name}
              </h2>
              <div className="flex items-center gap-2 text-xs text-stone-400 mt-0.5">
                <span>{item.category}</span>
                {item.calories && (
                  <span className="flex items-center gap-1 text-stone-400">
                    <Flame className="w-3 h-3 text-amber-400" />
                    <span>约 {item.calories} kcal</span>
                  </span>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-white font-bold font-mono text-2xl">
                {fmtCurrency(item.price, currency, locale)}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3 text-xs leading-relaxed">
          {/* Story */}
          <div className="bg-[#2C2C2E] rounded-2xl p-3.5 space-y-1.5 border border-white/5">
            <div className="flex items-center gap-1.5 text-amber-400 font-semibold text-[11px] uppercase tracking-wider">
              <Sparkles className="w-3 h-3" />
              <span>主厨灵感手记</span>
            </div>
            <p className="text-stone-300 text-xs sm:text-sm leading-relaxed">
              {item.story || item.description}
            </p>
          </div>

          {/* Grid: Craft & Origin */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="bg-[#2C2C2E] rounded-2xl p-3 space-y-1 border border-white/5">
              <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[11px] uppercase tracking-wider">
                <Layers className="w-3 h-3" />
                <span>烹饪工艺</span>
              </div>
              <p className="text-stone-300">{item.culinary_craft || '主厨当日现烹'}</p>
            </div>

            <div className="bg-[#2C2C2E] rounded-2xl p-3 space-y-1 border border-white/5">
              <div className="flex items-center gap-1.5 text-sky-400 font-semibold text-[11px] uppercase tracking-wider">
                <MapPin className="w-3 h-3" />
                <span>核心原料产地</span>
              </div>
              <p className="text-stone-300">{item.provenance?.join('、') || '每日冷链鲜配'}</p>
            </div>
          </div>

          {/* Pairing */}
          {item.pairing_recommendation && (
            <div className="bg-[#2C2C2E] rounded-2xl p-3 space-y-1 border border-white/5">
              <div className="flex items-center gap-1.5 text-purple-400 font-semibold text-[11px] uppercase tracking-wider">
                <Wine className="w-3 h-3" />
                <span>侍酒师佐饮推荐</span>
              </div>
              <p className="text-stone-300">{item.pairing_recommendation}</p>
            </div>
          )}

          {/* Allergens */}
          {item.allergens && item.allergens.length > 0 && (
            <div className="bg-[#2C2C2E] rounded-2xl p-3 flex items-start gap-2 text-stone-400 border border-white/5">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-[11px]">
                <span className="font-semibold text-stone-300">过敏原提示：</span>
                <span>包含 {item.allergens.join('、')}。如有忌口请在结账前注明。</span>
              </div>
            </div>
          )}
        </div>

        {/* Action Footer */}
        {canOrder && (
          <div className="p-3.5 bg-[#141416] border-t border-white/10 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => onUpdateCart(-1, e)}
                disabled={cartQty <= 0}
                className="w-8 h-8 rounded-full bg-[#2C2C2E] text-white hover:bg-stone-700 disabled:opacity-30 flex items-center justify-center transition active:scale-90"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <span className="w-6 text-center font-mono font-bold text-sm text-white">
                {cartQty}
              </span>
              <button
                onClick={(e) => onUpdateCart(1, e)}
                className="w-8 h-8 rounded-full bg-white text-black hover:bg-stone-200 flex items-center justify-center transition shadow-sm active:scale-90"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>

            <button
              onClick={(e) => {
                if (cartQty === 0) {
                  onUpdateCart(1, e);
                }
                onClose();
              }}
              className="flex-1 py-3 px-5 rounded-full bg-white text-[#1D1D1F] font-bold text-xs sm:text-sm hover:bg-stone-100 transition flex items-center justify-center gap-2 active:scale-98"
              id="dish-add-to-cart-action-btn"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{cartQty > 0 ? `已选 ${cartQty} 份 · 完成` : '加入选购袋'}</span>
            </button>
          </div>
        )}

        {/* 不可加购时的说明条：不留一个"什么都没有"的死角，也不给假按钮。 */}
        {!canOrder && (
          <div className="p-3.5 bg-[#141416] border-t border-white/10 flex items-center justify-center gap-1.5 text-[11px] text-stone-400 shrink-0">
            <UtensilsCrossed className="w-3.5 h-3.5" />
            <span>{t.store.menu_only}</span>
          </div>
        )}
      </div>
    </div>
  );
};
