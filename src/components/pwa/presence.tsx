'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 顶掉 `motion/react` 的两个能力：进出场动画的挂载管理，与简单的位移/淡入。
 *
 * ## 为什么不用 motion
 *
 * 原型里 motion 只用了 19 处（12 个 `AnimatePresence`、10 个 `motion.div/article`、
 * 1 个 `layoutId`），而项目规矩是**零新增依赖**。为一个"退出动画播完再卸载"
 * 引入一个动画库不划算 —— 那个能力本身就是下面这 30 行。
 *
 * ## AnimatePresence 到底做了什么
 *
 * 它不是"加动画"，而是"**延迟卸载**"：元素从树里消失后仍然存在于 DOM 里，
 * 直到退出动画播完。React 本身没有这个能力，所以需要把"是否还在渲染"
 * 与"是否可见"分成两个状态。
 *
 * 用法（与原来一一对应）：
 *
 *   const presence = usePresence(open, 220);
 *   if (!presence.mounted) return null;
 *   <div className={presence.visible ? 'opacity-100' : 'opacity-0'} />
 *
 * `durationMs` 必须与 CSS 的 transition-duration 一致，否则要么提前卸载
 * （动画被切断），要么留下一个不可见的空节点。
 */
export interface Presence {
  /** 是否应该渲染到 DOM 里 */
  mounted: boolean;
  /** 是否应该处于"可见"状态（下一帧才置真，否则浏览器不会播过渡） */
  visible: boolean;
}

export function usePresence(open: boolean, durationMs = 200): Presence {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (open) {
      setMounted(true);
      // 必须先挂载、再置可见，中间隔一帧。同一个 tick 里做两件事，
      // 浏览器只看到最终状态，不会有过渡 —— 动画会"跳"出来。
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }

    setVisible(false);
    // 退场期间保持挂载；到点才真正卸载。
    timer.current = setTimeout(() => setMounted(false), durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, durationMs]);

  return { mounted, visible };
}

/**
 * 常用过渡的类名。集中在这里，避免每个组件各自手写一串 duration/easing，
 * 那样迟早会出现三种不同的 200ms。
 */
export const TIER_TRANSITION = {
  /** 淡入淡出 */
  fade: 'transition-opacity duration-200 ease-out',
  /** 从下方滑入（抽屉、底部弹层） */
  slideUp: 'transition-all duration-250 ease-out',
  /** 缩放入场（对话框） */
  pop: 'transition-all duration-200 ease-out',
} as const;

/** 把一个"打开/关闭"状态翻译成淡入淡出的 className。 */
export function fadeClass(visible: boolean): string {
  return `${TIER_TRANSITION.fade} ${visible ? 'opacity-100' : 'opacity-0'}`;
}

/** 底部弹层/抽屉：关闭时下移 100%。 */
export function slideUpClass(visible: boolean): string {
  return `${TIER_TRANSITION.slideUp} ${visible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}`;
}

/** 对话框：关闭时略缩小并淡出。 */
export function popClass(visible: boolean): string {
  return `${TIER_TRANSITION.pop} ${visible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`;
}
