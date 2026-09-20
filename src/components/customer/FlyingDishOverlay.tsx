'use client';

import React from 'react';
import { Check } from 'lucide-react';
import { usePresence } from '@/components/pwa/presence';

/** 粒子样式：除常规 CSS 之外还带四个自定义属性（关键帧的位移增量）。 */
type FlyParticleStyle = React.CSSProperties &
  Record<'--rf-fly-mid-x' | '--rf-fly-mid-y' | '--rf-fly-end-x' | '--rf-fly-end-y', string>;

export interface FlyingDishParticle {
  id: string;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  imageUrl: string;
  name: string;
}

interface FlyingDishOverlayProps {
  particles: FlyingDishParticle[];
  onParticleComplete: (id: string) => void;
  activeToast: { name: string; imageUrl?: string; price?: string } | null;
}

export const FlyingDishOverlay: React.FC<FlyingDishOverlayProps> = ({
  particles,
  onParticleComplete,
  activeToast,
}) => {
  // 原型的 `AnimatePresence` 只做一件事：**延迟卸载**。退出动画播完之前
  // 元素还留在 DOM 里，React 自己没有这个能力，所以用 usePresence 把
  // "是否渲染"与"是否可见"拆成两个状态。240ms 与下面 transition 的时长一致。
  const toastPresence = usePresence(activeToast !== null, 240);

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {/* 1. APPLE DYNAMIC ISLAND HEADER NOTIFICATION */}
      {toastPresence.mounted && activeToast && (
        <div
          // key 跟着餐名走：连着加两道菜时让节点重建、动画重播，
          // 与原型 `key={activeToast.name}` 的行为一致。
          key={activeToast.name}
          // 进场 -20px/0.94 与出场 -16px/0.96 合并成同一个隐藏态：
          // 两帧之间 4px、0.02 的差别肉眼不可分辨，而分两个状态要额外记录
          // "是否显示过"，不值得。
          className={`fixed top-0 left-1/2 z-50 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#1D1D1F]/95 text-white shadow-xl border border-white/15 backdrop-blur-md transition-all duration-[240ms] ease-out ${toastPresence.visible
              ? '-translate-x-1/2 translate-y-3.5 opacity-100 scale-100'
              : '-translate-x-1/2 -translate-y-5 opacity-0 scale-[.94]'
          }`}
        >
            {activeToast.imageUrl ? (
              <img
                src={activeToast.imageUrl}
                alt=""
                className="w-5 h-5 rounded-full object-cover border border-white/30"
              />
            ) : (
              <div className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                <Check className="w-2.5 h-2.5 stroke-[3]" />
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs font-normal tracking-tight">
              <span className="text-stone-300">已加入</span>
              <span className="font-semibold text-white max-w-[130px] truncate">
                {activeToast.name}
              </span>
              {activeToast.price && (
                <span className="text-stone-400 font-mono text-[11px]">
                  {activeToast.price}
                </span>
              )}
            </div>
        </div>
      )}

      {/* 2. SNAPPY FLUID FLYING DISH BUBBLE (HARDWARE ACCELERATED) */}
      {particles.map((p) => {
        const midX = (p.startX + p.targetX) / 2 + (p.startX > p.targetX ? -30 : 30);
        const midY = Math.min(p.startY, p.targetY) - 60;

        // 原型的轨迹是一条 motion 关键帧数组，
        // `x: [起点, 中段, 终点]` + `times: [0, 0.45, 1]` + Apple 缓动曲线。
        // 零新增依赖的前提下用 `@keyframes rf-fly-dish` 复刻（见 src/app/pwa-tier.css）：
        // 起点写在 left/top 上，三个关键帧各自的位移增量用 CSS 变量注入。
        // 增量是相对**起点盒子**算的，所以要先把绝对坐标做一次减法。
        const originX = p.startX - 18;
        const originY = p.startY - 18;
        const style: FlyParticleStyle = {
          left: `${originX}px`,
          top: `${originY}px`,
          '--rf-fly-mid-x': `${midX - originX}px`,
          '--rf-fly-mid-y': `${midY - originY}px`,
          '--rf-fly-end-x': `${p.targetX - 14 - originX}px`,
          '--rf-fly-end-y': `${p.targetY - 14 - originY}px`,
        };

        return (
          <div
            key={p.id}
            // 原型用 motion 的 onAnimationComplete 回收粒子；CSS 动画的等价物是
            // animationend，时长同样是 0.44s。
            onAnimationEnd={() => onParticleComplete(p.id)}
            className="rf-fly-dish absolute top-0 left-0 w-9 h-9 rounded-full overflow-hidden shadow-lg border border-white/80 bg-stone-900 pointer-events-none"
            style={style}
          >
            <img
              src={p.imageUrl}
              alt=""
              className="w-full h-full object-cover"
            />
          </div>
        );
      })}
    </div>
  );
};
