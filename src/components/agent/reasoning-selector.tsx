'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronDown, Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReasoningLevel } from '@/lib/ai/reasoning';

const LEVELS: ReasoningLevel[] = ['low', 'medium', 'high'];

/**
 * Reasoning Level Selector —— Composer 右侧的「思考强度」。
 *
 * 语义（服务端 `REASONING_LEVELS` 是唯一事实来源）：
 * low / medium / high 影响 max_tokens、temperature 与系统指令；
 * 只有明确支持的服务商才会收到原生的 reasoning_effort，避免 400 误触发故障切换。
 */
export function ReasoningSelector({
  value,
  onChange,
  disabled,
  agentDefault,
}: {
  value: ReasoningLevel;
  onChange: (next: ReasoningLevel) => void;
  disabled?: boolean;
  /** 该 AI 员工的默认档位（用户改了会显示 recommended 标记） */
  agentDefault?: ReasoningLevel;
}) {
  const t = useTranslations('agent.composer');
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors',
            'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <Gauge className="h-3 w-3 opacity-70" />
          <span>{t(`reasoning.${value}.label`)}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('reasoningTitle')}
        </p>
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => {
              onChange(level);
              setOpen(false);
            }}
            className={cn(
              'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-muted',
              value === level && 'bg-muted',
            )}
          >
            <span className="flex w-full items-center justify-between text-xs font-medium">
              {t(`reasoning.${level}.label`)}
              {agentDefault === level && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {t('recommended')}
                </span>
              )}
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              {t(`reasoning.${level}.description`)}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
