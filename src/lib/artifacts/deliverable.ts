/**
 * Deliverable Router —— **让运行时决定能生成什么文件，而不是让模型决定**。
 *
 * 背景（真实故障）：模型会对老板说「当前不支持生成 PDF 格式」「我无法生成图像文件」，
 * 而它其实只需要写内容。凡是把「系统能力」交给 LLM 判断的架构，都会出现这种
 * 能力被幻觉掉的问题。
 *
 * 因此这里做两件事，全部是确定性代码、零 LLM 参与：
 * 1. `detectDeliverables(message)`：从**用户原话**识别他要哪些文件；
 * 2. `buildDeliverable(format, …)`：把模型写好的 Markdown 转成真实文件字节。
 *
 * 模型只负责内容，格式由运行时兜底 —— 它没有资格说「我不支持」。
 */

import { writeDocument, writeTable, type DocSpec, type TableSpec } from '@/lib/artifacts/doc-writers';
import { parseMarkdownDocument, toDocSpec, type ParsedMarkdown } from '@/lib/artifacts/markdown-doc';
import { writePptx } from '@/lib/artifacts/pptx-writer';
import { discoverPdfFont, needsUnicodeFont, writePdf, type PdfFontInfo } from '@/lib/artifacts/pdf-writer';

export type DeliverableFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'csv'
  | 'md'
  | 'txt'
  | 'html'
  | 'json'
  | 'zip'
  | 'png';

export interface DeliverableRequest {
  format: DeliverableFormat;
  fileName: string;
  /** 触发它的原文片段（审计/调试用） */
  reason: string;
}

/** 表示「我想出一个文件」的动词（中英双语，容忍没有动词的裸格式请求） */
const ASK_VERB =
  /(生成|导出|做成|整理成|输出|写一?[份个]|来一?[份个]|给我|发我|要一?[份个]|做一个?|出一?[份个]|下载|下载一份|转成|保存为|打包|generate|export|make|create|produce|give me|send me|write up|save as|turn .* into|download)/i;

/** 明确要求「全部/所有格式/整套」 */
const BUNDLE_INTENT = /(全部格式|所有格式|各种格式|全套|一整套|打包|zip|all formats|every format|bundle)/i;

interface FormatRule {
  format: DeliverableFormat;
  pattern: RegExp;
  /** 生成文件名用的英文标签 */
  label: string;
  /** 裸格式词（没有动词也算请求），例如直接说 "pdf" */
  bare: boolean;
}

const FORMAT_RULES: FormatRule[] = [
  { format: 'pdf', pattern: /\bpdf\b|打印版|可打印/i, label: 'Report', bare: true },
  { format: 'docx', pattern: /\bword\b|\bdocx\b|word ?文档|可编辑文档/i, label: 'Report', bare: true },
  { format: 'pptx', pattern: /\bppt\b|\bpptx\b|幻灯片|演示文稿|汇报材料|slides?\b|\bdeck\b/i, label: 'Deck', bare: true },
  { format: 'xlsx', pattern: /\bexcel\b|\bxlsx\b|表格|数据表|spreadsheet/i, label: 'Data', bare: true },
  { format: 'csv', pattern: /\bcsv\b/i, label: 'Data', bare: true },
  { format: 'md', pattern: /\bmarkdown\b|\bmd\b/i, label: 'Report', bare: false },
  { format: 'html', pattern: /\bhtml\b|网页版|网页报告/i, label: 'Report', bare: false },
  { format: 'json', pattern: /\bjson\b/i, label: 'Data', bare: false },
  { format: 'txt', pattern: /纯文本|plain text|\btxt\b/i, label: 'Notes', bare: false },
];

const IMAGE_INTENT = /(海报|宣传图|配图|封面图|banner|poster|logo|生图|生成图|画一?[张幅个]|图片生成)/i;

/** 「要一份文档」但不指定格式时的意图词 */
const DOCUMENT_INTENT = /(报告|文档|方案|合同|总结|分析报告|report|document|proposal|contract|summary|write-?up|briefing)/i;

