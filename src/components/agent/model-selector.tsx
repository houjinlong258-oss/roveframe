'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, ChevronDown, Code2, Cpu, Eye, Search, Sparkles, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ModelHealth, ModelRegistry, ModelStrength, RegistryModel, RegistryProvider,
} from '@/lib/ai/model-registry';

export type RegistryPayload = ModelRegistry & {
  reasoningLevels: Array<{ level: string; label: string; description: string }>;
};

const HEALTH_DOT: Record<ModelHealth, string> = {
  online: 'bg-success',
  slow: 'bg-warning',
  degraded: 'bg-warning',
  error: 'bg-destructive',
  offline: 'bg-muted-foreground/35',
  unknown: 'bg-muted-foreground/60',
};

/** 平台内置模型（永远可用的兜底项）的虚拟 provider id */
export const PLATFORM_OPTION = 'platform';

export function healthDotClass(health: ModelHealth): string {
  return HEALTH_DOT[health] ?? HEALTH_DOT.unknown;
}

export function healthKey(health: ModelHealth): string {
  return `health.${health}`;
}

const TIER_ICON: Record<string, typeof Zap> = {
  high: Sparkles,
  medium: Cpu,
  low: Zap,
};

/** 分组顺序与图标：按「用途」而不是按厂商排，老板才知道该选哪个 */
const STRENGTH_ORDER: ModelStrength[] = ['reasoning', 'coding', 'vision', 'fast', 'general'];
const STRENGTH_ICON: Record<ModelStrength, typeof Cpu> = {
  reasoning: Sparkles,
  coding: Code2,
  vision: Eye,
  fast: Zap,
  general: Cpu,
};

/**
 * Model Selector —— 显示**当前实际连接成功的**模型，而不是写死的名字。
 *
 * 数据全部来自 `/api/ai/models`（真实连接测试 + 真实调用账本）。
 * 未接入的服务商标为 offline 且不可选；平台内置兜底永远可选。
 */
export function ModelSelector({
  registry,
  value,
  onChange,
  disabled,
  className,
}: {
  registry: RegistryPayload | null;
  /** "provider:model"；null 表示沿用服务端分配 */
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('agent.composer');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const configured = useMemo(
    () => (registry?.providers ?? []).filter((provider) => provider.configured),
    [registry],
  );

  const current = useMemo(() => {
    if (!value || value === PLATFORM_OPTION) {
      const fallback = registry?.platformFallback;
      return {
        label: fallback ? `${fallback.label}` : t('platformModel'),
        sub: t('platformProvider'),
        health: 'unknown' as ModelHealth,
        isPlatform: true,
      };
    }
    const [providerId, ...rest] = value.split(':');
    const model = rest.join(':');
    const provider = registry?.providers.find((item) => item.id === providerId);
    return {
      label: model || provider?.displayName || providerId,
      sub: provider?.displayName ?? providerId,
      health: provider?.health ?? ('unknown' as ModelHealth),
      isPlatform: false,
    };
  }, [value, registry, t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return configured;
    return configured
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) ||
            provider.displayName.toLowerCase().includes(needle),
        ),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [configured, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors',
            'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', healthDotClass(current.health))} />
          <span className="max-w-[160px] truncate">{current.label}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border/60 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('availableModels')}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchModels')}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {/* 平台内置兜底 */}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
          >
            <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', HEALTH_DOT.unknown)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {registry?.platformFallback.model ?? t('platformModel')}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {t('platformProvider')} · {t('autoFallback')}
              </span>
            </span>
            {!value && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
          </button>

          {configured.length === 0 && (
            <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
              {t('noProviders')}
            </p>
          )}

          {filtered.map((provider) => (
            <ProviderGroup
              key={provider.id}
              provider={provider}
              currentValue={value}
              onPick={(next) => {
                onChange(next);
                setOpen(false);
              }}
            />
          ))}
        </div>

        <div className="border-t border-border/60 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
          {t('healthLegend')}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 一家服务商下的模型，**按用途分组**，并且只把可对话的模型做成可选项。
 *
 * 这是修一个真实故障：`agnes-image-2.0-flash` 之前和聊天模型混在一起，
 * 用户选中它当聊天模型 → 每次请求 400 → 白触发一次故障切换。
 * 图像/视频/语音/向量模型现在单列并明确标注不可对话。
 */
function ProviderGroup({
  provider,
  currentValue,
  onPick,
}: {
  provider: RegistryProvider;
  currentValue: string | null;
  onPick: (next: string | null) => void;
}) {
  const t = useTranslations('agent.composer');
  const chatModels = provider.models.filter((model) => model.capability === 'chat');
  const otherModels = provider.models.filter((model) => model.capability !== 'chat');

  const grouped = STRENGTH_ORDER
    .map((strength) => ({
      strength,
      models: chatModels.filter((model) => model.strength === strength),
    }))
    .filter((group) => group.models.length > 0);

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', healthDotClass(provider.health))} />
          {provider.displayName}
        </span>
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {provider.latencyMs != null && <span>{provider.latencyMs}ms</span>}
          <span>{t(healthKey(provider.health))}</span>
        </span>
      </div>

      {grouped.map((group) => {
        const GroupIcon = STRENGTH_ICON[group.strength];
        return (
          <div key={group.strength} className="mt-0.5">
            <p className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground/80">
              <GroupIcon className="h-3 w-3" />
              {t(`strength.${group.strength}`)}
            </p>
            {group.models.map((model) => (
              <ModelRow
                key={model.id}
                provider={provider}
                model={model}
                currentValue={currentValue}
                onPick={onPick}
              />
            ))}
          </div>
        );
      })}

      {otherModels.length > 0 && (
        <div className="mt-1 border-t border-border/40 pt-1">
          <p className="px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground/60">
            {t('notForChat')}
          </p>
          {otherModels.map((model) => (
            <p
              key={model.id}
              className="flex items-center gap-2 px-2 py-1 text-[10px] text-muted-foreground/70"
              title={t('notForChatHint')}
            >
              <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className="truncate">{model.id}</span>
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5">
                {t(`capability.${model.capability}` as 'capability.image')}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelRow({
  provider,
  model,
  currentValue,
  onPick,
}: {
  provider: RegistryProvider;
  model: RegistryModel;
  currentValue: string | null;
  onPick: (next: string | null) => void;
}) {
  const t = useTranslations('agent.composer');
  const id = `${provider.id}:${model.id}`;
  const TierIcon = TIER_ICON[model.tier] ?? Cpu;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
    >
      <TierIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{model.id}</span>
        <span className="block text-[10px] text-muted-foreground">
          {t(`tier.${model.tier}`)}
          {model.reasoning ? ` · ${t('reasoningCapable')}` : ''}
          {model.vision ? ` · ${t('visionCapable')}` : ''}
        </span>
      </span>
      {currentValue === id && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
    </button>
  );
}
