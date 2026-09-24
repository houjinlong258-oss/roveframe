/**
 * Artifact Protocol —— Agent 输出「可下载产物」的唯一约定。
 *
 * 为什么不用 provider 的原生工具调用：企业客户可能接入任何 OpenAI 兼容端点，
 * 很多端点不支持 function calling。用**带标记的代码围栏**表达产物，
 * 任何模型都能产出，且可以流式解析、可单测、可回放。
 *
 * 语法：
 *   ```artifact:<format>:<filename>
 *   <body>
 *   ```
 * - format ∈ csv | xlsx | docx | md | txt | json | html
 * - xlsx 的 body 必须是 JSON：`{"sheets":[{"name","columns","rows"}]}`
 * - docx 的 body 必须是 JSON：`{"title","subtitle","sections":[{"heading","paragraphs","bullets","table"}]}`
 * - 其余格式 body 即文件内容原文
 *
 * 落库时正文里的围栏被替换为不可执行标记 `<<artifact:UUID>>`，
 * 前端按标记渲染 Artifact 卡片 —— 刷新历史会话也能还原。
 */

export type ArtifactFormat = 'csv' | 'xlsx' | 'docx' | 'md' | 'txt' | 'json' | 'html';

export const ARTIFACT_FORMATS: readonly ArtifactFormat[] = [
  'csv',
  'xlsx',
  'docx',
  'md',
  'txt',
  'json',
  'html',
];

const FORMAT_SET: ReadonlySet<string> = new Set(ARTIFACT_FORMATS);

/** 需要 JSON 规格（而非原文）才能生成二进制产物的格式 */
const SPEC_FORMATS: ReadonlySet<ArtifactFormat> = new Set(['xlsx', 'docx']);

export function isArtifactFormat(value: string): value is ArtifactFormat {
  return FORMAT_SET.has(value);
}

export function requiresJsonSpec(format: ArtifactFormat): boolean {
  return SPEC_FORMATS.has(format);
}

/** 落库/渲染用的标记：`<<artifact:UUID>>` */
const MARKER_SOURCE = '<<artifact:([0-9a-fA-F-]{36})>>';

/**
 * 每次调用现建正则：共享带 `g` 的正则配合 matchAll 虽然规范上是安全的，
 * 但任何一次 `.exec()`/`.test()` 都会推进 lastIndex 并静默漏匹配，
 * 这里从根上避免这个坑。
 */
function markerPattern(): RegExp {
  return new RegExp(MARKER_SOURCE, 'g');
}

export interface ExtractedArtifact {
  format: ArtifactFormat;
  fileName: string;
  body: string;
}

export interface FenceParseResult {
  /** 移除围栏后的可见正文（不含标记） */
  text: string;
  artifacts: ExtractedArtifact[];
  warnings: string[];
}

/** 清洗模型给的文件名：防路径穿越，限制字符集与长度。 */
export function sanitizeFileName(raw: string, fallbackExt = 'txt'): string {
  const base = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-\s]+/, '')
    .slice(0, 120);
  const safe = base || `artifact.${fallbackExt}`;
  return /\.[a-z0-9]{1,6}$/i.test(safe) ? safe : `${safe}.${fallbackExt}`;
}

/**
 * 把**展示用**文件名派生成**存储 key 安全**的 ASCII 名字。
 *
 * ## 为什么必须有这一层（真实故障）
 *
 * Supabase Storage 对非 ASCII 的 object key 直接返回 `Invalid key`。
 * 而产物名是从老板原话派生的（`slugifyTitle(slugFromMessage(...))`），中文用户
 * 的每一个文件名都带中文 —— 于是 PDF / DOCX / XLSX / PPTX / HTML **全部**交付失败。
 *
 * 实测差异（同一次对话、同一个存储桶）：
 *   · `Data_1790267931096.xlsx`（程序生成的 ASCII 名）→ 上传成功，4611 字节
 *   · `写一份本月经营分析报告内容要完整并_成_报告_20260925.pdf` → `Invalid key`
 *
 * `sanitizeFileName` 只防路径穿越与控制字符，**允许任意 Unicode 字母**，所以它
 * 产出的名字不能直接当 key 用：展示名要保留中文（老板要看懂），key 必须纯 ASCII。
 * 两者分开，是这个模块存在的唯一理由。
 *
 * ## 必须确定性
 *
 * `signArtifact` / `deleteArtifact` / `readArtifactText` / `readArtifactBytes`
 * 都要用同一个函数重算路径，否则写进去的文件再也读不回来。
 *
 * 不保证唯一性，也不需要：每个产物有自己的 `{artifactId}/` 目录。
 */
export function storageSafeName(raw: string, fallbackExt = 'bin'): string {
  const rawExt = raw.includes('.') ? (raw.split('.').pop() ?? '') : '';
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || fallbackExt;
  const base = raw
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return `${base || 'artifact'}.${ext}`;
}

/** 解析单条围栏 info 字符串 `artifact:<format>:<filename>`；非法返回 null。 */
export function parseFenceInfo(info: string, formatHint?: ArtifactFormat): ExtractedArtifact | null {
  const trimmed = info.trim();
  if (!trimmed.startsWith('artifact:')) return null;
  const rest = trimmed.slice('artifact:'.length);
  const colon = rest.indexOf(':');
  const rawFormat = (colon === -1 ? rest : rest.slice(0, colon)).trim().toLowerCase();
  const rawName = colon === -1 ? '' : rest.slice(colon + 1);
  const format = isArtifactFormat(rawFormat) ? rawFormat : formatHint;
  if (!format) return null;
  return { format, fileName: sanitizeFileName(rawName || 'artifact', format), body: '' };
}

