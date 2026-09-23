/**
 * 零依赖文本抽取器（artifact extractors）—— doc-writers 的逆向。
 *
 * 用途：老板把 PDF / Word / Excel / PPT 拖进聊天时，服务端必须先把它们变成
 * 纯文本才能内联进 prompt。历史行为是"我无法读取 PDF 二进制内容"，体验断裂；
 * 本模块提供统一的 `extractText(format, data)`，把常见办公文件抽成归一化文本。
 *
 * 能力矩阵：
 * - pdf  ：解析 `%PDF-` 间接对象，按 `/Filter` **过滤器链**（单值或数组、从左到右）
 *          解码所有流，支持 ASCII85Decode / ASCIIHexDecode / FlateDecode（含
 *          Predictor 2 与 >= 10）/ LZWDecode / RunLengthDecode；抽取
 *          `Tj` / `TJ` / `'` / `"` 操作符里的字符串（`(...)` 字面量与 `<hex>`）；
 *          解析 `ToUnicode` CMap（beginbfchar / beginbfrange）与 WinAnsiEncoding
 * - docx ：读取 `word/document.xml`（w:p 分段、w:tbl 转竖线表、w:tab / w:br 还原）
 * - xlsx ：读取 `xl/workbook.xml` + `xl/sharedStrings.xml` + `xl/worksheets/sheetN.xml`
 * - pptx ：读取 `ppt/slides/slideN.xml`（按 N 排序）里的 `a:t`
 * - csv / tsv / txt / md / json / html / xml / yaml / sql：UTF-8 解码（json 会美化，
 *          html 会去标签 + 解实体）
 *
 * 实现要点：
 * - 私有 readZip：最小 ZIP **读取**器。优先走 EOCD + Central Directory（能拿到 writer
 *   不写入 local header 的准确尺寸），EOCD 不可读时顺序扫 `PK\x03\x04` 兜底；
 *   method 8 用 `inflateRawSync`，method 0 直接取；不支持的条目跳过（不抛错）。
 * - PDF 的 `meta.pages` 只是 `/Type /Page` 的**出现次数估算**（正则计数，不解析页树、
 *   不跟 /Kids），所以允许不准 —— 它只用于给模型一个量级感。
 * - PDF 的"没有文本层"与"读不了"严格区分：只有**所有流都解码成功**却没找到任何
 *   文本操作符时才报 `scanned-pdf-no-text-layer`；未知过滤器报
 *   `pdf-filter-unsupported:<name>`、解码失败报 `pdf-stream-decode-failed:<对象号>`、
 *   预测器还原不了报 `pdf-predictor-unsupported:<对象号>`，多个原因用逗号拼接。
 * - 输出前统一归一化空白（CRLF→LF、去行尾空格、连续空行压缩、剥离 NUL 与控制字符），
 *   超过 maxChars 截断并置 `truncated`。
 *
 * 有意为之的简化（不是 bug）：
 * - 不解析 `word/header*.xml` / `footer*.xml` / 批注 / 脚注 —— 正文之外的部件一律忽略，
 *   只在 warning 里说明（页眉页脚通常不含"分析这份文档"所必需的信息）；
 * - 不解析 PDF 的 `/Differences` 字形名前缀（如 `/g23`）、不解析 CFF 字体的内嵌 CMap，
 *   也不支持 MacRomanEncoding 高位字节（这些码位按"无映射"丢弃并报
 *   `pdf-encoding-unmapped`，而不是输出乱码）；
 * - 不做 OCR：扫描件（图片 PDF）没有文本层，只能如实返回 warning；
 * - 加密文件（PDF `/Encrypt`、OOXML 加密容器）不解密，直接返回 warning；
 * - 不支持 DCTDecode / JPXDecode / JBIG2Decode / CCITTFaxDecode 等图像类过滤器
 *   （内容流用不到，图片流本来就不抽文本）；
 * - docx 表格不还原合并单元格 / 嵌套表结构，只做行内竖线拼接。
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

/* -------------------------------------------------------------------------- */
/* 公共类型                                                                    */
/* -------------------------------------------------------------------------- */

export type ExtractibleFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'csv'
  | 'tsv'
  | 'txt'
  | 'md'
  | 'json'
  | 'html'
  | 'xml'
  | 'yaml'
  | 'sql';

export interface ExtractResult {
  ok: boolean;
  /** 抽到的纯文本（已归一化空白、去掉多余空行） */
  text: string;
  /** 是否被 maxChars 截断 */
  truncated: boolean;
  /** 抽取策略的如实说明，例如 'pdf-text-operators' / 'ooxml-xml' / 'plain' */
  strategy: string;
  /** 页数 / 工作表数 / 幻灯片数等结构化信息（拿不到就是 null） */
  meta: { pages?: number | null; sheets?: string[] | null; slides?: number | null; characters: number };
  /** 失败或降级原因（如 'scanned-pdf-no-text-layer'、'encrypted'），成功时为 null */
  warning: string | null;
}

export const DEFAULT_MAX_CHARS = 60_000;

const EXTRACTIBLE_FORMATS: readonly ExtractibleFormat[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'html',
  'xml',
  'yaml',
  'sql',
];

const FORMAT_SET: ReadonlySet<string> = new Set<string>(EXTRACTIBLE_FORMATS);

/** 纯文本类格式（无需解包，直接解码即可） */
const PLAIN_FORMATS: ReadonlySet<string> = new Set(['csv', 'tsv', 'txt', 'md', 'xml', 'yaml', 'sql']);

const STRATEGY_PLAIN = 'plain';
const STRATEGY_OOXML = 'ooxml-xml';
const STRATEGY_HTML = 'html-tags';
const STRATEGY_JSON = 'json-pretty';
const STRATEGY_PDF = 'pdf-text-operators';

/**
 * 这些 warning 表示"抽取本身成功，只是内容层面拿不到文本"（如扫描件没有文本层），
 * 此时 `ok` 保持 true —— 让上层能区分"文件读得动但没文本"与"文件根本读不了"。
 */
const DEGRADED_WARNINGS: ReadonlySet<string> = new Set(['scanned-pdf-no-text-layer']);

/** 规范化扩展名形状：小写、去掉前导点与非字母数字（仅取前 12 字符）。 */
function normalizeFormat(format: string): string {
  return String(format ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
}

/** 这个扩展名能否抽取（用于上传后决定「能不能内联进 prompt」）。 */
export function canExtract(format: string): boolean {
  return FORMAT_SET.has(normalizeFormat(format));
}

/* -------------------------------------------------------------------------- */
/* 内部类型                                                                    */
/* -------------------------------------------------------------------------- */

interface ExtractMeta {
  pages?: number | null;
  sheets?: string[] | null;
  slides?: number | null;
}

/** 各格式抽取器的统一返回：正文片段 + 结构化信息 + 降级原因。 */
interface Extracted {
  parts: string[];
  meta: ExtractMeta;
  warning: string | null;
}

const EMPTY_META: ExtractMeta = { pages: null, sheets: null, slides: null };

function emptyExtracted(warning: string | null = null): Extracted {
  return { parts: [], meta: EMPTY_META, warning };
}

/* -------------------------------------------------------------------------- */
/* 最小 ZIP 读取器（私有）                                                      */
/* -------------------------------------------------------------------------- */

interface ZipEntrySource {
  name: string;
  method: number;
  compressedSize: number;
  dataStart: number;
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_METHOD_STORE = 0;
/** 单个条目解压后的上限，防 zip bomb / 防一次分配几十 MB 字符串 */
const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 4096;

/** 从 EOCD 定位 Central Directory；找不到返回 null。 */
function locateZipDirectory(buf: Buffer): { offset: number; count: number } | null {
  const minOffset = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) !== ZIP_EOCD_SIG) continue;
    const count = buf.readUInt16LE(i + 10);
    const size = buf.readUInt32LE(i + 12);
    const offset = buf.readUInt32LE(i + 16);
    if (offset >= 0 && size >= 0 && offset + size <= buf.length) return { offset, count };
  }
  return null;
}

/** 顺序扫 Local File Header（central directory 不可用时的兜底）。 */
function scanZipLocals(buf: Buffer): ZipEntrySource[] {
  const entries: ZipEntrySource[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length && entries.length < ZIP_MAX_ENTRIES) {
    if (buf.readUInt32LE(offset) !== ZIP_LOCAL_SIG) break;
    const method = buf.readUInt16LE(offset + 8);
    let compressedSize = buf.readUInt32LE(offset + 18);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    if (offset + 30 + nameLength + extraLength > buf.length) break;
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    if (compressedSize === 0 && method === ZIP_METHOD_STORE) {
      // 流式写入（data descriptor）的 local header 尺寸为 0：只能取到下一个 header 之前。
      const next = buf.indexOf('PK\x03\x04', dataStart, 'latin1');
      const end = next >= 0 ? next : buf.length;
      compressedSize = Math.max(0, end - dataStart);
    }
    entries.push({ name, method, compressedSize, dataStart });
    offset = dataStart + compressedSize;
  }
  return entries;
}

