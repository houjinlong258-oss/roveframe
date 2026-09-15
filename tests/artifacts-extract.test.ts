/**
 * extract.ts 单元测试（doc-writers 的逆向）。
 *
 * 关键约定：**测试样本全部在内存里现造**，不往仓库塞任何二进制夹具。
 * - docx / xlsx 直接用 doc-writers 的写入器生成（写入 → 读出闭环）；
 * - pptx 用测试内自带的「最小 ZIP writer」（deflateRawSync + local header +
 *   central directory + EOCD）手工拼装；
 * - pdf 用测试内的 buildPdf 手工拼装（真实 xref + trailer），分别覆盖
 *   未压缩内容流、FlateDecode 内容流、扫描件（无文本操作符）、Identity-H
 *   有 / 无 ToUnicode CMap 五种形态。
 *
 * 同时覆盖：纯文本类格式、空白归一化与控制字符剥离、maxChars 截断、
 * 未知格式 / 空输入 / 随机字节都不抛错、canExtract 正反例。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  writeDocument,
  writeTable,
  crc32,
  type DocSpec,
  type TableSpec,
} from '../src/lib/artifacts/doc-writers';
import {
  DEFAULT_MAX_CHARS,
  canExtract,
  extractText,
  type ExtractibleFormat,
  type ExtractResult,
} from '../src/lib/artifacts/extract';

/* -------------------------------------------------------------------------- */
/* 测试辅助：最小 ZIP writer（只给 pptx 用；docx/xlsx 由 doc-writers 负责）      */
/* -------------------------------------------------------------------------- */

interface TestZipEntry {
  name: string;
  data: Buffer;
}

/** 与 doc-writers 的 writer 独立的极简 ZIP 打包（deflateRaw + 两个目录）。 */
function buildTestZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* -------------------------------------------------------------------------- */
/* 测试辅助：手工拼装 PDF                                                       */
/* -------------------------------------------------------------------------- */

interface PdfObject {
  /** 对象体（不含 `N 0 obj` / `endobj`） */
  body: string;
}

/** 拼一个语法完整（含 xref / trailer）的最小 PDF；对象体是 latin1 字节串。 */
function buildPdf(objects: PdfObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(offset);
    const text = `${index + 1} 0 obj\n${object.body}\nendobj\n`;
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  });

  const xrefStart = offset;
  const lines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const entry of offsets) lines.push(`${String(entry).padStart(10, '0')} 00000 n `);
  lines.push('trailer', `<< /Size ${objects.length + 1} /Root 1 0 R >>`, 'startxref', String(xrefStart), '%%EOF', '');
  chunks.push(Buffer.from(lines.join('\n'), 'latin1'));

  return Buffer.concat(chunks);
}

/** 页面对象：引用内容流 `contentId`。 */
function pageObject(contentId: number, extra = ''): PdfObject {
  return { body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ${extra}>>` };
}

/** 未压缩内容流对象。 */
function contentObject(content: string): PdfObject {
  return { body: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream` };
}

