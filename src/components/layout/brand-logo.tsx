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

  const sizeClasses = {
    sm: 'text-sm font-extrabold tracking-widest gap-1',
    md: 'text-lg font-black tracking-widest gap-1.5',
    lg: 'text-2xl font-black tracking-widest gap-2',
  };

  const slashSizes = {
    sm: 'text-base font-black',
    md: 'text-xl font-black',
    lg: 'text-3xl font-black',
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
  return (
    <div className={cn('inline-flex items-center select-none font-sans uppercase', sizeClasses[size], className)}>
      <span className={cn('font-extrabold tracking-widest', textColor)}>ROVE</span>
      <span className={cn('text-[#A7FF00] font-black transform skew-x-[-12deg]', slashSizes[size])}>
        /
      </span>
      <span className={cn('font-extrabold tracking-widest', textColor)}>
        FR<span className="inline-block transform -translate-y-[0.5px]">A</span>ME
      </span>
    </div>
  );
}