/** 读 Central Directory（含 ZIP64 扩展字段中的真实尺寸/偏移）。 */
function readZipCentrals(buf: Buffer, volume: { offset: number; count: number }): ZipEntrySource[] | null {
  const entries: ZipEntrySource[] = [];
  let offset = volume.offset;
  for (let i = 0; i < volume.count && entries.length < ZIP_MAX_ENTRIES; i += 1) {
    if (offset + 46 > buf.length) return null;
    if (buf.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) return null;
    const method = buf.readUInt16LE(offset + 10);
    let compressedSize: number = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    let localOffset: number = buf.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength + commentLength > buf.length) return null;
    const name = buf.subarray(nameStart, extraStart).toString('utf8');

    // ZIP64：尺寸/偏移为 0xFFFFFFFF 时，真实值按固定顺序落在 0x0001 扩展字段里。
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let p = extraStart;
      const extraEnd = extraStart + extraLength;
      while (p + 4 <= extraEnd) {
        const headerId = buf.readUInt16LE(p);
        const dataSize = buf.readUInt16LE(p + 2);
        let q = p + 4;
        if (headerId === 0x0001) {
          const limit = Math.min(q + dataSize, extraEnd);
          if (compressedSize === 0xffffffff && q + 8 <= limit) {
            compressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff && q + 8 <= limit) {
            localOffset = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
        }
        p += 4 + dataSize;
      }
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) return null;
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    entries.push({
      name,
      method,
      compressedSize,
      dataStart: localOffset + 30 + localNameLength + localExtraLength,
    });
    offset = extraStart + extraLength + commentLength;
  }
  return entries;
}

/** 文件在 ZIP 中央目录里的查找结果（不预解压，按需 inflate）。 */
interface ZipReader {
  names: string[];
  read(name: string): Buffer | null;
}

/**
 * 打开一个 ZIP：建立「条目名 → 数据位置」的索引。
 * 任何结构问题都返回可用的**空** reader，绝不抛错。
 */
function openZip(buf: Buffer): ZipReader {
  const empty: ZipReader = { names: [], read: () => null };
  if (buf.length < 22) return empty;

  const volume = locateZipDirectory(buf);
  const entries = volume === null ? null : readZipCentrals(buf, volume);
  const list = entries ?? (volume === null ? scanZipLocals(buf) : []);
  if (list.length === 0) return empty;

  const index = new Map<string, ZipEntrySource>();
  for (const entry of list) index.set(entry.name, entry);

  const read = (name: string): Buffer | null => {
    const entry = index.get(name);
    if (entry === undefined) return null;
    const start = entry.dataStart;
    const end = start + entry.compressedSize;
    if (start < 0 || end > buf.length || end <= start) return null;
    const raw = buf.subarray(start, end);
    if (entry.method === ZIP_METHOD_STORE) return staticMax(raw) ? Buffer.from(raw) : null;
    if (entry.method !== ZIP_METHOD_DEFLATE) return null; // 不支持的压缩方式：跳过
    try {
      const out = inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
      return Buffer.from(out);
    } catch {
      return null;
    }
  };

  return { names: Array.from(index.keys()), read };
}

function staticMax(raw: Buffer): boolean {
  return raw.length <= ZIP_MAX_ENTRY_BYTES;
}

/** ZIP 条目 → UTF-8 字符串（读不到返回 null）。 */
function readZipText(zip: ZipReader, name: string): string | null {
  const data = zip.read(name);
  if (data === null) return null;
  return data.toString('utf8');
}

/* -------------------------------------------------------------------------- */
/* XML 轻量辅助（命名空间无关，够用即可）                                        */
/* -------------------------------------------------------------------------- */

/**
 * 扫描出所有标签的范围（**只看 `<...>` 一层**，不递归）。
 * 这是整个 OOXML / XML 解析的唯一原语：文本段取标签之间的切片，
 * 结构比较用标签名字符串，绝不为了"找某元素"去拼动态正则 ——
 * 之前用动态正则 + 转义辅助时，`w:p` 一度被转义成非法转义 `\p`，
 * 导致所有标签匹配静默返回空数组（最难查的一类 bug）。
 *
 * `end` 是**标签之后**的下标（半开区间），调用方按 `xml.slice(start, end)`
 * 取标签、按 `xml.slice(prev.end, tag.start)` 取标签之间的文字。
 */
function scanTags(xml: string): TagToken[] {
  const tags: TagToken[] = [];
  let cursor = 0;
  while (tags.length < 200_000) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    const gt = xml.indexOf('>', start + 1);
    if (gt < 0) break;
    const end = gt + 1;
    cursor = end;
    if (xml[start + 1] === '!' || xml[start + 1] === '?') continue; // 声明 / 注释 / CDATA
    let p = start + 1;
    const closing = xml[p] === '/';
    if (closing) p += 1;
    if (p >= gt) continue;
    if (!/[A-Za-z_]/.test(xml[p])) continue;
    p += 1;
    while (p < gt && /[\w.:-]/.test(xml[p])) p += 1;
    const raw = xml.slice(start + (closing ? 2 : 1), p);
    const colon = raw.lastIndexOf(':');
    const name = colon >= 0 ? raw.slice(colon + 1) : raw;
    if (name === '') continue;
    // 自闭合判定要看 `>` 之前的内容（`end` 已越过 `>`）：`<w:b/>`、`<w:b />`
    let q = gt - 1;
    while (q > start && /\s/.test(xml[q])) q -= 1;
    tags.push({ start, end, name, closing, selfClosing: !closing && xml[q] === '/' });
  }
  return tags;
}

/**
 * 同名元素的配对范围（跳过同名嵌套，例：`w:tbl` 里的 `w:tbl` 不会被当成第二个表格）。
 * 自闭合标签只产生一个点范围，不参与配对深度。
 */
function elementSpans(xml: string, name: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  for (const tag of scanTags(xml)) {
    if (tag.name !== name) continue;
    if (tag.selfClosing) {
      if (depth === 0) spans.push({ start: tag.start, end: tag.end });
      continue;
    }
    if (!tag.closing) {
      if (depth === 0) start = tag.start;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      spans.push({ start, end: tag.end });
      start = -1;
    }
  }
  return spans;
}

/** 元素（含自身标签）的完整 XML；找不到返回 null。 */
function elementXml(xml: string, name: string): string | null {
  const span = elementSpans(xml, name)[0];
  return span === undefined ? null : xml.slice(span.start, span.end);
}

/**
 * 元素内容（自身标签之间）；找不到返回 null。
 * 通过**配对深度**找真正的结束标签 —— 不能想当然地取"片段里最后一个标签"：
 * `<w:p><w:r><w:t>x</w:t></w:r></w:p>` 的最后一个标签是 `</w:r>`，用它会
 * 把 `</w:r>` 与 `</w:p` 之间的 `>>` 残留混进正文（曾导致抽取文本里全是 `>`）。
 */
function elementInner(xml: string, name: string): string | null {
  const span = elementSpans(xml, name)[0];
  if (span === undefined) return null;
  const segment = xml.slice(span.start, span.end);
  const tags = scanTags(segment);
  if (tags.length < 2) return '';
  let depth = 1;
  for (let i = 1; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.name !== name || tag.selfClosing) continue;
    if (!tag.closing) {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return segment.slice(tags[0].end, tag.start);
  }
  // 没找到配对的结束标签（截断的 XML）：退化为"去掉首尾标签"
  return segment.slice(tags[0].end, tags[tags.length - 1].start);
}

/**
 * 某元素下、**不含**任何同名嵌套元素的那部分 XML。
 *
 * 注意调用约定：必须传"元素本身"，内部先取 inner 再看嵌套 ——
 * 曾经写成 `withoutNested(inner, name)`，那等于把**所有子元素**都挖掉
 * （docx 表格因此整表抽成空串），是个很难从结果反推的错位。
 */
function withoutNested(xml: string, name: string): string {
  const spans = elementSpans(xml, name);
  if (spans.length === 0) return xml;
  const first = elementInner(xml, name);
  if (first === null) return xml;
  const child = elementSpans(first, name);
  let out = first;
  for (let i = child.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, child[i].start) + out.slice(child[i].end);
  }
  return out;
}

/** 标签 → 属性值（`name` 写全名，如 `w:val` / `r:id`）。 */
function tagAttr(tag: string, name: string): string | null {
  const p = tag.indexOf(name);
  if (p < 0) return null;
  const before = tag[p - 1];
  if (before !== undefined && !/[\s]/.test(before)) return null; // 必须是完整属性名
  const rest = tag.slice(p + name.length);
  const match = /^\s*=\s*"([^"]*)"/.exec(rest) ?? /^\s*=\s*'([^']*)'/.exec(rest);
  return match === null ? null : decodeXmlEntities(match[1]);
}

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeXmlEntities(input: string): string {
  if (input.indexOf('&') < 0) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_XML_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/** 去掉全部标签，保留文本（tab / br 等由调用方先行替换）。 */
function stripTags(xml: string): string {
  const tags = scanTags(xml);
  if (tags.length === 0) return decodeXmlEntities(xml);
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    if (tag.start > cursor) out += xml.slice(cursor, tag.start);
    cursor = tag.end;
  }
  if (cursor < xml.length) out += xml.slice(cursor);
  return decodeXmlEntities(out);
}

/* -------------------------------------------------------------------------- */
/* DOCX                                                                        */
/* -------------------------------------------------------------------------- */