const PAGES_OBJECT: PdfObject = { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' };
const CATALOG_OBJECT: PdfObject = { body: '<< /Type /Catalog /Pages 2 0 R >>' };

/* -------------------------------------------------------------------------- */
/* 测试样本：docx / xlsx                                                        */
/* -------------------------------------------------------------------------- */

const DOC_SPEC: DocSpec = {
  title: '蜀香阁 9 月经营复盘',
  subtitle: '由 AI COO 自动汇总',
  sections: [
    {
      heading: '一、营收概况',
      paragraphs: ['本月总营收 38.2 万元，环比增长 6.4%，其中堂食占比 72%。'],
      bullets: ['宫保鸡丁连续三周销量第一', '周末翻台率提升到 2.3 次', '外卖客单价下滑 4 元'],
    },
    {
      heading: '二、重点菜品',
      table: {
        name: 'Top 菜品',
        columns: ['产品', '销量', '金额'],
        rows: [
          ['宫保鸡丁', 412, 38],
          ['麻婆豆腐', 308, 26],
        ],
      },
    },
  ],
  footer: 'Generated by RoveFrame AI COO',
};

const SHEETS: TableSpec[] = [
  {
    name: '销售明细',
    columns: ['产品', '销量', '金额'],
    rows: [
      ['宫保鸡丁', 412, 38],
      ['麻婆豆腐', 308, 26],
    ],
  },
  {
    name: '库存预警',
    columns: ['原料', '剩余', '状态'],
    rows: [['花椒', 3, '不足']],
  },
];

/* -------------------------------------------------------------------------- */

describe('extractText / docx', () => {
  test('写入器生成的 docx 能抽回标题、段落、列表与表格', () => {
    const file = writeDocument('docx', DOC_SPEC);
    const result = extractText('docx', file.data);

    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.strategy, 'ooxml-xml');
    assert.equal(result.truncated, false);
    assert.ok(result.meta.characters > 0, 'meta.characters 应大于 0');
    assert.equal(result.meta.pages, null);

    assert.match(result.text, /蜀香阁 9 月经营复盘/);
    assert.match(result.text, /由 AI COO 自动汇总/);
    assert.match(result.text, /本月总营收 38\.2 万元/);
    assert.match(result.text, /宫保鸡丁连续三周销量第一/);
    // 表格 → 竖线分隔
    assert.match(result.text, /产品 \| 销量 \| 金额/);
    assert.match(result.text, /宫保鸡丁 \| 412 \| 38/);
    assert.match(result.text, /麻婆豆腐 \| 308 \| 26/);
    // 标题样式还原成 markdown 标题
    assert.match(result.text, /^# 蜀香阁 9 月经营复盘$/m);
  });

  test('带页脚部件的 docx 抽取正文，并在 warning 里说明忽略了页眉页脚', () => {
    const file = writeDocument('docx', { ...DOC_SPEC, footer: '内部资料 请勿外传' });
    const result = extractText('docx', file.data);
    assert.equal(result.ok, true);
    // 页脚部件按设计忽略：文本里不应出现页脚内容，但必须如实告知
    assert.doesNotMatch(result.text, /内部资料 请勿外传/);
    assert.equal(result.warning, 'docx-headers-footers-skipped');
  });

  test('抽不到 document.xml 的 docx 返回 ok:false，不抛错', () => {
    const zip = buildTestZip([{ name: 'hello.txt', data: Buffer.from('nothing here', 'utf8') }]);
    const result = extractText('docx', zip);
    assert.equal(result.ok, false);
    assert.equal(result.warning, 'docx-no-document-xml');
  });
});

describe('extractText / xlsx', () => {
  test('两个工作表都抽到，含 ## Sheet: 段与单元格内容', () => {
    const file = writeTable('xlsx', SHEETS);
    const result = extractText('xlsx', file.data);

    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.strategy, 'ooxml-xml');
    assert.deepEqual(result.meta.sheets, ['销售明细', '库存预警']);
    assert.equal(result.meta.sheets?.length, 2);

    const sheetHeaders = result.text.match(/^## Sheet: .+$/gm) ?? [];
    assert.equal(sheetHeaders.length, 2);
    assert.match(result.text, /## Sheet: 销售明细/);
    assert.match(result.text, /## Sheet: 库存预警/);
    assert.match(result.text, /产品 \| 销量 \| 金额/);
    assert.match(result.text, /宫保鸡丁 \| 412 \| 38/);
    assert.match(result.text, /花椒 \| 3 \| 不足/);
  });

  test('sharedStrings 与 inlineStr 两种字符串都能抽（手工构造的工作簿）', () => {
    const shared = '<?xml version="1.0"?><sst><si><t>产品</t></si><si><t>宫保鸡丁</t></si></sst>';
    const sheet =
      '<?xml version="1.0"?><worksheet><sheetData><row r="1">' +
      '<c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c>' +
      '</row><row r="2">' +
      '<c r="A2" t="s"><v>1</v></c><c r="B2"><v>412</v></c>' +
      '</row></sheetData></worksheet>';
    const workbook = '<?xml version="1.0"?><workbook><sheets><sheet name="明细" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const rels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const zip = buildTestZip([
      { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(shared, 'utf8') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
    ]);

    const result = extractText('xlsx', zip);
    assert.equal(result.ok, true);
    assert.deepEqual(result.meta.sheets, ['明细']);
    assert.match(result.text, /产品 \| 销量/);
    assert.match(result.text, /宫保鸡丁 \| 412/);
  });
});

describe('extractText / pptx', () => {
  test('按 slide 序号排序抽 a:t 文本，meta.slides 计数正确', () => {
    const slide = (lines: string[]): Buffer =>
      Buffer.from(
        `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${lines
          .map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp>`)
          .join('')}</p:spTree></p:cSld></p:sld>`,
        'utf8',
      );
    // 故意乱序写入 slide10 与 slide2，验证是按数字而不是字典序排的
    const zip = buildTestZip([
      { name: 'ppt/slides/slide10.xml', data: slide(['第十章：附录']) },
      { name: 'ppt/slides/slide2.xml', data: slide(['第二页：本月营收', '环比增长 6.4%']) },
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    ]);

    const result = extractText('pptx', zip);
    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'ooxml-xml');
    assert.equal(result.meta.slides, 2);
    assert.match(result.text, /## Slide 1\n第二页：本月营收\n环比增长 6\.4%/);
    assert.match(result.text, /## Slide 2\n第十章：附录/);
  });

  test('没有 slide 部件的 pptx 返回 ok:false', () => {
    const zip = buildTestZip([{ name: 'ppt/presentation.xml', data: Buffer.from('<p/>', 'utf8') }]);
    const result = extractText('pptx', zip);
    assert.equal(result.ok, false);
    assert.equal(result.warning, 'pptx-no-slides');
  });
});

describe('extractText / pdf', () => {
  test('未压缩内容流的 (Hello World) Tj', () => {
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      contentObject('BT /F1 24 Tf 72 712 Td (Hello World) Tj ET'),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.strategy, 'pdf-text-operators');
    assert.equal(result.truncated, false);
    assert.equal(result.warning, null);
    assert.equal(result.text, 'Hello World');
    assert.equal(result.meta.pages, 1, '/Type /Page 估算页数应为 1');
    assert.equal(result.meta.characters, 'Hello World'.length);
  });

  test('支持 TJ 数组、字距、转义与八进制、hex 字符串、多行', () => {
    const content = [
      'BT /F1 12 Tf',
      '[(Hello) -250 (World)] TJ',
      '(line two) Tj',
      'T* (tab\\tend) Tj',
      'T* (paren\\(x\\) and \\101) Tj',
      'T* <48656C6C6F> Tj',
      'ET',
    ].join('\n');
    const pdf = buildPdf([CATALOG_OBJECT, PAGES_OBJECT, pageObject(4), contentObject(content)]);
    const result = extractText('pdf', pdf);

    assert.equal(result.ok, true);
    assert.match(result.text, /Hello World/);
    assert.match(result.text, /line two/);
    assert.match(result.text, /tab\tend/);
    assert.match(result.text, /paren\(x\) and A/); // \101 是八进制 A
    assert.match(result.text, /Hello/);
  });

  test('FlateDecode 压缩内容流（inflate 路径）', () => {
    const content = 'BT /F1 24 Tf 72 712 Td (Flate Hello World) Tj ET';
    const compressed = deflateRawSync(Buffer.from(content, 'latin1'));
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      {
        body: `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`,
      },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.strategy, 'pdf-text-operators');
    assert.match(result.text, /Flate Hello World/);
    assert.equal(result.meta.pages, 1);
  });

  test('没有文本层的扫描件 PDF → ok:true + scanned-pdf-no-text-layer', () => {
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4, '/Resources << /XObject << /Im0 5 0 R >> >>'),
      { body: '<< /Length 0 >>\nstream\n\nendstream' },
      { body: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 >>\nstream\n\xFF\xD8\xFF\xD9\nendstream' },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, '抽取本身成功，只是没有文本层');
    assert.equal(result.text, '');
    assert.equal(result.warning, 'scanned-pdf-no-text-layer');
    assert.equal(result.strategy, 'pdf-text-operators');
    assert.equal(result.meta.pages, 1);
    assert.equal(result.meta.characters, 0);
  });

  test('Identity-H + ToUnicode CMap：字形码被正确映射回 Unicode', () => {
    const cmap =
      '/CIDInit /ProcSet findresource begin\n' +
      '12 dict begin\n' +
      'begincmap\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '2 beginbfchar\n<1000> <4E2D>\n<1001> <6587>\nendbfchar\n' +
      '1 beginbfrange\n<1002> <1003> <0041>\nendbfrange\n' +
      'endcmap\nend\nend';
    const cmapCompressed = deflateRawSync(Buffer.from(cmap, 'latin1'));

    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4, '/Resources << /Font << /F1 5 0 R >> >>'),
      contentObject('BT /F1 12 Tf 72 712 Td <10001001> Tj T* <10021003> Tj ET'),
      { body: '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>' },
      { body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>' },
      { body: `<< /Length ${cmapCompressed.length} /Filter /FlateDecode >>\nstream\n${cmapCompressed.toString('latin1')}\nendstream` },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.warning, null);
    assert.match(result.text, /中文/);
    assert.match(result.text, /AB/, 'bfrange 应生成 A、B');
    assert.match(result.text, /^中文$/m, '两个字形码应落在同一行');
  });

  test('Identity-H 但没有 ToUnicode：不输出二进制码位，warning 为 pdf-encoding-unmapped', () => {
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4, '/Resources << /Font << /F1 5 0 R >> >>'),
      contentObject('BT /F1 12 Tf 72 712 Td <81408141> Tj ET'),
      { body: '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] >>' },
      { body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test >>' },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, false, '一个可读字符都没有时不应谎报成功');
    assert.equal(result.warning, 'pdf-encoding-unmapped');
    assert.equal(result.text, '');
    assert.doesNotMatch(result.text, /\uFFFD/);
  });

  test('加密 PDF 返回 encrypted，并尽量保留页数', () => {
    const objectCount = 5;
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      contentObject('BT (secret) Tj ET'),
      { body: '<< /Filter /Standard /V 2 /R 3 /O (x) /U (y) >>' },
    ]);
    const withTrailer = Buffer.concat([
      pdf,
      Buffer.from('trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n', 'latin1'),
    ]);

    const result = extractText('pdf', withTrailer);
    assert.equal(result.ok, false);
    assert.equal(result.warning, 'encrypted');
    assert.equal(result.meta.pages, 1, `页数估算应可用（对象数 ${objectCount}）`);
  });
});

/* -------------------------------------------------------------------------- */
/* PDF 过滤器链（真实 PDF 的关键路径）                                          */
/* -------------------------------------------------------------------------- */

/** ASCII85 编码（测试专用编码器，与抽取器的解码方向相反）。 */
function encodeAscii85(data: Buffer): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const end = Math.min(i + 4, data.length);
    const chunk = data.subarray(i, end);
    if (chunk.length === 4 && chunk.every((byte) => byte === 0)) {
      out += 'z';
      continue;
    }
    const padded = Buffer.alloc(4);
    chunk.copy(padded);
    let value = padded.readUInt32BE(0);
    const digits: string[] = [];
    for (let k = 0; k < 5; k += 1) {
      digits.unshift(String.fromCharCode(0x21 + (value % 85)));
      value = Math.floor(value / 85);
    }
    // 最后一个不满 4 字节的组只输出 n+1 个字符
    out += digits.slice(0, chunk.length + 1).join('');
  }
  return `${out}~>`;
}

/** 把 9 位码打包成 PDF LZW 码流（测试专用；码表不超 511，宽度恒为 9）。 */
function pack9BitCodes(codes: number[]): Buffer {
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const code of codes) {
    bitBuffer = (bitBuffer << 9) | (code & 0x1ff);
    bitCount += 9;
    while (bitCount >= 8) {
      out.push((bitBuffer >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  if (bitCount > 0) out.push((bitBuffer << (8 - bitCount)) & 0xff);
  return Buffer.from(out);
}

/** 用纯字面量码把内容流编码成 LZW（CLEAR + 各字节 + EOD）。 */
function encodeLzwLiterals(content: string): Buffer {
  const bytes = Array.from(Buffer.from(content, 'latin1'));
  return pack9BitCodes([256, ...bytes, 257]);
}

/** 带自定义 Filter / DecodeParms 的内容流对象。 */
function filteredContentObject(filter: string, payload: Buffer, parms?: string): PdfObject {
  const dict = `/Filter ${filter}${parms === undefined ? '' : ` /DecodeParms ${parms}`}`;
  return { body: `<< /Length ${payload.length} ${dict} >>\nstream\n${payload.toString('latin1')}\nendstream` };
}

/** PNG Up 预测器编码：每行前面加 filter type 2，行内做上行差分。 */
function encodePngUp(rows: string[], rowLength: number): Buffer {
  const parts: Buffer[] = [];
  let previous = Buffer.alloc(rowLength);
  for (const row of rows) {
    const raw = Buffer.alloc(rowLength);
    Buffer.from(row, 'latin1').copy(raw);
    const encoded = Buffer.alloc(rowLength);
    for (let i = 0; i < rowLength; i += 1) encoded[i] = (raw[i] - previous[i]) & 0xff;
    parts.push(Buffer.from([2]), encoded);
    previous = raw;
  }
  return Buffer.concat(parts);
}

describe('extractText / pdf 过滤器链', () => {
  test('[ /ASCII85Decode /FlateDecode ] 两级过滤的 PDF 能抽出文本（真实 ReportLab 形态）', () => {
    const content = 'BT /F1 24 Tf 72 712 Td (Hello ASCII85) Tj ET';
    // 编码方向与解码相反：先 deflate，再 ASCII85
    const payload = Buffer.from(encodeAscii85(deflateRawSync(Buffer.from(content, 'latin1'))), 'latin1');
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('[ /ASCII85Decode /FlateDecode ]', payload),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.warning, null);
    assert.equal(result.strategy, 'pdf-text-operators');
    assert.match(result.text, /Hello ASCII85/);
  });

  test('/LZWDecode 的 PDF 能抽出文本（含码表回引用的 KwKwK 情形）', () => {
    // 纯字面量编码
    const literal = 'BT /F1 12 Tf 72 712 Td (LZW literal) Tj ET';
    const literalPdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('/LZWDecode', encodeLzwLiterals(literal)),
    ]);
    const literalResult = extractText('pdf', literalPdf);
    assert.equal(literalResult.ok, true, `应有 ok:true（warning=${String(literalResult.warning)}）`);
    assert.match(literalResult.text, /LZW literal/);

    // 手工码流：CLEAR、'B','T',' ','(','A','B'、回引用 262（= 前面建出的 "AB"）、
    // ')',' ','T','j',' ','E','T'、EOD
    // → 解出来正好是 "BT (ABAB) Tj ET"，覆盖码表回引用分支
    const backReference = pack9BitCodes([256, 66, 84, 32, 40, 65, 66, 262, 41, 32, 84, 106, 32, 69, 84, 257]);
    const backRefPdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('/LZWDecode', backReference),
    ]);
    const backRefResult = extractText('pdf', backRefPdf);
    assert.equal(backRefResult.ok, true, `应有 ok:true（warning=${String(backRefResult.warning)}）`);
    assert.equal(backRefResult.text, 'ABAB', '回引用应拼出 "AB"+"AB"');
  });

  test('[ /ASCIIHexDecode /FlateDecode ] 的 PDF 能抽出文本', () => {
    const content = 'BT /F1 24 Tf 72 712 Td (Hello ASCIIHex) Tj ET';
    const payload = Buffer.from(`${deflateRawSync(Buffer.from(content, 'latin1')).toString('hex')}>`, 'latin1');
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('[ /ASCIIHexDecode /FlateDecode ]', payload),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.match(result.text, /Hello ASCIIHex/);
  });

  test('/RunLengthDecode 的 PDF 能抽出文本', () => {
    const content = 'BT /F1 24 Tf 72 712 Td (Hello RunLength) Tj ET';
    const bytes = Buffer.from(content, 'latin1');
    // 全量字面量段：长度字节 = n-1，随后 n 字节原文，最后 128 结束
    const payload = Buffer.concat([Buffer.from([bytes.length - 1]), bytes, Buffer.from([128])]);
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('/RunLengthDecode', payload),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.match(result.text, /Hello RunLength/);
  });

  test('/DecodeParms 的 PNG 预测器（Predictor 12）被正确还原', () => {
    const content = 'BT (Pred) Tj ET '; // 恰好 16 字节 = 2 行 × 8 列
    const rows = [content.slice(0, 8), content.slice(8, 16)];
    const encoded = encodePngUp(rows, 8);
    const payload = deflateRawSync(encoded);
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('/FlateDecode', payload, '<< /Predictor 12 /Columns 8 >>'),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true, `应有 ok:true（warning=${String(result.warning)}）`);
    assert.equal(result.warning, null, '预测器还原成功不应有 warning');
    assert.match(result.text, /Pred/);
    assert.doesNotMatch(result.text, /[\u0080-\u00ff]/, '预测器没还原干净会留下高位字节乱码');
  });

  test('预测器无法还原时如实报警，绝不输出乱码', () => {
    // PNG 预测器的 filter type 只定义到 4；这里给 9，必须拒绝还原
    const rowLength = 8;
    const bogus = Buffer.concat([Buffer.from([9]), Buffer.from('BT (X) T', 'latin1')].slice(0, rowLength + 1));
    const payload = deflateRawSync(bogus);
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      filteredContentObject('/FlateDecode', payload, '<< /Predictor 12 /Columns 8 >>'),
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, false);
    assert.match(String(result.warning), /pdf-predictor-unsupported:4/);
    assert.doesNotMatch(String(result.warning), /scanned-pdf-no-text-layer/);
    assert.equal(result.text, '', '不能把没还原的预测字节当文本输出');
  });

  test('未知过滤器 + 无文本操作符 → warning 含 pdf-filter-unsupported，不能谎报扫描件', () => {
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      { body: '<< /Length 12 /Filter /JBIG2Decode >>\nstream\n\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\nendstream' },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, false, '读不动就是读不动，不能算成功');
    assert.equal(result.text, '');
    assert.match(String(result.warning), /pdf-filter-unsupported:JBIG2Decode/);
    assert.doesNotMatch(String(result.warning), /scanned-pdf-no-text-layer/);
  });

  test('流解码失败（声明 FlateDecode 但数据不是 zlib）→ warning 含 pdf-stream-decode-failed', () => {
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      { body: '<< /Length 9 /Filter /FlateDecode >>\nstream\nnot-deflate\nendstream' },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, false);
    assert.match(String(result.warning), /pdf-stream-decode-failed:4/);
    assert.doesNotMatch(String(result.warning), /scanned-pdf-no-text-layer/);
  });

  test('WinAnsiEncoding 的高位字节（破折号 / 间隔号）被正确还原', () => {
    const content =
      'BT /F1 12 Tf 72 712 Td (Engineer \\227 Agents \\267 MCP) Tj ET';
    const pdf = buildPdf([
      CATALOG_OBJECT,
      PAGES_OBJECT,
      pageObject(4),
      contentObject(content),
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    ]);

    const result = extractText('pdf', pdf);
    assert.equal(result.ok, true);
    assert.equal(result.warning, null, 'WinAnsi 可映射，不应报 encoding-unmapped');
    assert.match(result.text, /Engineer \u2014 Agents \u00b7 MCP/);
  });
});

describe('extractText / 纯文本类格式', () => {
  test('txt / md 原样解码并剥 BOM', () => {
    const txt = extractText('txt', Buffer.from('\uFEFF经营目标\n本月营收 38 万', 'utf8'));
    assert.equal(txt.ok, true);
    assert.equal(txt.strategy, 'plain');
    assert.equal(txt.text, '经营目标\n本月营收 38 万');
    assert.equal(txt.warning, null);

    const md = extractText('md', Buffer.from('# 标题\n\n- 要点一\n- 要点二\n', 'utf8'));
    assert.equal(md.ok, true);
    assert.match(md.text, /^# 标题$/m);
    assert.match(md.text, /- 要点一/);
  });

  test('csv / tsv 保留分隔符与行列结构', () => {
    const csv = extractText('csv', Buffer.from('\uFEFF产品,销量,金额\n宫保鸡丁,412,38\n', 'utf8'));
    assert.equal(csv.ok, true);
    assert.equal(csv.strategy, 'plain');
    assert.match(csv.text, /^产品,销量,金额$/m);
    assert.match(csv.text, /宫保鸡丁,412,38/);

    const tsv = extractText('tsv', Buffer.from('产品\t销量\n宫保鸡丁\t412\n', 'utf8'));
    assert.equal(tsv.ok, true);
    assert.match(tsv.text, /产品\t销量/);
  });

  test('xml / yaml / sql 走 plain 策略', () => {
    const cases: Array<[string, string]> = [
      ['xml', '<root><name>蜀香阁</name></root>'],
      ['yaml', 'name: 蜀香阁\ncity: 成都'],
      ['sql', 'SELECT id, name FROM products WHERE stock > 0;'],
    ];
    for (const [format, body] of cases) {
      const result = extractText(format, Buffer.from(body, 'utf8'));
      assert.equal(result.ok, true, `${format} 应可抽取`);
      assert.equal(result.strategy, 'plain');
      assert.ok(result.text.includes(body.split('\n')[0]), `${format} 应保留原文`);
    }
  });

  test('json 美化输出；解析失败时原样返回并 warning', () => {
    const good = extractText('json', Buffer.from('{"product":"宫保鸡丁","sales":412}', 'utf8'));
    assert.equal(good.ok, true);
    assert.equal(good.strategy, 'json-pretty');
    assert.equal(good.warning, null);
    assert.equal(good.text, '{\n  "product": "宫保鸡丁",\n  "sales": 412\n}');

    const bad = extractText('json', Buffer.from('{ not json at all', 'utf8'));
    assert.equal(bad.ok, true, '解析失败不算抽取失败：原样返回更有用');
    assert.equal(bad.strategy, 'json-pretty');
    assert.equal(bad.warning, 'json-parse-failed');
    assert.equal(bad.text, '{ not json at all');
  });

  test('html 去标签、块级标签换行、实体解码', () => {
    const html = [
      '<!DOCTYPE html><html><head><title>标题</title><style>body{color:red}</style>',
      '<script>var secret = "should not appear";</script></head>',
      '<body><h1>经营周报 &amp; 复盘</h1>',
      '<p>营收 &gt; 38 万元&nbsp;人民币</p>',
      '<ul><li>宫保鸡丁 &#65; 级</li><li>麻婆豆腐</li></ul>',
      '<p title="属性里的 &quot;内容&quot; 不该出现">正文 &lt;结束&gt;</p>',
      '<!-- 注释也不该出现 --></body></html>',
    ].join('\n');

    const result = extractText('html', Buffer.from(html, 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'html-tags');
    assert.match(result.text, /经营周报 & 复盘/);
    assert.match(result.text, /营收 > 38 万元 人民币/);
    assert.match(result.text, /宫保鸡丁 A 级/);
    assert.match(result.text, /麻婆豆腐/);
    assert.match(result.text, /正文 <结束>/);
    // script / style / 注释 / 属性值都不进正文
    assert.doesNotMatch(result.text, /should not appear/);
    assert.doesNotMatch(result.text, /color:red/);
    assert.doesNotMatch(result.text, /注释也不该出现/);
    assert.doesNotMatch(result.text, /属性里的/);
    // 块级标签换成换行：标题与正文各自成行（li 之间可能多一个空行，不敏感）
    assert.match(result.text, /经营周报 & 复盘\n\n营收 > 38 万元 人民币/);
    assert.match(result.text, /宫保鸡丁 A 级\n+麻婆豆腐/);
    assert.match(result.text, /麻婆豆腐\n+正文 <结束>/);
  });
});

describe('extractText / 通用行为', () => {
  test('maxChars 截断：truncated 为 true 且 text.length <= maxChars', () => {
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行：营收数据 ${i * 7}`).join('\n');
    const result = extractText('txt', Buffer.from(long, 'utf8'), { maxChars: 500 });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 500, `实际长度 ${result.text.length} 应 <= 500`);
    assert.equal(result.meta.characters, result.text.length, 'characters 报告截断后的长度');

    const short = extractText('txt', Buffer.from('很短的一段文本', 'utf8'), { maxChars: 500 });
    assert.equal(short.truncated, false);
    assert.equal(short.text, '很短的一段文本');

    // 默认上限是 60_000
    const huge = extractText('txt', Buffer.from('x'.repeat(DEFAULT_MAX_CHARS + 1000), 'utf8'));
    assert.equal(huge.truncated, true);
    assert.equal(huge.text.length, DEFAULT_MAX_CHARS);
  });

  test('未知格式返回 ok:false + warning，不抛错', () => {
    for (const format of ['exe', 'zip', 'png', '', '   ']) {
      const result = extractText(format, Buffer.from('MZ\x90\x00', 'utf8'));
      assert.equal(result.ok, false, `${format} 不应可抽取`);
      assert.equal(result.text, '');
      assert.equal(result.meta.characters, 0);
      assert.ok(typeof result.warning === 'string' && result.warning.length > 0);
      assert.match(result.warning, /^(unsupported-format|empty-input)/);
    }
  });

  test('空 buffer 与随机字节都不抛错', () => {
    assert.equal(extractText('txt', Buffer.alloc(0)).ok, false);
    assert.equal(extractText('txt', Buffer.alloc(0)).warning, 'empty-input');
    assert.equal(extractText('pdf', Buffer.alloc(0)).ok, false);

    const noise = Buffer.from([0, 1, 2, 3]);
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx']) {
      const result = extractText(format, noise);
      assert.equal(result.ok, false, `${format} 用随机字节不应 ok`);
      assert.equal(result.text, '');
      assert.equal(typeof result.warning, 'string');
    }

    // 伪装成 PDF 的随机字节：容器读得动、但没有文本层，属于"如实降级"
    const fakePdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from([0, 1, 2, 3, 255])]);
    const result = extractText('pdf', fakePdf);
    assert.equal(result.ok, true);
    assert.equal(result.text, '');
    assert.equal(result.warning, 'scanned-pdf-no-text-layer');
  });

  test('控制字符与 NUL 被清掉，空白被归一化', () => {
    const raw = '第一行\x00 有 NUL\n第二行\x01\x07 有控制字符\n\n\n\n第三行\x7f\x1f 结束\t  \u0085\u009f\n';
    const result = extractText('txt', Buffer.from(raw, 'utf8'));

    assert.equal(result.ok, true);
    assert.doesNotMatch(result.text, /\x00/, '不应残留 NUL');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(result.text, /[\x01\x07\x1f\x7f]/, '不应残留控制字符');
    assert.doesNotMatch(result.text, /\u0085|\u009f/, '不应残留 C1 控制字符');
    assert.doesNotMatch(result.text, /[ \t]+$/m, '不应残留行尾空格');
    assert.doesNotMatch(result.text, /\n{3,}/, '连续空行应压缩');
    assert.equal(result.text, '第一行 有 NUL\n第二行 有控制字符\n\n第三行 结束');
  });

  test('CRLF 统一成 LF', () => {
    const result = extractText('txt', Buffer.from('甲\r\n乙\r\n\r\n丙', 'utf8'));
    assert.equal(result.text, '甲\n乙\n\n丙');
    assert.doesNotMatch(result.text, /\r/);
  });

  test('canExtract 正反例', () => {
    const supported: ExtractibleFormat[] = [
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
    for (const format of supported) assert.equal(canExtract(format), true, `${format} 应可抽取`);
    // 大小写与点号前缀都容错
    assert.equal(canExtract('PDF'), true);
    assert.equal(canExtract('.Docx'), true);
    assert.equal(canExtract('  XLSX  '), true);
    for (const format of ['exe', 'zip', 'png', 'doc', 'xls', 'ppt', 'rtf', '', 'mdx']) {
      assert.equal(canExtract(format), false, `${format} 不应可抽取`);
    }
  });

  test('ExtractResult 形状完整（每个分支都给出五个字段）', () => {
    const results: ExtractResult[] = [
      extractText('txt', Buffer.from('ok', 'utf8')),
      extractText('exe', Buffer.from('no', 'utf8')),
      extractText('pdf', Buffer.from([0, 1, 2, 3])),
    ];
    for (const result of results) {
      assert.equal(typeof result.ok, 'boolean');
      assert.equal(typeof result.text, 'string');
      assert.equal(typeof result.truncated, 'boolean');
      assert.equal(typeof result.strategy, 'string');
      assert.equal(typeof result.meta.characters, 'number');
      assert.ok(result.warning === null || typeof result.warning === 'string');
    }
  });
});
