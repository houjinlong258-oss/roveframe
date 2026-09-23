/**
 * Artifact Store —— 文件中心与 Agent 产物的持久层。
 *
 * 为什么用 Supabase Storage 而不是新建数据表：本项目的 DDL 需要直连数据库
 * 密码（不由应用持有），因此产物索引不能依赖新表。这里采用
 * 「私有桶 + 每个产物一个目录 + 目录内 manifest.json」的方案：
 * - 零 DDL、零迁移，部署即用；
 * - 目录间互不干扰，天然并发安全（没有全局索引文件的写竞争）；
 * - 桶是 **private**，前端只能拿到短时效签名 URL，产物不会因为 URL 泄露而公开。
 *
 * 目录结构：`{tenantId}/{businessId}/{artifactId}/{fileName}` + `_artifact.json`
 */

import { getSupabaseClient, getSupabaseCredentials } from '@/storage/database/supabase-client';
import { writeDocument, writeTable, type DocSection, type TableSpec } from '@/lib/artifacts/doc-writers';
import { requiresJsonSpec, sanitizeFileName, type ArtifactFormat } from '@/lib/artifacts/protocol';

export const ARTIFACT_BUCKET = 'agent-artifacts';
export const MANIFEST_NAME = '_artifact.json';
export const SIGNED_URL_TTL_SEC = 3600;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_LISTED_ARTIFACTS = 200;
const LIST_CONCURRENCY = 8;

export type ArtifactSource = 'agent' | 'user';

export interface ArtifactRecord {
  id: string;
  name: string;
  /**
   * 文件扩展名。不收敛为窄联合：用户上传的附件可以是 pdf/zip/png 等
   * Agent 永远不会生成、但文件中心必须能管理的类型。
   */
  format: string;
  mime: string;
  size: number;
  createdAt: string;
  source: ArtifactSource;
  agent: string | null;
  sessionId: string | null;
  messageId: string | null;
  title: string | null;
  /** 短时效签名 URL（私有桶；列表接口默认不签名，按需签名） */
  url?: string | null;
}

export interface ArtifactScope {
  tenantId: string;
  businessId: string;
}

export interface CreateArtifactInput {
  name: string;
  format: string;
  data: Buffer;
  mime: string;
  source: ArtifactSource;
  agent?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  title?: string | null;
}

const MIME_BY_FORMAT: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 未知扩展名一律 application/octet-stream，绝不伪造可执行类型。 */
export function mimeForFormat(format: string): string {
  return MIME_BY_FORMAT[format.toLowerCase()] ?? 'application/octet-stream';
}

/** 允许上传到文件中心的扩展名白名单（企业资料，不是可执行文件分发通道）。 */
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_FORMAT);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 产物 id 直接进存储路径，必须先校验形状，杜绝路径穿越。 */
export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

let bucketReady = false;

/** 幂等建桶（private）。首次调用失败会在下次重试。 */
export async function ensureArtifactBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await getSupabaseClient().storage.createBucket(ARTIFACT_BUCKET, {
    public: false,
    fileSizeLimit: MAX_ARTIFACT_BYTES,
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(error.message);
  }
  bucketReady = true;
}

function scopePrefix(scope: ArtifactScope): string {
  return `${scope.tenantId}/${scope.businessId}`;
}

/** 从文件名取扩展名（小写、仅字母数字），未知返回 'bin'。 */
export function formatFromName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext && ext.length <= 6 ? ext : 'bin';
}

interface Manifest extends Omit<ArtifactRecord, 'url'> {
  v: 1;
  tenantId: string;
  businessId: string;
}

function toRecord(manifest: Manifest): ArtifactRecord {
  return {
    id: manifest.id,
    name: manifest.name,
    format: manifest.format,
    mime: manifest.mime,
    size: manifest.size,
    createdAt: manifest.createdAt,
    source: manifest.source,
    agent: manifest.agent,
    sessionId: manifest.sessionId,
    messageId: manifest.messageId,
    title: manifest.title,
  };
}

/**
 * 把围栏 body 编译成真实的二进制/文本产物。
 * xlsx / docx 走零依赖 OOXML 写入器；其余格式原文入库。
 */