/** 标签文本片段（`<w:t>` 内的文字，含标签本身），按文档顺序。 */
interface TagToken {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/** 直接子元素（按标签范围切出的 XML 片段）。 */
function tagSlices(xml: string, name: string): string[] {
  return elementSpans(xml, name).map((span) => xml.slice(span.start, span.end));
}

/** 某元素内容里、指定名字的标签文本片段（用于取 `<w:t>` 文字）。 */
function innerSlices(xml: string, outerName: string, innerName: string): string[] {
  const inner = elementInner(xml, outerName);
  if (inner === null) return [];
  return tagSlices(inner, innerName);
}

/** 标题样式序号：Heading1 → 1，Title → 1；不是标题返回 null。 */
function headingLevel(styleId: string | null): number | null {
  if (styleId === null) return null;
  const match = /^(?:Heading|heading)\s*(\d+)$/.exec(styleId);
  if (match !== null) {
    const level = Number.parseInt(match[1], 10);
    return Number.isFinite(level) && level > 0 ? level : null;
  }
  return /^(?:Title|Subtitle)$/.test(styleId) ? 1 : null;
}

/** 取某元素的首个开标签文本（拿属性用）。 */
function firstOpenTag(xml: string, name: string): string | null {
  for (const tag of scanTags(xml)) {
    if (tag.name !== name || tag.closing) continue;
    return xml.slice(tag.start, tag.end);
  }
  return null;
}

/** 段落 / 单元格内容 → 文本（tab → \t，br / cr → \n），标签之间的文字按序拼接。 */
function docxInlineText(xml: string): string {
  const tags = scanTags(xml);
  if (tags.length === 0) return decodeXmlEntities(xml);
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    if (tag.start > cursor) out += decodeXmlEntities(xml.slice(cursor, tag.start));
    if (!tag.closing && !tag.selfClosing && tag.name === 'tab') out += '\t';
    if (!tag.closing && !tag.selfClosing && (tag.name === 'br' || tag.name === 'cr')) out += '\n';
    cursor = tag.end;
  }
  if (cursor < xml.length) out += decodeXmlEntities(xml.slice(cursor));
  return out;
}

/** 单个 w:p → 一行文本（按 pStyle 加 markdown 标题前缀）。 */
function docxParagraphText(paragraphXml: string): string {
  const inner = elementInner(paragraphXml, 'p') ?? '';
  const styleTag = firstOpenTag(inner, 'pStyle');
  const level = headingLevel(styleTag === null ? null : tagAttr(styleTag, 'w:val'));
  const text = docxInlineText(withoutNested(paragraphXml, 'p')).replace(/\n+/g, ' ').trim();
  if (text === '') return '';
  return level === null ? text : `${'#'.repeat(Math.min(level, 6))} ${text}`;
}

/** 单元格 → 单行文本（内部多段用空格连接，避免撑破竖线表格）。 */
function docxCellText(cellXml: string): string {
  const inner = elementInner(cellXml, 'tc');
  if (inner === null) return '';
  const paragraphs = tagSlices(inner, 'p').map((paragraph) => docxParagraphText(paragraph));
  return paragraphs.filter((line) => line !== '').join(' ').replace(/\n+/g, ' ').trim();
}

/** w:tbl → 竖线分隔的文本表（每行一行）。 */
function docxTableText(tableXml: string): string {
  const inner = elementInner(tableXml, 'tbl');
  if (inner === null) return '';
  const rows = tagSlices(inner, 'tr').map((rowXml) => {
    const rowInner = elementInner(rowXml, 'tr') ?? '';
    const cells = tagSlices(rowInner, 'tc').map((cellXml) => docxCellText(cellXml));
    return cells.join(' | ');
  });
  return rows.filter((row) => row.replace(/[|\s]/g, '') !== '').join('\n');
}

/** 顶层块（w:p / w:tbl）按文档顺序的 XML 片段。 */
function docxTopLevelBlocks(bodyXml: string): Array<{ kind: 'p' | 'tbl'; xml: string }> {
  const blocks: Array<{ kind: 'p' | 'tbl'; xml: string }> = [];
  for (const tag of scanTags(bodyXml)) {
    if (tag.closing || tag.selfClosing) continue;
    if (tag.name !== 'p' && tag.name !== 'tbl') continue;
    const span = elementSpans(bodyXml, tag.name).find((candidate) => candidate.start === tag.start);
    if (span === undefined) continue;
    blocks.push({ kind: tag.name, xml: bodyXml.slice(span.start, span.end) });
  }
  return blocks;
}

function extractDocx(buf: Buffer): Extracted {
  const zip = openZip(buf);
  const document = readZipText(zip, 'word/document.xml');
  if (document === null) return emptyExtracted('docx-no-document-xml');
  const body = elementXml(document, 'body') ?? document;

  const parts: string[] = [];
  for (const block of docxTopLevelBlocks(body)) {
    if (block.kind === 'tbl') {
      const table = docxTableText(block.xml);
      if (table !== '') parts.push(table);
      continue;
    }
    const line = docxParagraphText(block.xml);
    if (line !== '') parts.push(line);
  }

  // 页眉 / 页脚 / 脚注 / 批注是有意忽略的部件：只在 warning 里如实说明。
  const skipped = zip.names.some(
    (name) => /^word\/(?:header|footer)\d*\.xml$/.test(name) || /^word\/(?:footnotes|endnotes|comments)\.xml$/.test(name),
  );
  return {
    parts,
    meta: EMPTY_META,
    warning: skipped ? 'docx-headers-footers-skipped' : null,
  };
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                        */
/* -------------------------------------------------------------------------- */

/** `xl/workbook.xml` 的 sheet 名（按文档顺序）。 */
function xlsxSheetNames(workbookXml: string): string[] {
  const container = elementXml(workbookXml, 'sheets') ?? workbookXml;
  return tagSlices(container, 'sheet')
    .map((sheetXml) => {
      const tag = firstOpenTag(sheetXml, 'sheet');
      return tag === null ? '' : (tagAttr(tag, 'name') ?? '');
    })
    .filter((name) => name !== '');
}

/** `xl/sharedStrings.xml` → 共享字符串表（每个 si 内的 t 片段直接拼接）。 */
function xlsxSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const root = elementXml(xml, 'sst') ?? xml;
  return tagSlices(root, 'si').map((siXml) =>
    innerSlices(siXml, 'si', 't')
      .map((tXml) => stripTags(tXml))
      .join(''),
  );
}

/** 单元格引用（`BC12`）→ 0 基列号；无法解析返回 null。 */
function columnIndexFromRef(ref: string | null): number | null {
  if (ref === null) return null;
  const match = /^([A-Za-z]+)/.exec(ref.trim());
  if (match === null) return null;
  let value = 0;
  const letters = match[1].toUpperCase();
  for (let i = 0; i < letters.length; i += 1) {
    value = value * 26 + (letters.charCodeAt(i) - 64);
  }
  return value - 1;
}

/** 单个 `<c>` → 该格显示文本。 */
function xlsxCellText(cellXml: string, shared: string[]): string {
  const tag = firstOpenTag(cellXml, 'c');
  const type = tag === null ? null : tagAttr(tag, 't');

  if (type === 'inlineStr') {
    return innerSlices(cellXml, 'c', 't')
      .map((tXml) => stripTags(tXml))
      .join('');
  }
  const valueXml = elementXml(cellXml, 'v');
  const raw = valueXml === null ? '' : stripTags(valueXml).trim();
  if (raw === '') return '';
  if (type === 's') {
    const index = Number.parseInt(raw, 10);
    if (!Number.isFinite(index) || index < 0 || index >= shared.length) return '';
    return shared[index];
  }
  return raw;
}

/** 单张工作表 → 行文本数组（按 r 属性定位列，空行丢弃）。 */
function xlsxSheetRows(sheetXml: string, shared: string[]): string[] {
  const data = elementXml(sheetXml, 'sheetData') ?? sheetXml;
  const rows: string[] = [];
  for (const rowXml of tagSlices(data, 'row')) {
    const cells: Array<{ index: number; text: string }> = [];
    let cursor = 0;
    for (const cellXml of tagSlices(elementInner(rowXml, 'row') ?? rowXml, 'c')) {
      const tag = firstOpenTag(cellXml, 'c');
      const declared = columnIndexFromRef(tag === null ? null : tagAttr(tag, 'r'));
      const index = declared === null ? cursor : declared;
      cursor = index + 1;
      cells.push({ index, text: xlsxCellText(cellXml, shared).replace(/[\r\n]+/g, ' ') });
    }
    if (cells.length === 0) continue;
    const width = cells.reduce((max, cell) => Math.max(max, cell.index), 0) + 1;
    const line = Array.from({ length: width }, (_, i) => cells.find((cell) => cell.index === i)?.text ?? '');
    if (line.every((value) => value.trim() === '')) continue;
    rows.push(line.join(' | '));
  }
  return rows;
}

