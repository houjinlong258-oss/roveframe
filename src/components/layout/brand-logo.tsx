'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export interface RoveFrameLogoProps {
  variant?: 'primary' | 'secondary' | 'monogram';
  size?: 'sm' | 'md' | 'lg';
  darkMode?: boolean;
  className?: string;
}

export function RoveFrameLogo({
  variant = 'primary',
  size = 'md',
  darkMode = false,
  className = '',
}: RoveFrameLogoProps) {
  const textColor = darkMode ? 'text-[#F7F5F0]' : 'text-[#0D0D0D]';

  //: 品牌字标（primary）的高度。原图 1200x122（比例 9.84:1），宽度自适应。
  //: PNG 已紧贴字形裁切，所以高度就等于大写字母高度 —— 这组值直接决定视觉大小。
  const wordmarkHeights = {
    sm: 'h-3.5',
    md: 'h-4',
    lg: 'h-6',
  };

  if (variant === 'monogram') {
    return (
      <div className={cn('inline-flex items-center gap-1.5 select-none', className)}>
        {/* Acid Green Slash */}
        <span className="text-[#A7FF00] font-black text-xl leading-none">/</span>
        {/* Monogram RF */}
        <span className={cn('font-black tracking-tight text-lg font-sans', textColor)}>
          RF
        </span>
      </div>
    );
  }

  if (variant === 'secondary') {
    return (
      <div className={cn('inline-flex flex-col select-none font-sans uppercase leading-tight', className)}>
        <div className="flex items-center font-black tracking-widest text-base">
          <span className={textColor}>ROVE</span>
          <span className="text-[#A7FF00] font-black ml-1">/</span>
        </div>
        <div className={cn('font-black tracking-widest text-base', textColor)}>
          FRAME
        </div>
      </div>
    );
  }

  // Primary Horizontal Logo: ROVE / FRAME
  //
  // 这里用**设计好的字形位图**，而不是用字体拼字。原因：ROVE/FRAME 是一套定制的
  // 几何字形（分离式 R 腿、尖顶 A、方形 E），系统字体复刻不出来 —— 早前用
  // font-black + tracking-widest 拼出来的版本与真实字标并不一致。
  //
  // 两版位图只差**字色**（浅色主题黑字 / 深色主题近白字），酸绿斜杠两版一致。
  // 用 `dark:` 变体切换而不是透传 darkMode：`@custom-variant dark (&:is(.dark *))`
  // 已是 class 驱动，于是在落地页、顶栏、侧栏任何位置都自动正确，调用点不必
  // 再把主题状态传进来。同一时刻只有一版参与布局（另一版 display:none），
  // 两版都带 alt，因此任何主题下都有可访问名称。
  return (
    <span className={cn('inline-flex items-center select-none', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 静态品牌字标，无需 next/image 的优化管线 */}
      <img
        src="/brand/roveframe-wordmark-light.png"
        alt="RoveFrame"
        width={1200}
        height={122}
        className={cn('w-auto dark:hidden', wordmarkHeights[size])}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- 同上，深色主题版本 */}
      <img
        src="/brand/roveframe-wordmark-dark.png"
        alt="RoveFrame"
        width={1200}
        height={122}
        className={cn('hidden w-auto dark:block', wordmarkHeights[size])}
      />
    </span>
  );
}