export function buildArtifactFile(
  format: ArtifactFormat,
  fileName: string,
  body: string,
): { data: Buffer; mime: string } {
  if (requiresJsonSpec(format)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`artifact ${fileName}: ${format} body must be valid JSON`);
    }
    if (format === 'xlsx') {
      const spec = parsed as { sheets?: TableSpec[]; columns?: string[]; rows?: TableSpec['rows'] };
      const sheets: TableSpec[] = Array.isArray(spec.sheets) && spec.sheets.length > 0
        ? spec.sheets
        : [{ name: 'Sheet1', columns: spec.columns ?? [], rows: spec.rows ?? [] }];
      const written = writeTable('xlsx', sheets, { title: fileName.replace(/\.[^.]+$/, '') });
      return { data: written.data, mime: written.mime };
    }
    const doc = parsed as { title?: string; subtitle?: string; sections?: DocSection[] };
    const written = writeDocument('docx', {
      title: doc.title,
      subtitle: doc.subtitle,
      sections: Array.isArray(doc.sections) ? doc.sections : [],
    });
    return { data: written.data, mime: written.mime };
  }
  return { data: Buffer.from(body, 'utf8'), mime: mimeForFormat(format) };
}

/** 写入一个产物，返回可持久化到聊天正文的标记记录。 */
export async function putArtifact(
  scope: ArtifactScope,
  input: CreateArtifactInput,
): Promise<ArtifactRecord> {
  await ensureArtifactBucket();
  if (input.data.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const id = crypto.randomUUID();
  const name = sanitizeFileName(input.name, input.format);
  const manifest: Manifest = {
    v: 1,
    id,
    name,
    format: input.format,
    mime: input.mime,
    size: input.data.length,
    createdAt: new Date().toISOString(),
    source: input.source,
    agent: input.agent ?? null,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    title: input.title ?? null,
    tenantId: scope.tenantId,
    businessId: scope.businessId,
  };

  const storage = getSupabaseClient().storage.from(ARTIFACT_BUCKET);
  const objectPath = `${scopePrefix(scope)}/${id}/${name}`;
  const upload = await storage.upload(objectPath, input.data, {
    contentType: input.mime,
    upsert: false,
  });
  if (upload.error) throw new Error(upload.error.message);

  const manifestUpload = await storage.upload(
    `${scopePrefix(scope)}/${id}/${MANIFEST_NAME}`,
    Buffer.from(JSON.stringify(manifest), 'utf8'),
    { contentType: 'application/json', upsert: true },
  );
  if (manifestUpload.error) {
    // 清单写失败会导致产物在文件中心"失踪"，回滚已上传的文件。
    await storage.remove([objectPath]).catch(() => undefined);
    throw new Error(manifestUpload.error.message);
  }

  return toRecord(manifest);
}

async function readManifest(scope: ArtifactScope, artifactId: string): Promise<ArtifactRecord | null> {
  if (!isArtifactId(artifactId)) return null;
  const { data, error } = await getSupabaseClient()
    .storage.from(ARTIFACT_BUCKET)
    .download(`${scopePrefix(scope)}/${artifactId}/${MANIFEST_NAME}`);
  if (error || !data) return null;
  try {
    const manifest = JSON.parse(await data.text()) as Manifest;
    if (manifest.tenantId !== scope.tenantId || manifest.businessId !== scope.businessId) return null;
    return toRecord(manifest);
  } catch {
    return null;
  }
}

/** 有界并发 map，避免文件中心一次打开上百个连接。 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface ListArtifactsOptions {
  limit?: number;
  sessionId?: string | null;
  source?: ArtifactSource | null;
  /** 是否附带签名下载 URL（列表页默认不签，避免大量签名请求） */
  sign?: boolean;
}

/** 列出本企业的全部产物（按创建时间倒序）。 */
export async function listArtifacts(
  scope: ArtifactScope,
  options: ListArtifactsOptions = {},
): Promise<ArtifactRecord[]> {
  const storage = getSupabaseClient().storage.from(ARTIFACT_BUCKET);
  const { data: folders, error } = await storage.list(scopePrefix(scope), { limit: MAX_LISTED_ARTIFACTS });
  if (error) throw new Error(error.message);

  const ids = (folders ?? [])
    .map((entry) => entry.name)
    .filter((name) => isArtifactId(name))
    .slice(0, options.limit ?? MAX_LISTED_ARTIFACTS);

  const records = await mapLimited(ids, LIST_CONCURRENCY, (id) => readManifest(scope, id));
  let filtered = records.filter((record): record is ArtifactRecord => record !== null);
  if (options.sessionId) filtered = filtered.filter((record) => record.sessionId === options.sessionId);
  if (options.source) filtered = filtered.filter((record) => record.source === options.source);
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!options.sign) return filtered;
  return mapLimited(filtered, LIST_CONCURRENCY, async (record) => ({
    ...record,
    url: await signArtifact(scope, record.id),
  }));
}

