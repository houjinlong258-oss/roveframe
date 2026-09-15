'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowUp, FileSpreadsheet, Link2, ListPlus, Paperclip, Plus, Square, Upload, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtBytes } from '@/lib/format';
import type { ArtifactRecord } from '@/lib/artifacts/store';
import type { ReasoningLevel } from '@/lib/ai/reasoning';
import { ModelSelector, type RegistryPayload } from '@/components/agent/model-selector';
import { ReasoningSelector } from '@/components/agent/reasoning-selector';

/** 与 `/api/artifacts` POST 的扩展名白名单保持一致 */
const ACCEPT =
  '.csv,.tsv,.xlsx,.xls,.docx,.doc,.pdf,.txt,.md,.json,.html,.zip,.png,.jpg,.jpeg,.webp,.gif';

export interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string) => void;
  streaming: boolean;
  onStop: () => void;
  registry: RegistryPayload | null;
  modelValue: string | null;
  onModelChange: (next: string | null) => void;
  reasoning: ReasoningLevel;
  onReasoningChange: (next: ReasoningLevel) => void;
  agentDefaultReasoning?: ReasoningLevel;
  attachments: ArtifactRecord[];
  uploading: boolean;
  onUploadFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  placeholder: string;
  disabled?: boolean;
}

/**
 * Enterprise AI Agent Composer —— 输入框即「任务发射台」。
 *
 * 左侧 `+` 菜单（上传资料 / 生成报告 / 建任务 / 连接数据）、
 * 底部 Model Selector + Reasoning Selector、右上发送，
 * 支持拖拽上传并把附件变成可移除的 chip。
 */
export function Composer({
  value, onChange, onSend, streaming, onStop,
  registry, modelValue, onModelChange,
  reasoning, onReasoningChange, agentDefaultReasoning,
  attachments, uploading, onUploadFiles, onRemoveAttachment,
  placeholder, disabled,
}: ComposerProps) {
  const t = useTranslations('agent.composer');
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onUploadFiles(Array.from(list).slice(0, 5));
    },
    [onUploadFiles],
  );

  const canSend = value.trim().length > 0 && !streaming && !disabled;

  return (
    <div
      className={cn(
        'rounded-2xl border bg-card transition-colors',
        dragging ? 'border-primary shadow-glow' : 'border-border/60 shadow-card',
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        handleFiles(event.dataTransfer?.files ?? null);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((file) => (
            <span
              key={file.id}
              className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-border/60 bg-muted px-2 py-1 text-[11px]"
            >
              <FileSpreadsheet className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{file.name}</span>
              <span className="shrink-0 text-muted-foreground">{fmtBytes(file.size)}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(file.id)}
                className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label={t('removeAttachment')}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {t('uploading')}
            </span>
          )}
        </div>
      )}

      <textarea
        rows={attachments.length > 0 ? 2 : 3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (canSend) onSend(value);
          }
        }}
        placeholder={dragging ? t('dropHere') : placeholder}
        className="w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
      />

      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={t('menu')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-3.5 w-3.5" />
              {t('menuUpload')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSend(t('menuReportPrompt'))}>
              <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
              {t('menuReport')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSend(t('menuTaskPrompt'))}>
              <ListPlus className="mr-2 h-3.5 w-3.5" />
              {t('menuTask')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSend(t('menuConnectPrompt'))}>
              <Link2 className="mr-2 h-3.5 w-3.5" />
              {t('menuConnect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          aria-label={t('attach')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>

        <span className="ml-auto flex items-center gap-2">
          <ModelSelector
            registry={registry}
            value={modelValue}
            onChange={onModelChange}
            disabled={disabled || streaming}
          />
          <ReasoningSelector
            value={reasoning}
            onChange={onReasoningChange}
            disabled={disabled || streaming}
            agentDefault={agentDefaultReasoning}
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium transition-colors hover:bg-muted/70"
            >
              <Square className="h-3 w-3" />
              {t('stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSend(value)}
              disabled={!canSend}
              aria-label={t('send')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
