'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  Download, ExternalLink, FileText, Loader2, Search, Trash2, Upload,
} from 'lucide-react';
import { cn, safeFetchJson } from '@/lib/utils';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { artifactIcon } from '@/components/agent/artifact-card';
import type { ArtifactRecord } from '@/lib/artifacts/store';

type Filter = 'all' | 'agent' | 'user';
type Category = 'all' | 'reports' | 'spreadsheets' | 'presentations' | 'images' | 'documents' | 'data' | 'other';

const PREVIEWABLE: ReadonlySet<string> = new Set([
  'html', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf',
  'csv', 'tsv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'md', 'txt', 'json',
]);

/**
 * 文件中心分类：**按用途**分组，而不是把扩展名堆在一起。
 * 定位是「企业知识资产库 + 历史 Artifact 管理」——老板拿文件的主路径
 * 始终是聊天里的 Artifact 卡片，这里只是管理后台。
 */
const CATEGORY_FORMATS: Record<Exclude<Category, 'all' | 'other'>, ReadonlySet<string>> = {
  reports: new Set(['pdf', 'docx', 'doc', 'md']),
  spreadsheets: new Set(['xlsx', 'xls', 'csv', 'tsv']),
  presentations: new Set(['pptx', 'ppt']),
  images: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']),
  documents: new Set(['txt', 'html', 'htm']),
  data: new Set(['json', 'xml', 'yaml', 'yml', 'sql']),
};

const CATEGORY_ORDER: Category[] = [
  'all', 'reports', 'spreadsheets', 'presentations', 'images', 'documents', 'data', 'other',
];

function categoryOf(format: string): Exclude<Category, 'all'> {
  const ext = format.toLowerCase();
  for (const [key, formats] of Object.entries(CATEGORY_FORMATS)) {
    if (formats.has(ext)) return key as Exclude<Category, 'all'>;
  }
  return 'other';
}

/**
 * Workspace Files —— 文件中心。
 *
 * 与聊天里的 Artifact 卡片同源（同一个私有桶 + 同一份 manifest），
 * 所以 Agent 生成的报告、用户上传的资料、历史文件都在这一处管理。
 */
export default function FilesPage() {
  const t = useTranslations('files');
  const locale = useLocale();
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await safeFetchJson('/api/artifacts?limit=200');
    setArtifacts(Array.isArray(data?.artifacts) ? (data.artifacts as ArtifactRecord[]) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const list = artifacts ?? [];
    const needle = query.trim().toLowerCase();
    return list.filter((artifact) => {
      if (filter !== 'all' && artifact.source !== filter) return false;
      if (category !== 'all' && categoryOf(artifact.format) !== category) return false;
      if (!needle) return true;
      return artifact.name.toLowerCase().includes(needle);
    });
  }, [artifacts, filter, category, query]);

  /** 每个分类的计数（0 的分类不显示，避免空按钮堆积） */
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const artifact of artifacts ?? []) {
      const key = categoryOf(artifact.format);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      counts.set('all', (counts.get('all') ?? 0) + 1);
    }
    return counts;
  }, [artifacts]);

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const response = await fetch(`/api/artifacts/${id}`, { method: 'DELETE' });
        if (response.ok) setArtifacts((prev) => (prev ?? []).filter((item) => item.id !== id));
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(files).slice(0, 5)) {
          const form = new FormData();
          form.append('file', file);
          const response = await fetch('/api/artifacts', { method: 'POST', body: form });
          if (!response.ok) continue;
          const data = (await response.json()) as { artifact?: ArtifactRecord };
          if (data.artifact) setArtifacts((prev) => [data.artifact as ArtifactRecord, ...(prev ?? [])]);
        }
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const totalSize = useMemo(
    () => (artifacts ?? []).reduce((sum, artifact) => sum + artifact.size, 0),
    [artifacts],
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('summary', { count: (artifacts ?? []).length, size: fmtBytes(totalSize) })}
          </span>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void upload(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {t('upload')}
          </button>
        </div>
      </header>

      {/* 分类：按用途推进文件，而不是把扩展名堆成一列 */}
      <div className="flex flex-wrap items-center gap-2">
        {CATEGORY_ORDER.filter(
          (option) => option === 'all' || (categoryCounts.get(option) ?? 0) > 0,
        ).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setCategory(option)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              category === option
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-muted',
            )}
          >
            {t(`category.${option}`)}
            <span className="ml-1.5 opacity-60">{categoryCounts.get(option) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'agent', 'user'] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
              filter === option
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            {t(`filter.${option}`)}
          </button>
        ))}
        <div className="ml-auto flex min-w-[200px] items-center gap-2 rounded-md border border-border/60 bg-muted px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('search')}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      {artifacts === null && (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      )}

      {artifacts !== null && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center">
          <FileText className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('emptyTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('emptyHint')}</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-card">
          <ul className="divide-y divide-border/40">
            {filtered.map((artifact) => {
              const Icon = artifactIcon(artifact.format);
              const href = `/api/artifacts/${artifact.id}/download`;
              const canPreview = PREVIEWABLE.has(artifact.format.toLowerCase());
              return (
                <li key={artifact.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="h-4 w-4 text-foreground/70" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{artifact.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {artifact.format.toUpperCase()} · {fmtBytes(artifact.size)} ·{' '}
                      {fmtDateTime(artifact.createdAt, locale)} ·{' '}
                      {artifact.source === 'user' ? t('source.user') : t('source.agent')}
                      {artifact.agent ? ` (${artifact.agent})` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {canPreview && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        title={t('preview')}
                        className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    <a
                      href={href}
                      title={t('download')}
                      className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => void remove(artifact.id)}
                      disabled={busyId === artifact.id}
                      title={t('delete')}
                      className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      {busyId === artifact.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
