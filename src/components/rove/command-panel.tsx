'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * AI Business Command Center 主面板：
 * 问候 + "Your AI team has analyzed your business" + 核心信号 + 主建议入口。
 * 回答三个问题：AI 团队知道了什么 / 正在发生什么 / 下一步该做什么。
 */
export function CommandPanel({
  ownerName,
  greetingMorning,
  greetingAfternoon,
  greetingEvening,
  teamSummary,
  headline,
  children,
  className,
}: {
  ownerName: string;
  greetingMorning: string;
  greetingAfternoon: string;
  greetingEvening: string;
  teamSummary: string;
  headline?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  // 问候语依赖本地时间，仅客户端挂载后渲染（防 hydration 不一致）
  const [greeting, setGreeting] = useState(greetingMorning);
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? greetingMorning : h < 18 ? greetingAfternoon : greetingEvening);
  }, [greetingMorning, greetingAfternoon, greetingEvening]);

  return (
    <section
      className={cn(
        'rove-rise relative overflow-hidden rounded-3xl p-6 md:p-8 mb-6',
        'bg-[#0D0D0D] text-[#F7F5F0] shadow-float'
      )}
    >
      {/* 空间光晕：酸绿极光，呼应官网 hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-25 blur-3xl"
        style={{ background: 'radial-gradient(circle, #A7FF00 0%, transparent 65%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 left-1/3 w-80 h-80 rounded-full opacity-15 blur-3xl"
        style={{ background: 'radial-gradient(circle, #A7FF00 0%, transparent 60%)' }}
      />
      <div className="relative">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-widest uppercase opacity-80">
          <Sparkles className="w-3.5 h-3.5" />
          RoveFrame AI Command Center
        </div>
        <h1 className="mt-3 text-2xl md:text-[32px] leading-tight font-bold font-display tracking-tight">
          {greeting}, {ownerName}.
        </h1>
        <p className="mt-2 text-sm md:text-base opacity-85 max-w-2xl leading-relaxed">{teamSummary}</p>
        {headline && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-xs font-medium backdrop-blur-sm">
            {headline}
          </p>
        )}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </section>
  );
}
