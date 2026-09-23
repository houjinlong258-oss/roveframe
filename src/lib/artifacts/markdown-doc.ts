/**
 * Markdown → 文档结构。
 *
 * 这是「产物由运行时决定」的关键一环：不管模型写成什么样，我们都把它输出的
 * Markdown 解析成结构化的 DocSpec / TableSpec，再交给零依赖写入器生成
 * docx / pdf / xlsx / pptx / html。
 *
 * 因此模型**不需要**知道任何格式细节，也不再有资格说「我不支持生成 PDF」。
 *
 * 纯函数，无 IO，可直接单测。
 */

import type { DocSection, DocSpec, TableSpec } from '@/lib/artifacts/doc-writers';

export interface ParsedMarkdown {
  title: string | null;
  subtitle: string | null;
  sections: DocSection[];
  /** 文档里出现的全部表格（供 xlsx / csv 使用，按出现顺序） */
  tables: TableSpec[];
}

/** 去掉 markdown 行内标记，保留可读文字 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+$/g, '')
    .trim();
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const FENCE = /^\s*```/;

/** 解析一行 Markdown 表格为单元格数组 */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '\\' && inner[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(stripInlineMarkdown(current));
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(stripInlineMarkdown(current));
  return cells;
}

/**
 * 把模型输出的 Markdown 解析成文档结构。
 * - 首个 `# ` 作为标题；紧随其后的非标题短行可作为副标题
 * - `## ` 开新小节，`### ` 及更深作为小节内的加粗小标题行
 * - 列表 → bullets，表格 → 真实表格，代码围栏内容 → 等宽段落（去掉围栏标记）
 * - 超长表格（> 60 行）截断，避免产物失控
 */
export function parseMarkdownDocument(markdown: string, fallbackTitle = 'Report'): ParsedMarkdown {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections: DocSection[] = [];
  const tables: TableSpec[] = [];

  let title: string | null = null;
  let subtitle: string | null = null;
  let current: DocSection | null = null;
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];
  let tableBuffer: string[] = [];

  const ensureSection = (heading?: string): DocSection => {
    if (!current) {
      current = { heading, paragraphs: [], bullets: [] };
      sections.push(current);
      return current;
    }
    if (heading) {
      current = { heading, paragraphs: [], bullets: [] };
      sections.push(current);
    }
    return current;
  };

  const flushParagraph = () => {
    const text = stripInlineMarkdown(paragraph.join(' '));
    if (text) {
      const section = ensureSection();
      section.paragraphs = [...(section.paragraphs ?? []), text];
    }
    paragraph = [];
  };

  const flushBullets = () => {
    if (bullets.length > 0) {
      const section = ensureSection();
      section.bullets = [...(section.bullets ?? []), ...bullets];
    }
    bullets = [];
  };

  const flushTable = (): void => {
    if (tableBuffer.length < 2) {
      tableBuffer = [];
      return;
    }
    const headerLine = tableBuffer[0];
    const bodyLines = tableBuffer.slice(TABLE_SEPARATOR.test(tableBuffer[1] ?? '') ? 2 : 1);
    const columns = splitTableRow(headerLine);
    const rows = bodyLines
      .map((line) => splitTableRow(line))
      .filter((cells) => cells.some((cell) => cell.length > 0))
      .slice(0, 60)
      .map((cells) => columns.map((_, index) => cells[index] ?? ''));
    if (columns.length === 0) {
      tableBuffer = [];
      return;
    }
    const sheet: TableSpec = {
      name: `Table ${tables.length + 1}`,
      columns,
      rows,
    };
    tables.push(sheet);
    ensureSection().table = sheet;
    tableBuffer = [];
  };

  const flushFence = () => {
    const content = fenceLines.join('\n').trim();
    fenceLines = [];
    if (!content) return;
    const section = ensureSection();
    section.paragraphs = [...(section.paragraphs ?? []), content];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (FENCE.test(line)) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        flushParagraph();
        flushBullets();
        flushTable();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (TABLE_ROW.test(line)) {
      flushParagraph();
      flushBullets();
      tableBuffer.push(line);
      continue;
    }
    if (tableBuffer.length > 0) flushTable();

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushBullets();
      const level = heading[1].length;
      const text = stripInlineMarkdown(heading[2]);
      if (level === 1 && !title) {
        title = text;
        continue;
      }
      ensureSection(level === 2 ? text : `— ${text}`);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(stripInlineMarkdown(bullet[2]));
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushBullets();
      continue;
    }

    // 标题之后紧跟的短行，且还没有任何正文 → 视作副标题
    if (title && !subtitle && sections.length === 0 && paragraph.length === 0 && line.length <= 120) {
      subtitle = stripInlineMarkdown(line);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inFence) flushFence();
  flushParagraph();
  flushBullets();
  flushTable();

  const withTable = sections.filter(
    (section) =>
      (section.paragraphs?.length ?? 0) > 0
      || (section.bullets?.length ?? 0) > 0
      || section.table,
  );

  return {
    title: title ?? fallbackTitle,
    subtitle,
    sections: withTable.length > 0 ? withTable : [{ paragraphs: [stripInlineMarkdown(markdown).slice(0, 4000)] }],
    tables,
  };
}

/** 从 Markdown 里抽出所有「## 小节」作为幻灯片页（供 PPTX 使用） */
export function toSlides(parsed: ParsedMarkdown): Array<{ title: string; bullets: string[]; paragraphs: string[] }> {
  const slides: Array<{ title: string; bullets: string[]; paragraphs: string[] }> = [];
  if (parsed.subtitle || parsed.title) {
    slides.push({
      title: parsed.title ?? 'Report',
      bullets: parsed.subtitle ? [parsed.subtitle] : [],
      paragraphs: [],
    });
  }
  for (const section of parsed.sections) {
    slides.push({
      title: section.heading ?? parsed.title ?? 'Report',
      bullets: section.bullets ?? [],
      paragraphs: (section.paragraphs ?? []).slice(0, 6),
    });
  }
  return slides.slice(0, 40);
}

/** 组装 DocSpec（补上页脚署名） */
export function toDocSpec(parsed: ParsedMarkdown, footer: string): DocSpec {
  return {
    title: parsed.title ?? undefined,
    subtitle: parsed.subtitle ?? undefined,
    sections: parsed.sections,
    footer,
  };
}
