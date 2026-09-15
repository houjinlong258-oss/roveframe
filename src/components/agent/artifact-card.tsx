'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Download, FileCode2, FileJson, FileSpreadsheet, FileText,
  FileType2, Globe, Loader2, Presentation, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtBytes } from '@/lib/format';
import type { ArtifactRecord } from '@/lib/artifacts/store';

const ICONS: Record<string, typeof FileText> = {
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  docx: FileType2,
  doc: FileType2,
  pptx: Presentation,
  ppt: Presentation,
  md: FileCode2,
  txt: FileText,
  json: FileJson,
  html: Globe,
  pdf: FileType2,
};

/** 可在浏览器内预览的格式（图片/HTML 直出，其余由服务端抽取成文本） */
const PREVIEWABLE: ReadonlySet<string> = new Set([
  'html', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf',
  'csv', 'tsv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'md', 'txt', 'json',
]);

export function artifactIcon(format: string) {
  return ICONS[format.toLowerCase()] ?? FileText;
}

interface PreviewState {
  loading: boolean;
  kind?: 'image' | 'html' | 'text' | 'unsupported';
  text?: string;
  url?: string | null;
  message?: string;
  warning?: string | null;
}

/**
 * Artifact 卡片 —— Agent 产出的可下载文件，**并支持在聊天里直接预览**。
 *
 * 预览走 `/api/artifacts/{id}/preview`：xlsx/docx/pdf/pptx 由服务端的零依赖
 * 抽取器转成文本，图片直接显示签名 URL，HTML 放沙箱 iframe ——
 * 不往页面里注入任何第三方标记（sandbox="" 即完全隔离）。
 */
export function ArtifactCard({
  artifact,
  pending,
  className,
}: {
  artifact: ArtifactRecord;
  /** 服务端刚刚生成、URL 还在签发中 */
  pending?: boolean;
  className?: string;
}) {
  const t = useTranslations('agent.artifact');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const Icon = artifactIcon(artifact.format);
  const canPreview = PREVIEWABLE.has(artifact.format.toLowerCase());
  const href = `/api/artifacts/${artifact.id}/download`;

  const togglePreview = async () => {
    if (preview) {
      setPreview(null);
      return;
    }
    setPreview({ loading: true });
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/preview`);
      if (!response.ok) {
        setPreview({ loading: false, kind: 'unsupported', message: `HTTP ${response.status}` });
        return;
      }
      const data = (await response.json()) as PreviewState;
      setPreview({ ...data, loading: false });
    } catch (error) {
      setPreview({
        loading: false,
        kind: 'unsupported',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/60 bg-card shadow-card transition-colors hover:border-primary/40',
        className,
      )}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-4 w-4 text-foreground/70" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{artifact.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            {artifact.format.toUpperCase()} · {fmtBytes(artifact.size)}
            {artifact.source === 'user' ? ` · ${t('uploaded')}` : ` · ${t('generated')}`}
          </span>
        </span>
        {pending ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            {canPreview && (
              <button
                type="button"
                onClick={() => void togglePreview()}
                title={preview ? t('closePreview') : t('preview')}
                className={cn(
                  'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  preview && 'bg-muted text-foreground',
                )}
              >
                {preview ? <X className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
              </button>
            )}
            <a
              href={href}
              title={t('download')}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          </span>
        )}
      </div>

      {preview && (
        <div className="border-t border-border/50 bg-muted/30">
          {preview.loading && (
            <p className="flex items-center gap-2 px-3.5 py-3 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('loadingPreview')}
            </p>
          )}

          {!preview.loading && preview.kind === 'image' && preview.url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview.url}
              alt={artifact.name}
              className="max-h-[420px] w-full bg-background object-contain"
            />
          )}

          {!preview.loading && preview.kind === 'html' && preview.url && (
            <iframe
              src={preview.url}
              title={artifact.name}
              sandbox=""
              className="h-[420px] w-full bg-white"
            />
          )}

          {!preview.loading && preview.kind === 'text' && (
            <>
              {preview.warning && (
                <p className="px-3.5 pt-2 text-[10px] text-warning">{preview.warning}</p>
              )}
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground/85">
                {preview.text?.trim() ? preview.text : t('emptyPreview')}
              </pre>
            </>
          )}

          {!preview.loading && preview.kind === 'unsupported' && (
            <p className="px-3.5 py-3 text-[11px] text-muted-foreground">
              {preview.message ?? t('noPreview')}
            </p>
          )}

          {!preview.loading && (
            <p className="border-t border-border/40 px-3.5 py-2 text-[10px] text-muted-foreground">
              {t('previewNote')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