function extractXlsx(buf: Buffer): Extracted {
  const zip = openZip(buf);
  const workbook = readZipText(zip, 'xl/workbook.xml');
  if (workbook === null) return emptyExtracted('xlsx-no-workbook-xml');
  const shared = xlsxSharedStrings(readZipText(zip, 'xl/sharedStrings.xml'));

  const names = xlsxSheetNames(workbook);
  const sheetTags = tagSlices(elementXml(workbook, 'sheets') ?? workbook, 'sheet');
  const relXml = readZipText(zip, 'xl/_rels/workbook.xml.rels');
  const relTargets = new Map<string, string>();
  if (relXml !== null) {
    for (const rel of tagSlices(elementXml(relXml, 'Relationships') ?? relXml, 'Relationship')) {
      const tag = firstOpenTag(rel, 'Relationship');
      if (tag === null) continue;
      const id = tagAttr(tag, 'Id');
      const target = tagAttr(tag, 'Target');
      if (id !== null && target !== null) relTargets.set(id, target);
    }
  }

  // 工作表部件路径：优先按 r:id → rels Target 解析，缺失时回落 sheetN.xml 顺序。
  const sheetFiles = zip.names
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const sheetsFromRels: Array<string | null> = sheetTags.map((sheetXml) => {
    const tag = firstOpenTag(sheetXml, 'sheet');
    const relId = tag === null ? null : (tagAttr(tag, 'r:id') ?? tagAttr(tag, 'id'));
    const target = relId === null ? null : (relTargets.get(relId) ?? null);
    if (target === null) return null;
    const normalized = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    const candidate = `xl/${normalized}`;
    return sheetFiles.includes(candidate) ? candidate : null;
  });

  const parts: string[] = [];
  const usedNames: string[] = [];
  const count = Math.max(names.length, sheetFiles.length);
  for (let i = 0; i < count; i += 1) {
    const name = names[i] ?? `Sheet${i + 1}`;
    const file = sheetsFromRels[i] ?? sheetFiles[i] ?? null;
    const xml = file === null ? null : readZipText(zip, file);
    const rows = xml === null ? [] : xlsxSheetRows(xml, shared);
    usedNames.push(name);
    // 一张工作表 → 一个片段（表头行与数据行之间不空行）
    parts.push([`## Sheet: ${name}`, ...rows].join('\n'));
  }

  return {
    parts,
    meta: { pages: null, sheets: usedNames.length > 0 ? usedNames : null, slides: null },
    warning: null,
  };
}

/* -------------------------------------------------------------------------- */
/* PPTX                                                                        */
/* -------------------------------------------------------------------------- */

/** 单个 slide XML → 段落文本数组。 */
function pptxSlideParagraphs(slideXml: string): string[] {
  const lines: string[] = [];
  for (const paragraphXml of tagSlices(slideXml, 'p')) {
    // 表格单元格里的 a:p 会被外层再收一遍；这里只取真正的段落文本
    const text = innerSlices(paragraphXml, 'p', 't')
      .map((tXml) => stripTags(tXml))
      .join('')
      .trim();
    if (text !== '') lines.push(text);
  }
  return lines;
}