/**
 * 一次性解析完整文本里的所有 artifact 围栏（用于历史回放/测试）。
 * 未闭合的围栏保留原文，不制造半个产物。
 */
export function extractArtifactFences(text: string): FenceParseResult {
  const filter = new ArtifactStreamFilter();
  const first = filter.push(text);
  const tail = filter.flush();
  const artifacts = [...first.artifacts, ...tail.artifacts, ...filter.takeUnclosed()];
  return {
    text: first.passthrough + tail.passthrough,
    artifacts: artifacts.filter((a) => a.body.length > 0),
    warnings: [...first.warnings, ...tail.warnings, ...filter.warnings],
  };
}

/** 把产物标记拼成一行，供落库的正文使用。 */
export function artifactMarker(id: string): string {
  return `<<artifact:${id}>>`;
}

/** 从已落库正文中提取所有产物 id（去重、保序）。 */
export function artifactIdsIn(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(markerPattern())) {
    const id = match[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface TextSegment {
  type: 'text' | 'artifact';
  value: string;
}

/** 把带标记的正文切成「文本 / 产物」有序片段，供前端渲染。 */
export function splitArtifactSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(markerPattern())) {
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    if (before.trim()) segments.push({ type: 'text', value: before });
    segments.push({ type: 'artifact', value: match[1].toLowerCase() });
    cursor = index + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.trim()) segments.push({ type: 'text', value: rest });
  return segments;
}

export interface FilterStep {
  /** 可以立刻发给前端的可见文本 */
  passthrough: string;
  /** 刚刚闭合、可以落盘为产物的围栏 */
  artifacts: ExtractedArtifact[];
  warnings: string[];
}

/**
 * 流式围栏过滤器：把 `artifact:` 围栏从流里摘出来，避免用户看到原始 JSON 规格。
 *
 * 必须能处理任意切分点（SSE chunk 可能劈开 ``` 或文件名），
 * 因此未确认的部分一律留在内部 buffer 里等待后续 chunk。
 */
export class ArtifactStreamFilter {
  private buffer = '';
  private inFence = false;
  private fenceFormat: ArtifactFormat = 'txt';
  private fenceName = '';
  private fenceBody = '';
  private readonly unclosed: ExtractedArtifact[] = [];
  readonly warnings: string[] = [];

  push(chunk: string): FilterStep {
    this.buffer += chunk;
    let passthrough = '';
    const artifacts: ExtractedArtifact[] = [];
    const warnings: string[] = [];

    for (;;) {
      if (!this.inFence) {
        const start = this.buffer.indexOf('```');
        if (start === -1) {
          // 保留末尾 3 个字符，防止 ``` 被劈成两半
          const keep = Math.min(3, this.buffer.length);
          passthrough += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
        const lineEnd = this.buffer.indexOf('\n', start);
        if (lineEnd === -1) break; // 等信息行收齐
        const parsed = parseFenceInfo(this.buffer.slice(start + 3, lineEnd));
        if (!parsed) {
          passthrough += this.buffer.slice(0, lineEnd + 1);
          this.buffer = this.buffer.slice(lineEnd + 1);
          continue;
        }
        passthrough += this.buffer.slice(0, start);
        this.fenceFormat = parsed.format;
        this.fenceName = parsed.fileName;
        this.fenceBody = '';
        this.buffer = this.buffer.slice(lineEnd + 1);
        this.inFence = true;
        continue;
      }

      const close = this.buffer.indexOf('```');
      if (close === -1) {
        const keep = Math.min(3, this.buffer.length);
        this.fenceBody += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      this.fenceBody += this.buffer.slice(0, close);
      let rest = this.buffer.slice(close + 3);
      const newline = rest.indexOf('\n');
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      this.buffer = rest;
      this.inFence = false;
      const body = this.fenceBody.replace(/\s+$/, '');
      if (!body) {
        warnings.push(`empty artifact body skipped: ${this.fenceName}`);
      } else {
        artifacts.push({ format: this.fenceFormat, fileName: this.fenceName, body });
      }
      this.fenceBody = '';
    }

    this.warnings.push(...warnings);
    return { passthrough, artifacts, warnings };
  }

  /** 流结束：未闭合的围栏按原文吐回，绝不丢用户内容。 */
  flush(): FilterStep {
    if (!this.inFence) {
      const rest = this.buffer;
      this.buffer = '';
      return { passthrough: rest, artifacts: [], warnings: [] };
    }
    const raw = `\`\`\`artifact:${this.fenceFormat}:${this.fenceName}\n${this.fenceBody}${this.buffer}`;
    this.unclosed.push({
      format: this.fenceFormat,
      fileName: this.fenceName,
      body: this.fenceBody,
    });
    this.inFence = false;
    this.buffer = '';
    this.fenceBody = '';
    this.warnings.push(`unclosed artifact fence passed through: ${this.fenceName}`);
    return { passthrough: raw, artifacts: [], warnings: ['unclosed_artifact_fence'] };
  }

  /** 未闭合围栏的原始内容（诊断用；不作为产物落盘）。 */
  takeUnclosed(): ExtractedArtifact[] {
    return [...this.unclosed];
  }
}