export async function getArtifact(
  scope: ArtifactScope,
  artifactId: string,
  options: { sign?: boolean } = {},
): Promise<ArtifactRecord | null> {
  const record = await readManifest(scope, artifactId);
  if (!record) return null;
  if (!options.sign) return record;
  return { ...record, url: await signArtifact(scope, artifactId) };
}

export async function getArtifactsByIds(
  scope: ArtifactScope,
  ids: readonly string[],
  options: { sign?: boolean } = {},
): Promise<ArtifactRecord[]> {
  const unique = Array.from(new Set(ids.filter(isArtifactId))).slice(0, 100);
  const records = await mapLimited(unique, LIST_CONCURRENCY, (id) => getArtifact(scope, id, options));
  return records.filter((record): record is ArtifactRecord => record !== null);
}

/**
 * 生成短时效下载 URL。supabase-js 返回的是相对路径，
 * 必须补上项目 URL，否则浏览器会请求到应用自身域名。
 */
export async function signArtifact(
  scope: ArtifactScope,
  artifactId: string,
  expiresIn = SIGNED_URL_TTL_SEC,
): Promise<string | null> {
  const record = await readManifest(scope, artifactId);
  if (!record) return null;
  const { data, error } = await getSupabaseClient()
    .storage.from(ARTIFACT_BUCKET)
    .createSignedUrl(`${scopePrefix(scope)}/${artifactId}/${record.name}`, expiresIn);
  if (error || !data?.signedUrl) return null;
  const signed = data.signedUrl;
  if (/^https?:\/\//i.test(signed)) return signed;
  const { url } = getSupabaseCredentials();
  return `${url.replace(/\/$/, '')}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

/** 删除产物（同时删掉文件与清单）。 */
export async function deleteArtifact(scope: ArtifactScope, artifactId: string): Promise<boolean> {
  if (!isArtifactId(artifactId)) return false;
  const record = await readManifest(scope, artifactId);
  if (!record) return false;
  const prefix = `${scopePrefix(scope)}/${artifactId}`;
  const { error } = await getSupabaseClient().storage.from(ARTIFACT_BUCKET).remove([
    `${prefix}/${record.name}`,
    `${prefix}/${MANIFEST_NAME}`,
  ]);
  if (error) throw new Error(error.message);
  return true;
}

/** 纯文本类格式（可直接内联进 prompt 的） */
const TEXTUAL_FORMATS: ReadonlySet<string> = new Set(['csv', 'tsv', 'md', 'txt', 'json', 'html']);

export function isTextualArtifact(format: string): boolean {
  return TEXTUAL_FORMATS.has(format.toLowerCase());
}

/**
 * 读取文本类产物的内容（用于把用户上传的附件内联进 prompt）。
 * 二进制格式（xlsx/docx）返回 null —— 绝不让模型"猜"表格内容。
 */
export async function readArtifactText(
  scope: ArtifactScope,
  artifactId: string,
  maxBytes = 32_768,
): Promise<string | null> {
  const record = await readManifest(scope, artifactId);
  if (!record || !isTextualArtifact(record.format)) return null;
  const { data, error } = await getSupabaseClient()
    .storage.from(ARTIFACT_BUCKET)
    .download(`${scopePrefix(scope)}/${artifactId}/${record.name}`);
  if (error || !data) return null;
  const text = await data.text();
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n…[truncated]` : text;
}

/** 单次抽取允许读取的最大字节数（防超大 PDF 打爆内存） */
export const MAX_EXTRACT_BYTES = 8 * 1024 * 1024;

/**
 * 读取产物的原始字节，供 `extractText` 抽取 PDF/Word/Excel/PPT 的文本。
 * 超过上限时不读取，返回 `{ ok:false, reason:'too_large' }` 让调用方如实降级。
 */
export async function readArtifactBytes(
  scope: ArtifactScope,
  artifactId: string,
  maxBytes = MAX_EXTRACT_BYTES,
): Promise<
  | { ok: true; record: ArtifactRecord; data: Buffer }
  | { ok: false; record: ArtifactRecord | null; reason: string }
> {
  const record = await readManifest(scope, artifactId);
  if (!record) return { ok: false, record: null, reason: 'not_found' };
  if (record.size > maxBytes) return { ok: false, record, reason: 'too_large' };
  const { data, error } = await getSupabaseClient()
    .storage.from(ARTIFACT_BUCKET)
    .download(`${scopePrefix(scope)}/${artifactId}/${record.name}`);
  if (error || !data) return { ok: false, record, reason: 'download_failed' };
  return { ok: true, record, data: Buffer.from(await data.arrayBuffer()) };
}