function extractPptx(buf: Buffer): Extracted {
  const zip = openZip(buf);
  const slideFiles = zip.names
    .map((name) => ({ name, index: Number.parseInt((/^ppt\/slides\/slide(\d+)\.xml$/i.exec(name) ?? [])[1] ?? '', 10) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);
  if (slideFiles.length === 0) return emptyExtracted('pptx-no-slides');

  const parts: string[] = [];
  let emitted = 0;
  slideFiles.forEach((file, position) => {
    const xml = readZipText(zip, file.name);
    if (xml === null) return;
    const lines = pptxSlideParagraphs(xml);
    emitted += 1;
    // 一张幻灯片 → 一个片段
    parts.push([`## Slide ${position + 1}`, ...lines].join('\n'));
  });

  return {
    parts,
    meta: { pages: null, sheets: null, slides: emitted > 0 ? emitted : null },
    warning: emitted === 0 ? 'pptx-slides-unreadable' : null,
  };
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

const PDF_STRING = 'stream';
const PDF_STRING_END = 'endstream';

/** 从 `stream` 关键字后跳到数据起点（`stream` 后必须跟 CRLF 或 LF）。 */
function streamDataStart(buf: Buffer, keywordIndex: number): number {
  let p = keywordIndex + PDF_STRING.length;
  if (buf[p] === 0x0d) p += 1;
  if (buf[p] === 0x0a) p += 1;
  return p;
}

/**
 * 在 `from` 之后找下一个真正的 `stream` 关键字。
 * 必须校验关键字合法性：`endstream` 里就含 `stream` 子串，二进制流数据里
 * 也可能出现同样的字节 —— 校验「后面跟 EOL / 空白」能滤掉这两类误命中。
 */
function findStreamKeyword(buf: Buffer, from: number, to: number): number {
  let cursor = Math.max(0, from);
  const limit = Math.min(to, buf.length);
  for (;;) {
    const keyword = buf.indexOf(PDF_STRING, cursor, 'latin1');
    if (keyword < 0 || keyword >= limit) return -1;
    const next = buf[keyword + PDF_STRING.length];
    if (next === 0x0d || next === 0x0a || next === 0x20 || next === 0x09) return keyword;
    cursor = keyword + PDF_STRING.length;
  }
}

/**
 * 对象段的字典体：从首个 `<<` 一直截到 `stream` 关键字之前。
 * 这里**有意**不按 `>>` 配对截断：`>>` 可能属于嵌套字典
 * （如 `/FontDescriptor << ... >>`），截在第一个 `>>` 会丢掉后面的
 * `/Filter /FlateDecode` 或误捡到本段的 `/Subtype /Image`。
 */
function pdfDictSnippet(buf: Buffer, sectionStart: number, keyword: number): string {
  const dictStart = buf.indexOf('<<', sectionStart, 'latin1');
  if (dictStart < 0 || dictStart >= keyword) return '';
  return buf.subarray(dictStart, keyword).toString('latin1');
}

/** 解析 `obj` 关键字前那个 `N G` 里的对象号（用于诊断标签，拿不到返回 null）。 */
function pdfObjectNumberAt(buf: Buffer, objKeyword: number): number | null {
  const isSpace = (byte: number): boolean =>
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
  const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
  let p = objKeyword - 1;
  while (p >= 0 && isSpace(buf[p])) p -= 1;
  if (p < 0 || !isDigit(buf[p])) return null;
  while (p >= 0 && isDigit(buf[p])) p -= 1; // 生成号
  while (p >= 0 && isSpace(buf[p])) p -= 1;
  if (p < 0 || !isDigit(buf[p])) return null;
  const end = p;
  while (p >= 0 && isDigit(buf[p])) p -= 1;
  const value = Number.parseInt(buf.subarray(p + 1, end + 1).toString('latin1'), 10);
  return Number.isFinite(value) ? value : null;
}

/** 收集文件里所有 stream 的裸字节（不解码，只在需要时走过滤器链）。 */
function collectPdfStreams(buf: Buffer): Array<{ dict: string; data: Buffer; objectNumber: number | null }> {
  const streams: Array<{ dict: string; data: Buffer; objectNumber: number | null }> = [];
  let cursor = 0;
  while (streams.length < 4096) {
    const keyword = findStreamKeyword(buf, cursor, buf.length);
    if (keyword < 0) break;
    // 对象段从上一个对象的 `endobj` 之后算起，避免把上一段字典读进来
    const prevEnd = buf.lastIndexOf('endobj', keyword, 'latin1');
    const dictStart = prevEnd < 0 ? 0 : prevEnd + 'endobj'.length;
    const dict = pdfDictSnippet(buf, dictStart, keyword);
    // `N G obj` 在 dictStart 之后、字典 `<<` 之前
    const objAt = buf.indexOf('obj', dictStart, 'latin1');
    const objectNumber = objAt >= 0 && objAt < keyword ? pdfObjectNumberAt(buf, objAt) : null;
    const start = streamDataStart(buf, keyword);
    const end = buf.indexOf(PDF_STRING_END, start, 'latin1');
    if (end < 0) {
      streams.push({ dict, data: buf.subarray(start), objectNumber });
      break;
    }
    let dataEnd = end;
    if (dataEnd > start && buf[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (dataEnd > start && buf[dataEnd - 1] === 0x0d) dataEnd -= 1;
    streams.push({ dict, data: buf.subarray(start, dataEnd), objectNumber });
    cursor = end + PDF_STRING_END.length;
  }
  return streams;
}

/* ------------------------------ 流过滤器链 -------------------------------- */

/**
 * PDF 流过滤器（`/Filter`）。支持单值 `/Filter /FlateDecode` 与数组
 * `/Filter [ /ASCII85Decode /FlateDecode ]` —— 真实 PDF（ReportLab 等）大量使用
 * 后者，只认单一 FlateDecode 会把有文本层的文件误判成扫描件。
 */
type PdfFilterName =
  | 'ASCII85Decode'
  | 'ASCIIHexDecode'
  | 'FlateDecode'
  | 'LZWDecode'
  | 'RunLengthDecode'
  | 'unsupported';

/** 过滤器全名 → 规范名（含 inline 图片常用的两字母缩写）。 */
const PDF_FILTER_ALIASES: Record<string, PdfFilterName> = {
  ascii85decode: 'ASCII85Decode',
  a85: 'ASCII85Decode',
  asciihexdecode: 'ASCIIHexDecode',
  ahx: 'ASCIIHexDecode',
  flatedecode: 'FlateDecode',
  fl: 'FlateDecode',
  lzwdecode: 'LZWDecode',
  lzw: 'LZWDecode',
  runlengthdecode: 'RunLengthDecode',
  rl: 'RunLengthDecode',
};

interface PdfStreamDecoded {
  /** 解码后的字节；失败或被有意跳过时为 null */
  data: Buffer | null;
  /** 解码失败 / 过滤器不支持的原因（成功为 null） */
  warning: string | null;
  /** 有意跳过（图片等非文本流），不计入失败 */
  skipped: boolean;
}

/** 读取 `/Filter` 为名字数组（单值也归一成单元素数组）。 */
function pdfFilters(dict: string): string[] {
  const at = dict.indexOf('/Filter');
  if (at < 0) return [];
  const rest = dict.slice(at + '/Filter'.length);
  const arrayMatch = /^\s*\[([^\]]*)\]/.exec(rest);
  const body = arrayMatch === null ? rest.slice(0, 160) : arrayMatch[1];
  const names: string[] = [];
  const pattern = /\/([A-Za-z0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) names.push(match[1]);
  return arrayMatch === null ? names.slice(0, 1) : names;
}

/** 读取 `/DecodeParms`（或 `/DP`）为"每个过滤器一段原文"，用于取 Predictor 等参数。 */
function pdfDecodeParms(dict: string): string[] {
  const at = dict.indexOf('/DecodeParms') >= 0 ? dict.indexOf('/DecodeParms') : dict.indexOf('/DP');
  if (at < 0) return [];
  const rest = dict.slice(at).replace(/^\/(?:DecodeParms|DP)/, '');
  const arrayMatch = /^\s*\[([\s\S]*)\]/.exec(rest);
  if (arrayMatch === null) return [rest.slice(0, 240)];
  const items: string[] = [];
  const pattern = /<<([\s\S]*?)>>|\bnull\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(arrayMatch[1])) !== null) items.push(match[1] ?? '');
  return items;
}

/** 从一段 DecodeParms 里取整数参数。 */
function pdfParmsInt(parms: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(-?\\d+)`).exec(parms);
  if (match === null) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

/** ASCII85Decode：base-85，`z` = 4 个 0 字节，`~>` 结束，尾部不足 5 字节补 84。 */
function pdfAscii85(data: Buffer): Buffer | null {
  const out: number[] = [];
  let i = 0;
  const isWhitespace = (byte: number): boolean =>
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
  while (i < data.length) {
    const byte = data[i];
    if (isWhitespace(byte)) {
      i += 1;
      continue;
    }
    if (byte === 0x7e) break; // `~>` 结束标记
    if (byte === 0x7a) {
      out.push(0, 0, 0, 0);
      i += 1;
      continue;
    }
    if (byte < 0x21 || byte > 0x75) {
      i += 1;
      continue;
    }
    const group: number[] = [];
    while (group.length < 5 && i < data.length) {
      const current = data[i];
      if (isWhitespace(current)) {
        i += 1;
        continue;
      }
      if (current === 0x7e || current < 0x21 || current > 0x75) break;
      group.push(current - 0x21);
      i += 1;
    }
    if (group.length === 0) break;
    const count = group.length;
    while (group.length < 5) group.push(84); // 'u' 补齐
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...(count === 5 ? bytes : bytes.slice(0, count - 1)));
  }
  return Buffer.from(out);
}

/** ASCIIHexDecode：十六进制直到 `>`（或数据结束），奇数个数字补 0。 */
function pdfAsciiHex(data: Buffer): Buffer {
  let hex = '';
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (byte === 0x3e) break; // '>'
    const char = String.fromCharCode(byte);
    if (/[0-9a-fA-F]/.test(char)) hex += char;
  }
  if (hex.length % 2 === 1) hex += '0';
  const out = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 0xff;
  return out;
}

/** RunLengthDecode：长度字节 0-127 原样复制、129-255 重复、128 结束。 */
function pdfRunLength(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i];
    i += 1;
    if (length === 128) break;
    if (length <= 127) {
      const count = length + 1;
      for (let k = 0; k < count && i < data.length; k += 1) out.push(data[i + k]);
      i += count;
      continue;
    }
    if (i >= data.length) break;
    const count = 257 - length;
    for (let k = 0; k < count; k += 1) out.push(data[i]);
    i += 1;
  }
  return Buffer.from(out);
}

/** LZWDecode（PDF 变体，9-12 位可变码长，256=Clear、257=EOD）。 */
function pdfLzw(data: Buffer, earlyChange: number): Buffer {
  const CLEAR = 256;
  const EOD = 257;
  const dictionaries: number[][] = [];
  const resetDictionary = (): void => {
    dictionaries.length = 0;
    for (let i = 0; i < 256; i += 1) dictionaries.push([i]);
    dictionaries.push([], []); // 占位 256 / 257
  };
  resetDictionary();

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeWidth = 9;
  let previous: number[] | null = null;
  let offset = 0;

  while (offset < data.length) {
    bitBuffer = (bitBuffer << 8) | data[offset];
    bitCount += 8;
    offset += 1;
    for (;;) {
      if (bitCount < codeWidth) break;
      const code = (bitBuffer >>> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;

      if (code === CLEAR) {
        resetDictionary();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === EOD) return Buffer.from(out);

      let entry: number[];
      if (code < dictionaries.length && dictionaries[code].length > 0) {
        entry = dictionaries[code];
      } else if (previous !== null && code === dictionaries.length) {
        entry = [...previous, previous[0]]; // KwKwK 情形
      } else {
        return Buffer.from(out); // 码流损坏：返回已解出的部分
      }
      out.push(...entry);
      if (previous !== null && dictionaries.length < 4096) {
        dictionaries.push([...previous, entry[0]]);
        // EarlyChange=1（默认）：字典满一档就提前加宽
        const threshold = (1 << codeWidth) - (earlyChange === 0 ? 0 : 1);
        if (dictionaries.length >= threshold && codeWidth < 12) codeWidth += 1;
      }
      previous = entry;
    }
  }
  return Buffer.from(out);
}

/** PNG 预测器（Predictor >= 10）：逐行按 filter type 反推。 */
function pdfUndoPngPredictor(data: Buffer, columns: number, colors: number, bits: number): Buffer | null {
  const rowLength = Math.ceil((colors * bits * columns) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
  if (rowLength <= 0) return null;
  const rowCount = Math.floor(data.length / (rowLength + 1));
  if (rowCount <= 0) return null;
  const out = Buffer.alloc(rowCount * rowLength);
  let previousRow = Buffer.alloc(rowLength);
  for (let row = 0; row < rowCount; row += 1) {
    const filterType = data[row * (rowLength + 1)];
    const source = data.subarray(row * (rowLength + 1) + 1, row * (rowLength + 1) + 1 + rowLength);
    const current = Buffer.alloc(rowLength);
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
      const up = previousRow[i];
      const upLeft = i >= bytesPerPixel ? previousRow[i - bytesPerPixel] : 0;
      const raw = source[i];
      let value: number;
      switch (filterType) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + Math.floor((left + up) / 2); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = raw + predictor;
          break;
        }
        default: return null; // 未知 filter type：宁可报错也不输出乱码
      }
      current[i] = value & 0xff;
    }
    current.copy(out, row * rowLength);
    previousRow = current;
  }
  return out;
}

/** TIFF 预测器（Predictor 2）：逐行水平差分。 */
function pdfUndoTiffPredictor(data: Buffer, columns: number, colors: number, bits: number): Buffer | null {
  if (bits !== 8) return null; // 只实现最常见的 8 位分量
  const rowLength = colors * columns;
  if (rowLength <= 0) return null;
  const out = Buffer.from(data);
  for (let start = 0; start + rowLength <= out.length; start += rowLength) {
    for (let i = colors; i < rowLength; i += 1) {
      out[start + i] = (out[start + i] + out[start + i - colors]) & 0xff;
    }
  }
  return out;
}

/** 单个过滤器解码；返回 null 表示失败。 */
function pdfApplyFilter(filter: PdfFilterName, data: Buffer, parms: string): Buffer | null | 'predictor-unsupported' {
  switch (filter) {
    case 'ASCII85Decode':
      return pdfAscii85(data);
    case 'ASCIIHexDecode':
      return pdfAsciiHex(data);
    case 'RunLengthDecode':
      return pdfRunLength(data);
    case 'LZWDecode': {
      const early = pdfParmsInt(parms, 'EarlyChange');
      return pdfLzw(data, early === null ? 1 : early);
    }
    case 'FlateDecode': {
      let inflated: Buffer | null = null;
      try {
        inflated = Buffer.from(inflateSync(data, { maxOutputLength: ZIP_MAX_ENTRY_BYTES }));
      } catch {
        try {
          inflated = Buffer.from(inflateRawSync(data, { maxOutputLength: ZIP_MAX_ENTRY_BYTES }));
        } catch {
          inflated = null;
        }
      }
      if (inflated === null) return null;
      const predictor = pdfParmsInt(parms, 'Predictor');
      if (predictor === null || predictor <= 1) return inflated;
      const columns = pdfParmsInt(parms, 'Columns') ?? 1;
      const colors = pdfParmsInt(parms, 'Colors') ?? 1;
      const bits = pdfParmsInt(parms, 'BitsPerComponent') ?? 8;
      const restored =
        predictor >= 10
          ? pdfUndoPngPredictor(inflated, columns, colors, bits)
          : predictor === 2
            ? pdfUndoTiffPredictor(inflated, columns, colors, bits)
            : null;
      // 预测器还原不了时明确上报，绝不把预测后的原始字节当文本输出（那是乱码）
      return restored ?? 'predictor-unsupported';
    }
    default:
      return null;
  }
}

/**
 * 按 `/Filter` 数组**从左到右**依次解码；未声明 Filter 时按原样返回。
 * 任何一环失败都返回 { data:null, warning }，让上层区分"读不了"与"没有文本层"。
 */
function decodePdfStream(
  dict: string,
  data: Buffer,
  streamLabel: number,
): PdfStreamDecoded {
  if (/\/Subtype\s*\/Image/.test(dict)) return { data: null, warning: null, skipped: true };

  const names = pdfFilters(dict);
  if (names.length === 0) return { data, warning: null, skipped: false };

  const parms = pdfDecodeParms(dict);
  let current = data;
  for (let i = 0; i < names.length; i += 1) {
    const normalized = PDF_FILTER_ALIASES[names[i].toLowerCase()];
    if (normalized === undefined || normalized === 'unsupported') {
      return { data: null, warning: `pdf-filter-unsupported:${names[i]}`, skipped: false };
    }
    const result = pdfApplyFilter(normalized, current, parms[i] ?? '');
    if (result === 'predictor-unsupported') {
      return { data: null, warning: `pdf-predictor-unsupported:${streamLabel}`, skipped: false };
    }
    if (result === null) {
      return { data: null, warning: `pdf-stream-decode-failed:${streamLabel}`, skipped: false };
    }
    current = result;
  }
  return { data: current, warning: null, skipped: false };
}

/** 文本操作符：`Tj` 的字符串、或 `TJ` 数组里的一项（数字代表字距）。 */
type PdfTextToken = { kind: 'text'; bytes: number[] } | { kind: 'gap'; amount: number } | { kind: 'line' };

/** 内容流操作数的两种形态（字符串 / 数字；TJ 数组单独收拢）。 */
type PdfOperand =
  | { kind: 'string'; bytes: number[] }
  | { kind: 'number'; value: number }
  | { kind: 'array'; items: Array<{ kind: 'string'; bytes: number[] } | { kind: 'number'; value: number }> };

const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const PDF_DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * 解析内容流里的文本操作符，按出现顺序输出 token（字符串 / 字距 / 换行）。
 * 只做语法层解析，字符码 → Unicode 的映射留到 decode 阶段。
 */
function pdfTextTokens(content: Buffer): PdfTextToken[] {
  const tokens: PdfTextToken[] = [];
  let operands: PdfOperand[] = [];
  let arrayItems: Array<{ kind: 'string'; bytes: number[] } | { kind: 'number'; value: number }> | null = null;
  let pendingLine = false;

  const flush = (operator: string): void => {
    // 换行信号先落 token：这样 `Td` 之后即使没有 show 操作符也已表达"换行"
    if (pendingLine) {
      tokens.push({ kind: 'line' });
      pendingLine = false;
    }
    if (operator === 'TJ') {
      const last = operands[operands.length - 1];
      if (last === undefined || last.kind !== 'array') return;
      for (const item of last.items) {
        if (item.kind === 'string') tokens.push({ kind: 'text', bytes: item.bytes });
        else tokens.push({ kind: 'gap', amount: item.value });
      }
      return;
    }
    for (let p = operands.length - 1; p >= 0; p -= 1) {
      const operand = operands[p];
      if (operand.kind === 'string') {
        tokens.push({ kind: 'text', bytes: operand.bytes });
        return;
      }
    }
  };

  let i = 0;
  const readLiteral = (start: number): { text: string; next: number } => {
    let p = start;
    let depth = 1;
    let out = '';
    while (p < content.length) {
      const byte = content[p];
      if (byte === 0x5c) {
        p += 1;
        const esc = content[p];
        p += 1;
        switch (esc) {
          case 0x6e: out += '\n'; break;
          case 0x72: out += '\r'; break;
          case 0x74: out += '\t'; break;
          case 0x62: out += '\b'; break;
          case 0x66: out += '\f'; break;
          case 0x0d: if (content[p] === 0x0a) p += 1; break;
          case 0x0a: break;
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              let oct = String.fromCharCode(esc);
              while (oct.length < 3 && content[p] >= 0x30 && content[p] <= 0x37) {
                oct += String.fromCharCode(content[p]);
                p += 1;
              }
              out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
            } else if (esc !== undefined) {
              out += String.fromCharCode(esc);
            }
        }
        continue;
      }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) {
          p += 1;
          break;
        }
      }
      out += String.fromCharCode(byte);
      p += 1;
    }
    return { text: out, next: p };
  };

  const readNumber = (start: number): { value: number; next: number } => {
    let p = start;
    let raw = '';
    while (p < content.length) {
      const byte = content[p];
      const char = String.fromCharCode(byte);
      if (/[0-9+\-.]/.test(char)) {
        raw += char;
        p += 1;
        continue;
      }
      break;
    }
    return { value: Number.parseFloat(raw), next: p };
  };

  while (i < content.length) {
    const byte = content[i];
    if (PDF_WHITESPACE.has(byte)) {
      i += 1;
      continue;
    }
    if (byte === 0x25) {
      while (i < content.length && content[i] !== 0x0a) i += 1;
      continue;
    }
    if (byte === 0x28) {
      const literal = readLiteral(i + 1);
      const bytes = Array.from(Buffer.from(literal.text, 'latin1'));
      if (arrayItems !== null) arrayItems.push({ kind: 'string', bytes });
      else operands.push({ kind: 'string', bytes });
      i = literal.next;
      continue;
    }
    if (byte === 0x3c && content[i + 1] !== 0x3c) {
      const close = content.indexOf('>', i + 1);
      const end = close < 0 ? content.length : close;
      let hex = '';
      for (let p = i + 1; p < end; p += 1) {
        const char = String.fromCharCode(content[p]);
        if (/[0-9a-fA-F]/.test(char)) hex += char;
      }
      if (hex.length % 2 === 1) hex += '0';
      const bytes: number[] = [];
      for (let p = 0; p + 1 < hex.length; p += 2) bytes.push(Number.parseInt(hex.slice(p, p + 2), 16) & 0xff);
      if (arrayItems !== null) arrayItems.push({ kind: 'string', bytes });
      else operands.push({ kind: 'string', bytes });
      i = (close < 0 ? content.length : close) + 1;
      continue;
    }
    if (byte === 0x5b) {
      arrayItems = []; // 进入 TJ 数组
      i += 1;
      continue;
    }
    if (byte === 0x5d) {
      if (arrayItems !== null) operands.push({ kind: 'array', items: arrayItems });
      arrayItems = null;
      i += 1;
      continue;
    }
    if (byte === 0x2f) {
      i += 1;
      while (i < content.length && !PDF_WHITESPACE.has(content[i]) && !PDF_DELIMITERS.has(content[i])) i += 1;
      continue;
    }
    if (/[0-9+\-.]/.test(String.fromCharCode(byte))) {
      const number = readNumber(i);
      if (Number.isFinite(number.value)) {
        if (arrayItems !== null) arrayItems.push({ kind: 'number', value: number.value });
        else operands.push({ kind: 'number', value: number.value });
      }
      i = Math.max(number.next, i + 1);
      continue;
    }
    if (/[A-Za-z*'"]/.test(String.fromCharCode(byte))) {
      let p = i;
      let operator = '';
      while (p < content.length && /[A-Za-z*'"]/.test(String.fromCharCode(content[p]))) {
        operator += String.fromCharCode(content[p]);
        p += 1;
      }
      i = p;
      if (operator === 'Tj' || operator === 'TJ' || operator === "'" || operator === '"') {
        if (arrayItems !== null) {
          operands.push({ kind: 'array', items: arrayItems });
          arrayItems = null;
        }
        flush(operator);
        continue;
      }
      // 换行类操作符留下一个换行信号，等下一个 show 操作符时再落 token
      if (operator === 'T*' || operator === 'Td' || operator === 'TD' || operator === 'TL') pendingLine = true;
      operands = [];
      // 注意：不要在这里清空 arrayItems —— `]` 已经把完整数组折成操作数，
      // 而数组未闭合时留着它比丢掉整段文本更接近"如实抽取"。
      continue;
    }
    i += 1;
  }
  return tokens;
}

/* ------------------------------ ToUnicode CMap ----------------------------- */

function hexToBytes(hex: string): number[] {
  let clean = '';
  for (let i = 0; i < hex.length; i += 1) {
    const char = hex[i];
    if (/[0-9a-fA-F]/.test(char)) clean += char;
  }
  if (clean.length % 2 === 1) clean += '0';
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(Number.parseInt(clean.slice(i, i + 2), 16) & 0xff);
  return bytes;
}

function bytesToCode(bytes: number[]): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/**
 * ToUnicode 的**目标**是 UTF-16BE 码元序列，不是 UTF-8 字节：
 * `<4E2D>` 表示 U+4E2D（"中"），按 UTF-8 解会得到 "N-" 这种乱码。
 */
function utf16BeToText(units: readonly number[]): string {
  let out = '';
  for (const unit of units) {
    if (unit < 0 || unit > 0xffff) continue;
    out += String.fromCharCode(unit);
  }
  return out;
}

/** `<4E2D>` → UTF-16 码元序列（两字节一组；奇数长度回落单字节）。 */
function hexToUtf16Units(hex: string): number[] {
  const bytes = hexToBytes(hex);
  if (bytes.length === 0) return [];
  if (bytes.length === 1) return [bytes[0]];
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push(bytes[i] * 256 + bytes[i + 1]);
  return units;
}

/**
 * 解析一段 ToUnicode CMap：`beginbfchar`（code → unicode）与
 * `beginbfrange`（lo..hi → dst 递增，或数组形式逐个指定）。
 */
function parseCMap(text: string, into: Map<number, string>): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  let i = 0;
  // 真实 CMap 的分节标记带条目数（`2 beginbfchar` / `1 beginbfrange`），
  // 用"以关键字结尾"匹配，兼容带计数与不带计数两种写法。
  const isSection = (line: string, keyword: string): boolean => line === keyword || line.endsWith(` ${keyword}`);
  while (i < lines.length) {
    const line = lines[i];
    if (isSection(line, 'beginbfchar')) {
      i += 1;
      while (i < lines.length && !isSection(lines[i], 'endbfchar')) {
        const match = /^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>$/.exec(lines[i]);
        if (match !== null) {
          const code = bytesToCode(hexToBytes(match[1]));
          const value = utf16BeToText(hexToUtf16Units(match[2]));
          if (value !== '') into.set(code, value);
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (isSection(line, 'beginbfrange')) {
      i += 1;
      while (i < lines.length && !isSection(lines[i], 'endbfrange')) {
        const match = /^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(.+)$/.exec(lines[i]);
        if (match !== null) {
          const lo = bytesToCode(hexToBytes(match[1]));
          const hi = bytesToCode(hexToBytes(match[2]));
          const destination = match[3].trim();
          const many = /^\[(.*)\]$/.exec(destination);
          if (many !== null) {
            const items = many[1].match(/<[0-9a-fA-F]*>/g) ?? [];
            items.forEach((item, offset) => {
              const target = lo + offset;
              if (target > hi) return;
              const value = utf16BeToText(hexToUtf16Units(item.slice(1, -1)));
              if (value !== '') into.set(target, value);
            });
          } else {
            const single = /^<([0-9a-fA-F]*)>$/.exec(destination);
            if (single !== null) {
              const base = hexToUtf16Units(single[1]);
              if (base.length > 0) {
                // 目标码元整体递增（<0041> + 1 → <0042>）
                for (let code = lo; code <= hi; code += 1) {
                  const shifted = base.slice();
                  shifted[shifted.length - 1] += code - lo;
                  const value = utf16BeToText(shifted);
                  if (value !== '') into.set(code, value);
                }
              }
            }
          }
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
}

interface PdfFontInfo {
  /** 是否出现过多字节（CID / Identity-H）字体 —— 决定按几个字节切一个字符码 */
  multiByte: boolean;
  /** 是否拿到至少一个可用的 ToUnicode 字符码映射 */
  hasCMap: boolean;
  /** 是否存在 WinAnsiEncoding 字体（单字节 0x80-0xFF 走 CP1252 表，而不是丢弃） */
  winAnsi: boolean;
  /** 从字体声明与 CMap 归集到的编码宽度（只为暴露判断依据，供调试） */
  charBytes: Array<'single' | 'multi'>;
}

/** 从页面的 /Font 资源里读 Type0 与 ToUnicode，建立字符码映射。 */
function inspectPdfFonts(buf: Buffer): PdfFontInfo {
  const latin = buf.toString('latin1');
  const streamIndex = new Map<string, number>();
  const objectPattern = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectPattern.exec(latin)) !== null) {
    streamIndex.set(`${objectMatch[1]} ${objectMatch[2]}`, objectMatch.index);
  }

  const charBytes: PdfFontInfo['charBytes'] = [];
  if (/\/Subtype\s*\/Type0/.test(latin)) charBytes.push('multi');
  if (/\/Encoding\s*\/Identity-[HV]/.test(latin)) charBytes.push('multi');
  const winAnsi = /\/Encoding\s*\/WinAnsiEncoding/.test(latin);

  let hasCMap = false;
  const cMapPattern = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/g;
  let cMapMatch: RegExpExecArray | null;
  while ((cMapMatch = cMapPattern.exec(latin)) !== null) {
    const bodyStart = streamIndex.get(`${cMapMatch[1]} ${cMapMatch[2]}`);
    if (bodyStart === undefined) continue;
    const keyword = findStreamKeyword(buf, bodyStart, buf.length);
    if (keyword < 0) continue;
    const start = streamDataStart(buf, keyword);
    const end = buf.indexOf(PDF_STRING_END, start, 'latin1');
    if (end < start) continue;
    let dataEnd = end;
    if (dataEnd > start && buf[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (dataEnd > start && buf[dataEnd - 1] === 0x0d) dataEnd -= 1;
    const data = buf.subarray(start, dataEnd);
    // ToUnicode CMap 本身也可能带过滤器链（通常只有 FlateDecode，但 ReportLab 类
    // 工具会写成 [ /ASCII85Decode /FlateDecode ]），统一走过滤器链解析。
    const decoded = decodePdfStream(pdfDictSnippet(buf, bodyStart, keyword), data, Number.parseInt(cMapMatch[1], 10));
    if (decoded.data === null) continue;
    const into = new Map<number, string>();
    parseCMap(decoded.data.toString('latin1'), into);
    if (into.size === 0) continue;
    hasCMap = true;
    PDF_GLOBAL_CMAP.push(into);
    for (const code of into.keys()) {
      if (code > 0xff) {
        charBytes.push('multi');
        break;
      }
    }
  }
  return { multiByte: charBytes.length > 0, hasCMap, winAnsi, charBytes };
}

/** 收集到的 CMap 映射（每次 extract 前清空）。 */
const PDF_GLOBAL_CMAP: Array<Map<number, string>> = [];

/** 一个字符码 → Unicode；找不到返回 null。 */
function pdfMapCode(code: number, cmaps: Array<Map<number, string>>): string | null {
  for (const cmap of cmaps) {
    const value = cmap.get(code);
    if (value !== undefined) return value;
  }
  return null;
}

/**
 * WinAnsiEncoding（CP1252）0x80-0x9F 段。0xA0-0xFF 与 Latin-1 完全一致，
 * 直接 fromCharCode 即可。未定义的码位（0x81/0x8D/0x8F/0x90/0x9D）返回 null。
 *
 * 为什么值得做：ReportLab / Word 等工具导出的 PDF 普遍声明
 * `/Encoding /WinAnsiEncoding`，其中的破折号（0x97）、间隔号（0xB7）等
 * 高位字节若一律丢弃，正文会出现"缺字"，还会误报 pdf-encoding-unmapped。
 */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
};

/** 单字节 WinAnsi 码位 → 字符；无法映射返回 null。 */
function winAnsiChar(code: number): string | null {
  if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code);
  const mapped = WIN_ANSI_HIGH[code];
  return mapped === undefined ? null : mapped;
}

interface PdfDecoded {
  text: string;
  unmapped: boolean;
}

/** 把一串字符码按 CMap 映射成文本；拿不到映射就丢弃（绝不把二进制码位当字符输出）。 */
function pdfDecodeBytes(bytes: number[], fonts: PdfFontInfo, cmaps: Array<Map<number, string>>): PdfDecoded {
  if (bytes.length === 0) return { text: '', unmapped: false };
  const width = fonts.multiByte && bytes.length % 2 === 0 ? 2 : 1;
  let text = '';
  let unmapped = false;
  for (let i = 0; i + width <= bytes.length; i += width) {
    const code = bytesToCode(bytes.slice(i, i + width));
    const mapped = pdfMapCode(code, cmaps);
    if (mapped !== null) {
      text += mapped;
      continue;
    }
    // 纯 ASCII（< 0x80）在所有常见编码里都是同一码位；高位字节按 WinAnsi 表
    // 再试一次，仍无解才丢弃（丢弃要高知：置 unmapped → pdf-encoding-unmapped）。
    if (code < 0x80) {
      text += String.fromCharCode(code);
      continue;
    }
    if (width === 1 && fonts.winAnsi) {
      const winAnsi = winAnsiChar(code);
      if (winAnsi !== null) {
        text += winAnsi;
        continue;
      }
    }
    unmapped = true;
  }
  return { text, unmapped };
}

function extractPdf(buf: Buffer): Extracted {
  if (buf.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') < 0) {
    return emptyExtracted('pdf-header-missing');
  }
  const latin = buf.toString('latin1');
  // /Type /Page 的出现次数只是**估算**（正则计数，不解析页树、不跟 /Kids）：允许不准
  const pageMatches = latin.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  const pages = pageMatches === null ? null : pageMatches.length;
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(latin) || /\/Encrypt\s*<</.test(latin)) {
    return {
      parts: [],
      meta: { pages, sheets: null, slides: null },
      warning: 'encrypted',
    };
  }

  PDF_GLOBAL_CMAP.length = 0;
  const streams = collectPdfStreams(buf);
  const fonts = inspectPdfFonts(buf);
  const cmaps = PDF_GLOBAL_CMAP;

  const parts: string[] = [];
  const failures: string[] = [];
  let sawTextOperator = false;
  let unmapped = false;
  let decodableStreams = 0;
  streams.forEach((stream, index) => {
    const decoded = decodePdfStream(stream.dict, stream.data, stream.objectNumber ?? index + 1);
    if (decoded.skipped) return; // 图片等非文本流：有意跳过
    if (decoded.warning !== null) {
      // 读不了的流要如实记账：否则会被误判成"这份 PDF 没有文本层"
      if (!failures.includes(decoded.warning)) failures.push(decoded.warning);
      return;
    }
    if (decoded.data === null) return;
    decodableStreams += 1;
    const tokens = pdfTextTokens(decoded.data);
    if (tokens.length === 0) return;

    // 一条内容流 → 一个片段：块内换行写进片段（行 token → '\n'），
    // 这样 `[(Hello) -250 (World)] TJ` 得到 "Hello World" 而不会被块间距拆散。
    const streamLines: string[] = [];
    let line = '';
    const endLine = (): void => {
      streamLines.push(line);
      line = '';
    };
    for (const token of tokens) {
      if (token.kind === 'text') {
        sawTextOperator = true;
        const chars = pdfDecodeBytes(token.bytes, fonts, cmaps);
        if (chars.unmapped) unmapped = true;
        line += chars.text;
        continue;
      }
      if (token.kind === 'gap') {
        // 负数代表字距：绝对值够大通常是词间空格（阈值是经验值，宁可多加空格）
        if (token.amount <= -100) line += ' ';
        continue;
      }
      if (line !== '') endLine();
    }
    if (line !== '') endLine();
    const streamText = streamLines.filter((text) => text.trim() !== '').join('\n');
    if (streamText !== '') parts.push(streamText);
  });

  if (!sawTextOperator) {
    // 没有任何文本操作符时还要分清两种情形：
    // - 所有流都读得动 → 确实是图片扫描件，没有文本层；
    // - 有流读不动（未知过滤器 / 解码失败）→ 只能说"读不了"，不能说"没有"。
    const warning =
      failures.length > 0 && decodableStreams === 0
        ? failures.join(',')
        : failures.length > 0
          ? [...failures, 'scanned-pdf-no-text-layer'].join(',')
          : 'scanned-pdf-no-text-layer';
    return {
      parts: [],
      meta: { pages, sheets: null, slides: null },
      warning,
    };
  }
  const warning = [unmapped ? 'pdf-encoding-unmapped' : null, ...failures]
    .filter((item): item is string => item !== null)
    .join(',');
  return {
    parts,
    meta: { pages, sheets: null, slides: null },
    warning: warning === '' ? null : warning,
  };
}

/* -------------------------------------------------------------------------- */
/* 纯文本类（csv / tsv / txt / md / json / html / xml / yaml / sql）             */
/* -------------------------------------------------------------------------- */

/** 剥离 UTF-8 BOM。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解码未知来源的文本：优先 UTF-8；替换字符比例过高时说明源不是 UTF-8
 * （GBK / Big5 等），退化为 latin1 保证"每个字节都有一个字符" —— 乱码比丢内容好排查。
 */
function decodeText(data: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  let replacements = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) replacements += 1;
  }
  if (replacements > 0 && replacements * 20 > text.length) return data.toString('latin1');
  return text;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  laquo: '\u00ab',
  raquo: '\u00bb',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  middot: '\u00b7',
  bull: '\u2022',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  times: '\u00d7',
  divide: '\u00f7',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = HTML_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

const HTML_BLOCK_TAGS =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|th|td|h[1-6]|section|article|header|footer|nav|aside|main|figure|figcaption|blockquote|pre|form|fieldset|address|details|summary|caption|colgroup|option|title|meta|link|style|script)\b[^>]*>/gi;

const HTML_TAGS = /<[^>]*>/g;

function extractHtml(text: string): Extracted {
  const cleaned = stripBom(text)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const withBreaks = cleaned
    .replace(HTML_BLOCK_TAGS, (tag) => (/^<br/i.test(tag) ? '\n' : tag === '' ? ' ' : '\n'))
    .replace(HTML_TAGS, ' ');
  return { parts: [decodeHtmlEntities(withBreaks)], meta: EMPTY_META, warning: null };
}

function extractJson(text: string): Extracted {
  const raw = stripBom(text).trim();
  try {
    const value: unknown = JSON.parse(raw);
    const pretty = JSON.stringify(value, null, 2);
    return { parts: [pretty ?? raw], meta: EMPTY_META, warning: null };
  } catch {
    return { parts: [raw], meta: EMPTY_META, warning: 'json-parse-failed' };
  }
}

/* -------------------------------------------------------------------------- */
/* 归一化与截断                                                                */
/* -------------------------------------------------------------------------- */

/** 去掉 NUL 与控制字符（保留 \t \n；它们随后参与空白折叠）。 */
function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x09 || code === 0x0a) {
      out += input[i];
      continue;
    }
    if (code === 0x0d) continue; // \r\n / \r 统一交给下一步
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += input[i];
  }
  return out;
}

/** 空白归一化：LF 统一、行尾空格去除、连续空行压缩到最多 1 个空行。 */
function normalizeText(input: string): string {
  const lines = stripControlChars(input).split('\n');
  const out: string[] = [];
  let blanks = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/, '');
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 1) continue;
      out.push('');
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  while (out.length > 0 && out[0] === '') out.shift();
  return out.join('\n');
}

/**
 * 把抽取片段拼成一段文本：整片留空的丢弃，片段之间空一行。
 * 有意保留片段内部的空行（代码缩进、表格分组都依赖它）；全局空行压缩交给
 * `normalizeText`，这样"行内结构"和"片段间距"各自只有一处规则。
 *
 * 调用方约定：**一个片段 = 一个逻辑块**（docx 一段 / 一张表、xlsx 一张表、
 * pptx 一张幻灯片、pdf 一条内容流）。块内的换行由抽取器自己写进片段，
 * 这样 `joinParts` 只需管块间距，不必猜"这个短片段是不是半句话"。
 */
function joinParts(parts: readonly string[]): string {
  let out = '';
  let seen = false;
  for (const part of parts) {
    if (part.trim() === '') continue;
    if (seen) out += '\n\n';
    out += part;
    seen = true;
  }
  return out;
}

function characters(text: string): number {
  return text.length;
}

/* -------------------------------------------------------------------------- */
/* 公共 API                                                                    */
/* -------------------------------------------------------------------------- */

function fail(warning: string, strategy = 'none'): ExtractResult {
  return {
    ok: false,
    text: '',
    truncated: false,
    strategy,
    meta: { pages: null, sheets: null, slides: null, characters: 0 },
    warning,
  };
}

/** 错误对象 → 简短、不含路径与二进制片段的原因串。 */
function shortReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/[\r\n]/, 1)[0] ?? '';
  const cleaned = firstLine
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/(?:[^\s'"/]+\/)+[^\s'"]*/g, '<path>')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned === '' ? 'extract-failed' : `extract-failed: ${cleaned}`;
}

/**
 * 按格式把二进制抽成纯文本。
 * **任何输入都不会抛异常**：未知格式、空数据、结构损坏一律返回 ok:false + warning。
 */
export function extractText(
  format: string,
  data: Buffer,
  options?: { maxChars?: number },
): ExtractResult {
  const normalized = normalizeFormat(format);
  try {
    if (!Buffer.isBuffer(data)) return fail('invalid-input-not-a-buffer');
    if (data.length === 0) return fail('empty-input');
    if (!FORMAT_SET.has(normalized)) return fail(`unsupported-format:${normalized === '' ? 'unknown' : normalized}`);

    let extracted: Extracted;
    let strategy: string;
    switch (normalized) {
      case 'pdf':
        strategy = STRATEGY_PDF;
        extracted = extractPdf(data);
        break;
      case 'docx':
        strategy = STRATEGY_OOXML;
        extracted = extractDocx(data);
        break;
      case 'xlsx':
        strategy = STRATEGY_OOXML;
        extracted = extractXlsx(data);
        break;
      case 'pptx':
        strategy = STRATEGY_OOXML;
        extracted = extractPptx(data);
        break;
      case 'html':
        strategy = STRATEGY_HTML;
        extracted = extractHtml(decodeText(data));
        break;
      case 'json':
        strategy = STRATEGY_JSON;
        extracted = extractJson(decodeText(data));
        break;
      default:
        strategy = PLAIN_FORMATS.has(normalized) ? STRATEGY_PLAIN : 'plain';
        extracted = { parts: [stripBom(decodeText(data))], meta: EMPTY_META, warning: null };
    }

    const text = normalizeText(joinParts(extracted.parts));
    const maxChars =
      typeof options?.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : DEFAULT_MAX_CHARS;
    const truncated = text.length > maxChars;
    const clipped = truncated ? text.slice(0, maxChars) : text;
    const meta: ExtractResult['meta'] = {
      pages: extracted.meta.pages ?? null,
      sheets: extracted.meta.sheets ?? null,
      slides: extracted.meta.slides ?? null,
      characters: characters(clipped),
    };

    // 一点文本都没抽到：区分"如实降级"（扫描件等，容器读得动、只是没文本层）
    // 与"真的失败"（加密 / 编码不可解 / 结构损坏）。
    if (clipped === '') {
      const warning = extracted.warning ?? `${normalized}-no-extractable-text`;
      const degraded = DEGRADED_WARNINGS.has(warning);
      return {
        ok: degraded,
        text: '',
        truncated: false,
        strategy,
        meta: { ...meta, characters: 0 },
        warning,
      };
    }

    return { ok: true, text: clipped, truncated, strategy, meta, warning: extracted.warning };
  } catch (error) {
    return fail(shortReason(error));
  }
}