/** 把标题转成安全的文件名主体 */
export function slugifyTitle(title: string, max = 48): string {
  const cleaned = (title ?? '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Report';
  const ascii = cleaned.replace(/[^\w\u4e00-\u9fa5 -]/g, '').trim();
  const base = (ascii || cleaned).slice(0, max).trim();
  return base.replace(/\s+/g, '_') || 'Report';
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * 从用户原话识别要交付的文件。
 *
 * 规则（可解释、可单测）：
 * - 命中明确格式词 + （有请求动词，或该格式是「裸格式词」如 pdf/excel）→ 该格式
 * - 说了「报告/方案/文档」但没指定格式 → docx + pdf（老板对「一份报告」的默认预期）
 * - 说了「全部格式/打包」→ docx + pdf + xlsx + pptx + html 整套
 * - 命中海报/图片意图 → png（交由图像能力处理，失败要如实告知）
 * - 内容里出现表格但没要表格文件 → 报告类请求会附带 xlsx
 */
export function detectDeliverables(message: string): DeliverableRequest[] {
  const text = message ?? '';
  if (!text.trim()) return [];

  const hasVerb = ASK_VERB.test(text);
  const wantsBundle = BUNDLE_INTENT.test(text);
  const wantsImage = IMAGE_INTENT.test(text);
  const wantsDocument = DOCUMENT_INTENT.test(text);
  const requests: DeliverableRequest[] = [];
  const seen = new Set<DeliverableFormat>();

  const add = (format: DeliverableFormat, reason: string) => {
    if (seen.has(format)) return;
    seen.add(format);
    requests.push({
      format,
      fileName: `${slugifyTitle(slugFromMessage(text))}_${stamp()}.${format}`,
      reason,
    });
  };

  const matched: DeliverableFormat[] = [];
  for (const rule of FORMAT_RULES) {
    if (!rule.pattern.test(text)) continue;
    if (!hasVerb && !rule.bare) continue;
    matched.push(rule.format);
  }

  if (wantsBundle) {
    add('docx', 'bundle');
    add('pdf', 'bundle');
    add('xlsx', 'bundle');
    add('pptx', 'bundle');
    add('html', 'bundle');
  }

  for (const format of matched) add(format, 'explicit-format');

  // 「打包 / 压缩包 / zip」→ 把本次交付的文件合成一个归档
  if (/(打包|压缩包|\bzip\b|archive)/i.test(text) && hasVerb) {
    add('zip', 'archive-intent');
  }

  // 「要一份报告」但没给格式：默认给 Word + PDF（老板最常见的两个诉求）
  if (requests.filter((request) => request.format !== 'zip').length === 0 && wantsDocument && hasVerb) {
    add('docx', 'document-default');
    add('pdf', 'document-default');
  }

  if (wantsImage) add('png', 'image-intent');

  return requests;
}

/** 从用户原话里取一个像标题的片段做文件名 */
function slugFromMessage(message: string): string {
  const cleaned = message
    .replace(/^(请|帮我|麻烦|给我|我要|我想要|能不能|可以|能否)+/g, '')
    .replace(/(生成|导出|做成|整理成|输出|做一个?|出一?[份个]|下载|打包|转成)/g, ' ')
    .replace(/\b(pdf|docx|xlsx|pptx|csv|md|html|json|txt|word|excel|ppt|markdown)\b/gi, ' ')
    .replace(/(格式|文件|文档|报告)/g, '报告')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 40) || 'Report';
}

export interface DeliverableBuildInput {
  parsed: ParsedMarkdown;
  footer: string;
  /** 复用已发现的字体，避免每个文件都重新扫描磁盘 */
  font?: PdfFontInfo | null;
}

export type DeliverableBuild =
  | { ok: true; data: Buffer; mime: string; ext: string; warnings: string[] }
  | { ok: false; reason: string; message: string };

function bestTable(parsed: ParsedMarkdown): TableSpec[] {
  if (parsed.tables.length > 0) return parsed.tables;
  return [{ name: 'Sheet1', columns: ['Item', 'Detail'], rows: [] }];
}

/** 把 Markdown 文档转成指定格式的真实字节。绝不抛错，失败返回结构化原因。 */
export function buildDeliverable(
  format: DeliverableFormat,
  input: DeliverableBuildInput,
): DeliverableBuild {
  const { parsed, footer } = input;
  const doc: DocSpec = toDocSpec(parsed, footer);
  try {
    switch (format) {
      case 'docx': {
        const written = writeDocument('docx', doc);
        return { ok: true, ...written, warnings: [] };
      }
      case 'html': {
        const written = writeDocument('html', doc);
        return { ok: true, ...written, warnings: [] };
      }
      case 'md': {
        const written = writeDocument('md', doc);
        return { ok: true, ...written, warnings: [] };
      }
      case 'txt': {
        const written = writeDocument('txt', doc);
        return { ok: true, ...written, warnings: [] };
      }
      case 'json': {
        const written = writeDocument('json', doc);
        return { ok: true, ...written, warnings: [] };
      }
      case 'xlsx': {
        const written = writeTable('xlsx', bestTable(parsed), { title: parsed.title ?? undefined });
        return { ok: true, ...written, warnings: [] };
      }
      case 'csv': {
        const written = writeTable('csv', bestTable(parsed), { title: parsed.title ?? undefined });
        return { ok: true, ...written, warnings: [] };
      }
      case 'pptx': {
        const written = writePptx(parsed);
        return { ok: true, ...written, warnings: [] };
      }
      case 'pdf': {
        const font = input.font !== undefined ? input.font : discoverPdfFont();
        const plainText = [
          doc.title ?? '',
          doc.subtitle ?? '',
          ...doc.sections.flatMap((section) => [
            section.heading ?? '',
            ...(section.paragraphs ?? []),
            ...(section.bullets ?? []),
          ]),
        ].join('\n');

        if (!font && needsUnicodeFont(plainText)) {
          // 没有可用字体时不产出「豆腐块 PDF」——如实说明并让调用方降级
          return {
            ok: false,
            reason: 'pdf_font_unavailable',
            message:
              'Chinese text needs an embedded font for PDF. Put a .ttf under public/fonts/ '
              + '(or set RF_PDF_FONT) and PDF export will work.',
          };
        }
        const written = writePdf(doc, { font, watermark: footer });
        const warnings = written.requiresUnicodeFont ? ['pdf_partial_glyph_coverage'] : [];
        return {
          ok: true,
          data: written.data,
          mime: written.mime,
          ext: written.ext,
          warnings,
        };
      }
      default:
        return { ok: false, reason: 'unsupported_format', message: `unsupported deliverable: ${format}` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'build_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 供上层复用：把一段 Markdown 解析成文档结构 */
export function parseForDeliverable(markdown: string, fallbackTitle: string): ParsedMarkdown {
  return parseMarkdownDocument(markdown, fallbackTitle);
}
