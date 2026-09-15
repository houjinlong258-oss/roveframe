/**
 * doc-writers 单元测试。
 *
 * 覆盖：CSV 转义（BOM / 逗号 / 引号 / 换行）/ 格式矩阵与不支持格式抛错 /
 * XLSX·DOCX 是真实可解开的 ZIP + OOXML / HTML 转义与自包含打印排版 /
 * MD·TXT·JSON 序列化 / 输出确定性。
 *
 * 测试内自带最小 ZIP 解包器（顺序扫 Local File Header + inflateRawSync），
 * 并用**逐位算法**独立实现 CRC-32 交叉验证 writer 里的查表实现。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  buildZip,
  crc32,
  writeDocument,
  writeTable,
  type ArtifactFormat,
  type DocSpec,
  type TableSpec,
} from '../src/lib/artifacts/doc-writers';

/* -------------------------------------------------------------------------- */
/* 测试辅助                                                                    */
/* -------------------------------------------------------------------------- */

interface ZipReadEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Buffer;
}

/** 逐位算法（不查表）实现的 CRC-32，独立于被测模块的查表实现。 */
function crc32Bitwise(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 顺序扫 Local File Header 解包 ZIP，同时校验压缩长度 / 原始长度 / CRC / EOCD。 */
function readZip(buf: Buffer): ZipReadEntry[] {
  assert.equal(
    buf.subarray(0, 4).toString('binary'),
    'PK\x03\x04',
    'ZIP 必须以 local file header（PK\\x03\\x04）开头',
  );
  const entries: ZipReadEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const crc = buf.readUInt32LE(offset + 14);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    assert.equal(data.length, uncompressedSize, `${name}: 解压长度应与 local header 一致`);
    assert.equal(crc32Bitwise(data), crc, `${name}: CRC-32 不匹配`);
    entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, data });
    offset = dataStart + compressedSize;
  }

  const eocdOffset = buf.length - 22;
  assert.ok(eocdOffset >= 0, 'ZIP 应包含 EOCD');
  assert.equal(
    buf.subarray(eocdOffset, eocdOffset + 4).toString('binary'),
    'PK\x05\x06',
    'EOCD 签名 PK\\x05\\x06 应位于文件尾部',
  );
  assert.equal(buf.readUInt16LE(eocdOffset + 10), entries.length, 'EOCD entry 总数应与实际一致');
  return entries;
}

function entryMap(entries: ZipReadEntry[]): Map<string, ZipReadEntry> {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function textOf(entries: ZipReadEntry[], name: string): string {
  const entry = entryMap(entries).get(name);
  assert.ok(entry !== undefined, `缺少 ZIP entry：${name}`);
  return entry.data.toString('utf8');
}

/** 极简 XML 良构性校验：标签配对 + 无未转义 `&`（足够覆盖本模块生成的 OOXML）。 */
function assertWellFormedXml(xml: string, label: string): void {
  assert.ok(xml.startsWith('<?xml '), `${label}: 应以 XML 声明开头`);
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*)>/g;
  const stack: string[] = [];
  let match = tagPattern.exec(xml);
  while (match !== null) {
    const name = match[2];
    if (match[1] === '/') {
      assert.equal(stack.pop(), name, `${label}: 闭合标签 </${name}> 不匹配`);
    } else if (!/\/\s*$/.test(match[3])) {
      stack.push(name);
    }
    match = tagPattern.exec(xml);
  }
  assert.equal(stack.length, 0, `${label}: 存在未闭合标签 ${stack.join(', ')}`);
  const stray = xml
    .replace(tagPattern, '')
    .match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  assert.equal(stray, null, `${label}: 存在未转义的 &`);
}

/* -------------------------------------------------------------------------- */
/* 测试数据                                                                    */
/* -------------------------------------------------------------------------- */

const SALES_SHEET: TableSpec = {
  name: 'Sales',
  columns: ['Order', 'Customer', 'Total'],
  rows: [
    ['A-1001', 'Zhang, Wei', 42.5],
    ['A-1002', 'He said "hi"', 0],
    ['A-1003', 'multi\nline', true],
  ],
};

const STOCK_SHEET: TableSpec = {
  name: 'Stock',
  columns: ['Item', 'Qty'],
  rows: [['Yunnan Coffee Bean', 120]],
};

const HELLO_DOC: DocSpec = {
  title: 'Weekly Business Review',
  subtitle: 'RoveFrame AI COO',
  sections: [
    {
      heading: 'Highlights',
      paragraphs: ['Revenue grew 12% week over week.'],
      bullets: ['Repeat purchase rate up', 'Eight new customers'],
    },
    { heading: 'Detail', table: SALES_SHEET },
  ],
  footer: 'Generated by RoveFrame AI COO',
};

const XSS_DOC: DocSpec = {
  title: '<script>alert("xss")</script>',
  sections: [
    {
      heading: 'Safe & sound',
      paragraphs: ['a < b && c > d'],
      bullets: ['<img src=x onerror=1>'],
      table: {
        name: 'T & T',
        columns: ['<b>col</b>'],
        rows: [['<script>bad()</script>']],
      },
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

describe('writeTable csv（BOM + RFC4180 转义）', () => {
  test('开头写 UTF-8 BOM（Excel 正确识别中文）', () => {
    const file = writeTable('csv', [SALES_SHEET]);
    assert.equal(file.ext, 'csv');
    assert.equal(file.mime, 'text/csv; charset=utf-8');
    assert.equal(file.data.subarray(0, 3).toString('hex'), 'efbbbf', '应为 UTF-8 BOM 字节');
    assert.equal(file.data.toString('utf8').charCodeAt(0), 0xfeff);
  });

  test('逗号 / 双引号 / 换行字段用双引号包裹并转义 "', () => {
    const sheet: TableSpec = {
      name: 't',
      columns: ['a', 'b'],
      rows: [
        ['x,y', 'he "q" z'],
        ['line1\nline2', 'plain'],
      ],
    };
    const text = writeTable('csv', [sheet]).data.toString('utf8');
    assert.ok(text.includes('"x,y","he ""q"" z"'), '含逗号与引号的字段应被引号包裹并转义');
    assert.ok(text.includes('"line1\nline2",plain'), '含换行的字段应被引号包裹');
    assert.ok(text.includes('"x,y"'), '含逗号字段必须被引号包裹');
  });

  test('中文内容可往返（BOM 之后的 UTF-8 正文）', () => {
    const sheet: TableSpec = { name: '订单', columns: ['商品', '数量'], rows: [['龙井茶', 2]] };
    const text = writeTable('csv', [sheet]).data.toString('utf8');
    assert.ok(text.includes('商品,数量'));
    assert.ok(text.includes('龙井茶,2'));
  });

  test('多表：空行分隔 + 每表前 `# <name>` 注释行', () => {
    const text = writeTable('csv', [SALES_SHEET, STOCK_SHEET]).data.toString('utf8');
    assert.ok(text.includes('# Sales'));
    assert.ok(text.includes('# Stock'));
    assert.ok(text.includes('\r\n\r\n# Stock'), '两张表之间应为空行分隔');
  });

  test('单表不写 `# <name>` 注释行；spec.title 写成首行注释', () => {
    const single = writeTable('csv', [SALES_SHEET]).data.toString('utf8');
    assert.equal(single.includes('# Sales'), false);
    const titled = writeTable('csv', [SALES_SHEET], { title: 'Sales Report' }).data.toString('utf8');
    assert.ok(titled.startsWith('\uFEFF# Sales Report\r\n'), '标题应作为首行注释紧跟 BOM');
  });

  test('RFC4180 使用 CRLF 行结束符', () => {
    const text = writeTable('csv', [STOCK_SHEET]).data.toString('utf8');
    assert.ok(text.includes('Item,Qty\r\n'));
    assert.ok(text.endsWith('\r\n'));
  });
});

/* -------------------------------------------------------------------------- */
/* 格式矩阵与错误处理                                                           */
/* -------------------------------------------------------------------------- */

describe('格式矩阵与错误处理', () => {
  test('writeTable 支持 csv/xlsx/md/html/json，其余格式抛错', () => {
    const supported: ArtifactFormat[] = ['csv', 'xlsx', 'md', 'html', 'json'];
    for (const format of supported) {
      const file = writeTable(format, [SALES_SHEET]);
      assert.ok(file.data.length > 0, `${format} 应产出非空字节流`);
      assert.ok(file.mime.length > 0);
      assert.ok(file.ext.length > 0 && !file.ext.startsWith('.'));
    }
    assert.throws(() => writeTable('docx', [SALES_SHEET]), /不支持的格式/);
    assert.throws(() => writeTable('txt', [SALES_SHEET]), /不支持的格式/);
  });

  test('writeDocument 支持 docx/md/txt/html/json，其余格式抛错', () => {
    const supported: ArtifactFormat[] = ['docx', 'md', 'txt', 'html', 'json'];
    for (const format of supported) {
      const file = writeDocument(format, HELLO_DOC);
      assert.ok(file.data.length > 0, `${format} 应产出非空字节流`);
    }
    assert.throws(() => writeDocument('csv', HELLO_DOC), /不支持的格式/);
    assert.throws(() => writeDocument('xlsx', HELLO_DOC), /不支持的格式/);
  });

  test('mime / ext 与格式对应', () => {
    assert.equal(
      writeTable('xlsx', [SALES_SHEET]).mime,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(writeTable('xlsx', [SALES_SHEET]).ext, 'xlsx');
    assert.equal(
      writeDocument('docx', HELLO_DOC).mime,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(writeDocument('docx', HELLO_DOC).ext, 'docx');
    assert.equal(writeTable('json', [SALES_SHEET]).mime, 'application/json; charset=utf-8');
    assert.equal(writeDocument('txt', HELLO_DOC).mime, 'text/plain; charset=utf-8');
    assert.equal(writeDocument('html', HELLO_DOC).mime, 'text/html; charset=utf-8');
  });

  test('xlsx 至少需要一张工作表', () => {
    assert.throws(() => writeTable('xlsx', []), /至少需要一张工作表/);
  });

  test('表格宽度以 columns 为唯一口径：多余行值忽略、缺失补空', () => {
    const sheet: TableSpec = {
      name: 'width',
      columns: ['a'],
      rows: [['1', 'ignored'], []],
    };
    const csv = writeTable('csv', [sheet]).data.toString('utf8');
    assert.equal(csv.includes('ignored'), false, '超出 columns 的行值应被忽略');
    assert.equal(csv, '\uFEFFa\r\n1\r\n\r\n', '缺失的单元格写空');

    const md = writeTable('md', [sheet]).data.toString('utf8');
    assert.ok(md.includes('| 1 |'));
    assert.equal(md.includes('ignored'), false);
  });

  test('畸形 spec（模型 JSON）容错：columns/rows 类型不对也不抛 TypeError', () => {
    // 与真实调用方一致：artifact store 传进来的是 JSON.parse 的模型输出。
    const broken = JSON.parse('{"name":"Broken","columns":"a,b","rows":"nope"}') as TableSpec;
    assert.equal(writeTable('csv', [broken]).data.toString('utf8'), '\uFEFF\r\n');
    assert.ok(writeTable('md', [broken]).data.toString('utf8').includes('## Broken'));
    assert.ok(
      readZip(writeTable('xlsx', [broken]).data).some(
        (entry) => entry.name === 'xl/worksheets/sheet1.xml',
      ),
    );
    const docx = writeDocument('docx', {
      title: 'broken',
      sections: [{ table: broken }],
    });
    assert.ok(docx.data.length > 0);
    assert.ok(
      readZip(docx.data).some((entry) => entry.name === 'word/document.xml'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* XLSX                                                                        */
/* -------------------------------------------------------------------------- */

describe('writeTable xlsx（真实 OOXML / ZIP 包）', () => {
  const XLSX_REQUIRED = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
    'xl/styles.xml',
  ];

  test('是合法 ZIP：PK 魔数 + 尾部 EOCD + 必需 entry 齐全', () => {
    const file = writeTable('xlsx', [SALES_SHEET, STOCK_SHEET]);
    const buf = file.data;
    assert.equal(buf.subarray(0, 4).toString('binary'), 'PK\x03\x04');
    assert.equal(buf.subarray(buf.length - 22, buf.length - 18).toString('binary'), 'PK\x05\x06');
    const entries = readZip(buf);
    const names = entries.map((entry) => entry.name);
    assert.equal(names.length, 7, '两张工作表时应有 7 个 entry');
    for (const required of XLSX_REQUIRED) {
      assert.ok(names.includes(required), `缺少 xlsx 必需 entry：${required}`);
    }
    assert.deepEqual(names, XLSX_REQUIRED, 'entry 顺序应稳定');
  });

  test('全部 entry 使用 deflate + UTF-8 文件名标志', () => {
    const entries = readZip(writeTable('xlsx', [SALES_SHEET]).data);
    for (const entry of entries) {
      assert.equal(entry.method, 8, `${entry.name} 应使用 deflate(8)`);
      assert.equal(entry.flags & 0x0800, 0x0800, `${entry.name} 应设置 UTF-8 标志位`);
    }
  });

  test('sheet1.xml 可解析：内联字符串 / 数值 / 布尔 / 空单元格 / 加粗表头', () => {
    const entries = readZip(writeTable('xlsx', [SALES_SHEET]).data);
    const sheet = textOf(entries, 'xl/worksheets/sheet1.xml');
    assertWellFormedXml(sheet, 'sheet1.xml');
    assert.ok(sheet.includes('<sheetData>') && sheet.includes('</sheetData>'));
    assert.ok(sheet.includes('<c r="A1" t="inlineStr" s="1">'), '表头应引用加粗样式 s="1"');
    assert.ok(sheet.includes('<t xml:space="preserve">Order</t>'));
    assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">Zhang, Wei</t></is></c>'));
    assert.ok(sheet.includes('<c r="C2"><v>42.5</v></c>'), '数字应写成数值单元格');
    assert.ok(sheet.includes('<c r="C3"><v>0</v></c>'), '0 必须保留为数值而不是空');
    assert.ok(sheet.includes('<c r="C4" t="b"><v>1</v></c>'), '布尔应写成 t="b" 的 1/0');
    assert.ok(sheet.includes('<c r="B4" t="inlineStr">'), '换行字符串仍是 inlineStr');
    assert.ok(sheet.includes('multi\nline'), '换行应原样保留在 <t> 中');
  });

  test('null 单元格写成空单元格引用（不丢列位）', () => {
    const sheet: TableSpec = {
      name: 'Nulls',
      columns: ['A', 'B', 'C'],
      rows: [
        [null, 'x', null],
        ['y', null, 0],
      ],
    };
    const xml = textOf(readZip(writeTable('xlsx', [sheet]).data), 'xl/worksheets/sheet1.xml');
    assert.ok(xml.includes('<c r="A2"/>'), 'null 首列应写空单元格');
    assert.ok(xml.includes('<c r="C2"/>'), 'null 尾列应写空单元格');
    assert.ok(xml.includes('<c r="C3"><v>0</v></c>'));
    assert.ok(xml.includes('<row r="2">') && xml.includes('<row r="3">'));
  });

  test('workbook / rels / styles 互相一致', () => {
    const entries = readZip(writeTable('xlsx', [SALES_SHEET, STOCK_SHEET]).data);
    const workbook = textOf(entries, 'xl/workbook.xml');
    const rels = textOf(entries, 'xl/_rels/workbook.xml.rels');
    const styles = textOf(entries, 'xl/styles.xml');
    assertWellFormedXml(workbook, 'workbook.xml');
    assertWellFormedXml(rels, 'workbook.xml.rels');
    assertWellFormedXml(styles, 'styles.xml');
    assert.ok(workbook.includes('<sheet name="Sales" sheetId="1" r:id="rId1"/>'));
    assert.ok(workbook.includes('<sheet name="Stock" sheetId="2" r:id="rId2"/>'));
    assert.ok(rels.includes('Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"'));
    assert.ok(rels.includes('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"'));
    assert.ok(rels.includes('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"'));
    assert.ok(styles.includes('<fonts count="2">'), '应有两个字体（正文 + 加粗）');
    assert.ok(styles.includes('<font><b/>'), '第二个字体应为加粗');
    assert.ok(styles.includes('<cellXfs count="2">'));
    assert.ok(styles.includes('<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'));
  });

  test('工作表名清洗：非法字符剔除 / 31 字符截断 / 重名去重', () => {
    const long = 'X'.repeat(40);
    const sheets: TableSpec[] = [
      { name: 'a[b]:c*d?e/f\\g', columns: ['h'], rows: [] },
      { name: long, columns: ['h'], rows: [] },
      { name: 'dup', columns: ['h'], rows: [] },
      { name: 'dup', columns: ['h'], rows: [] },
      { name: '', columns: ['h'], rows: [] },
    ];
    const workbook = textOf(readZip(writeTable('xlsx', sheets).data), 'xl/workbook.xml');
    assert.ok(workbook.includes('<sheet name="abcdefg"'), '非法字符应被剔除');
    assert.ok(workbook.includes(`<sheet name="${'X'.repeat(31)}"`), '应截断到 31 字符');
    assert.equal(workbook.includes(`name="${'X'.repeat(32)}"`), false);
    assert.ok(workbook.includes('<sheet name="dup" sheetId="3" r:id="rId3"/>'));
    assert.ok(workbook.includes('<sheet name="dup (2)" sheetId="4" r:id="rId4"/>'), '重名应追加序号');
    assert.ok(workbook.includes('<sheet name="Sheet5" sheetId="5" r:id="rId5"/>'), '空名回落 SheetN');
  });

  test('XML 特殊字符被转义', () => {
    const sheet: TableSpec = {
      name: 'A&B<C>',
      columns: ['<col>', 'v'],
      rows: [['a&b', '<x>']],
    };
    const entries = readZip(writeTable('xlsx', [sheet]).data);
    const workbook = textOf(entries, 'xl/workbook.xml');
    const sheetXml = textOf(entries, 'xl/worksheets/sheet1.xml');
    assert.ok(workbook.includes('name="A&amp;B&lt;C&gt;"'));
    assert.ok(sheetXml.includes('&lt;col&gt;'));
    assert.ok(sheetXml.includes('a&amp;b'));
    assert.ok(sheetXml.includes('&lt;x&gt;'));
    assertWellFormedXml(sheetXml, 'sheet1.xml');
  });
});

/* -------------------------------------------------------------------------- */
/* DOCX                                                                        */
/* -------------------------------------------------------------------------- */

describe('writeDocument docx（真实 OOXML / ZIP 包）', () => {
  const DOCX_REQUIRED = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/_rels/document.xml.rels',
    'word/document.xml',
    'word/styles.xml',
  ];

  test('是合法 ZIP：PK 魔数 + 尾部 EOCD + 必需 entry 齐全', () => {
    const buf = writeDocument('docx', HELLO_DOC).data;
    assert.equal(buf.subarray(0, 4).toString('binary'), 'PK\x03\x04');
    assert.equal(buf.subarray(buf.length - 22, buf.length - 18).toString('binary'), 'PK\x05\x06');
    const names = readZip(buf).map((entry) => entry.name);
    assert.equal(names.length, 6, '带页脚时应有 6 个 entry（含 footer1.xml）');
    for (const required of DOCX_REQUIRED) {
      assert.ok(names.includes(required), `缺少 docx 必需 entry：${required}`);
    }
    assert.ok(names.includes('word/footer1.xml'));
  });

  test('document.xml 含标题、Heading1/Heading2 样式、列表与真实表格', () => {
    const entries = readZip(writeDocument('docx', HELLO_DOC).data);
    const document = textOf(entries, 'word/document.xml');
    assertWellFormedXml(document, 'document.xml');
    assert.ok(document.includes('Weekly Business Review'), '标题文字应写入 document.xml');
    assert.ok(document.includes('<w:pStyle w:val="Heading1"/>'), '标题应引用 Heading1');
    assert.ok(document.includes('<w:pStyle w:val="Heading2"/>'), '小节标题应引用 Heading2');
    assert.ok(document.includes('Revenue grew 12% week over week.'));
    assert.ok(document.includes('<w:pStyle w:val="ListParagraph"/>'));
    assert.ok(document.includes('>• Repeat purchase rate up</w:t>'), '列表项应带 • 前缀');
    assert.ok(document.includes('<w:tbl>') && document.includes('<w:tblGrid>'));
    assert.ok(document.includes('<w:tblHeader/>'), '表头行应标记 tblHeader');
    assert.ok(document.includes('<w:t xml:space="preserve">Zhang, Wei</w:t>'));
    assert.ok(document.includes('<w:tblBorders>'));
    assert.ok(document.includes('<w:sectPr>'));
  });

  test('styles.xml 定义 Heading1 / Heading2 / ListParagraph / Normal', () => {
    const entries = readZip(writeDocument('docx', HELLO_DOC).data);
    const styles = textOf(entries, 'word/styles.xml');
    assertWellFormedXml(styles, 'styles.xml');
    assert.ok(styles.includes('w:styleId="Heading1"'));
    assert.ok(styles.includes('w:styleId="Heading2"'));
    assert.ok(styles.includes('w:styleId="ListParagraph"'));
    assert.ok(styles.includes('w:styleId="Normal"'));
    assert.ok(styles.includes('<w:docDefaults>'));
  });

  test('页脚写成独立部件 + sectPr 引用', () => {
    const entries = readZip(writeDocument('docx', HELLO_DOC).data);
    const document = textOf(entries, 'word/document.xml');
    const rels = textOf(entries, 'word/_rels/document.xml.rels');
    const footer = textOf(entries, 'word/footer1.xml');
    assertWellFormedXml(rels, 'document.xml.rels');
    assertWellFormedXml(footer, 'footer1.xml');
    assert.ok(document.includes('<w:footerReference w:type="default" r:id="rId2"/>'));
    assert.ok(rels.includes('Target="footer1.xml"'));
    assert.ok(footer.includes('Generated by RoveFrame AI COO'));
  });

  test('无页脚时不生成 footer 部件', () => {
    const doc: DocSpec = { title: 'Plain', sections: [{ paragraphs: ['body'] }] };
    const names = readZip(writeDocument('docx', doc).data).map((entry) => entry.name);
    assert.equal(names.length, 5);
    assert.equal(names.includes('word/footer1.xml'), false);
    assert.ok(textOf(readZip(writeDocument('docx', doc).data), 'word/document.xml').includes('Plain'));
  });

  test('XML 特殊字符转义 + 非法控制字符剔除', () => {
    const doc: DocSpec = {
      title: 'A & B <C> "D"',
      sections: [{ paragraphs: ['bad\u0000char\u0007'], bullets: ["it's fine"] }],
    };
    const document = textOf(readZip(writeDocument('docx', doc).data), 'word/document.xml');
    assert.ok(document.includes('A &amp; B &lt;C&gt; &quot;D&quot;'));
    assert.ok(document.includes('badchar'), '非法控制字符应被剔除');
    assert.ok(document.includes("it&apos;s fine"));
    assertWellFormedXml(document, 'document.xml');
  });
});

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

describe('HTML 产物（自包含 + 转义 + 可打印）', () => {
  test('标题 / 单元格里的 <script> 被转义', () => {
    const tableHtml = writeTable('html', [SALES_SHEET], { title: '<script>alert(1)</script>' }).data.toString('utf8');
    assert.ok(tableHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.equal(tableHtml.includes('<script'), false, '不允许出现未转义的 <script');

    const docHtml = writeDocument('html', XSS_DOC).data.toString('utf8');
    assert.ok(docHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert.ok(docHtml.includes('Safe &amp; sound'));
    assert.ok(docHtml.includes('a &lt; b &amp;&amp; c &gt; d'));
    assert.ok(docHtml.includes('&lt;img src=x onerror=1&gt;'));
    assert.ok(docHtml.includes('&lt;b&gt;col&lt;/b&gt;'));
    assert.ok(docHtml.includes('&lt;script&gt;bad()&lt;/script&gt;'));
    assert.equal(docHtml.includes('<script'), false);
  });

  test('完整自包含：DOCTYPE + 内联 CSS + A4 打印规则 + 零外部资源', () => {
    for (const html of [
      writeTable('html', [SALES_SHEET, STOCK_SHEET], { title: 'Export' }).data.toString('utf8'),
      writeDocument('html', HELLO_DOC).data.toString('utf8'),
    ]) {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('<html lang="en">'));
      assert.ok(html.includes('<meta charset="utf-8" />'));
      assert.ok(html.includes('<style>') && html.includes('</style>'));
      assert.ok(html.includes('@page { size: A4;'));
      assert.ok(html.includes('@media print'));
      assert.ok(html.includes('border-collapse: collapse'));
      assert.equal(html.includes('<link'), false, '不允许外部样式表');
      assert.equal(html.includes('http://'), false, '不允许外部资源 URL');
      assert.equal(html.includes('https://'), false, '不允许外部资源 URL');
      assert.equal(html.includes(' src='), false, '不允许外部图片/脚本');
      assert.ok(html.trimEnd().endsWith('</html>'));
    }
  });

  test('表格 HTML 结构：表标题 + thead/th + 每个工作表一节', () => {
    const html = writeTable('html', [SALES_SHEET, STOCK_SHEET]).data.toString('utf8');
    assert.ok(html.includes('<h2>Sales</h2>'));
    assert.ok(html.includes('<h2>Stock</h2>'));
    assert.ok(html.includes('<th scope="col">Order</th>'));
    assert.ok(html.includes('<td>Zhang, Wei</td>'));
    assert.ok(html.includes('<td>42.5</td>'));
    assert.ok(html.includes('<td>true</td>'), '布尔在 HTML 表格里显示为 true');
    assert.ok(html.includes('multi<br />line'), '单元格换行应转成 <br />');
    assert.equal((html.match(/<table>/g) ?? []).length, 2);
  });

  test('文档 HTML 结构：标题 / 副标题 / 小节 / 列表 / 表格 / 页脚', () => {
    const html = writeDocument('html', HELLO_DOC).data.toString('utf8');
    assert.ok(html.includes('<h1>Weekly Business Review</h1>'));
    assert.ok(html.includes('<p class="doc-subtitle">RoveFrame AI COO</p>'));
    assert.ok(html.includes('<h2>Highlights</h2>'));
    assert.ok(html.includes('<li>Repeat purchase rate up</li>'));
    assert.ok(html.includes('<h3>Sales</h3>'));
    assert.ok(html.includes('<footer class="doc-footer">Generated by RoveFrame AI COO</footer>'));
    assert.ok(html.includes('<title>Weekly Business Review</title>'));
  });
});

/* -------------------------------------------------------------------------- */
/* Markdown / TXT / JSON                                                       */
/* -------------------------------------------------------------------------- */

describe('Markdown / TXT / JSON 序列化', () => {
  test('md 表格：表头分隔行 + 单元格内 `|` 转义', () => {
    const sheet: TableSpec = {
      name: 'Pipes',
      columns: ['a', 'b'],
      rows: [['x|y', 'plain']],
    };
    const md = writeTable('md', [sheet], { title: 'Report' }).data.toString('utf8');
    assert.ok(md.includes('# Report'));
    assert.ok(md.includes('## Pipes'));
    assert.ok(md.includes('| a | b |'));
    assert.ok(md.includes('| --- | --- |'));
    assert.ok(md.includes('| x\\|y | plain |'), '单元格内的 | 应转义为 \\|');
  });

  test('md 文档：标题 / 小节 / 段落 / 列表 / 表格 / 页脚', () => {
    const md = writeDocument('md', HELLO_DOC).data.toString('utf8');
    assert.ok(md.startsWith('# Weekly Business Review\n'));
    assert.ok(md.includes('*RoveFrame AI COO*'));
    assert.ok(md.includes('## Highlights'));
    assert.ok(md.includes('- Repeat purchase rate up'));
    assert.ok(md.includes('**Sales**'));
    assert.ok(md.includes('| Order | Customer | Total |'));
    assert.ok(md.includes('---\n\nGenerated by RoveFrame AI COO'));
  });

  test('txt 文档：下划线标题 / • 列表 / 竖线表格', () => {
    const txt = writeDocument('txt', HELLO_DOC).data.toString('utf8');
    assert.ok(txt.startsWith(`Weekly Business Review\n${'='.repeat('Weekly Business Review'.length)}\n`));
    assert.ok(txt.includes(`Highlights\n${'-'.repeat('Highlights'.length)}`));
    assert.ok(txt.includes('• Repeat purchase rate up'));
    assert.ok(txt.includes('[Sales]'));
    assert.ok(txt.includes('Order | Customer | Total'));
    assert.ok(txt.includes('Generated by RoveFrame AI COO'));
    assert.equal(txt.includes('#'), false, 'txt 不应含 markdown 标记');
  });

  test('json 输出等于 JSON.stringify(spec, null, 2)', () => {
    const sheets = [SALES_SHEET, STOCK_SHEET];
    assert.equal(writeTable('json', sheets).data.toString('utf8'), JSON.stringify(sheets, null, 2));
    assert.equal(writeDocument('json', HELLO_DOC).data.toString('utf8'), JSON.stringify(HELLO_DOC, null, 2));
  });
});

/* -------------------------------------------------------------------------- */
/* ZIP 基础设施与确定性                                                         */
/* -------------------------------------------------------------------------- */

describe('ZIP writer 与输出确定性', () => {
  test('crc32 命中标准已知答案（"123456789" → 0xCBF43926）', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('')), 0);
    assert.equal(crc32(Buffer.from('hello 世界')), crc32Bitwise(Buffer.from('hello 世界')));
  });

  test('buildZip：UTF-8 文件名往返 + 内容可解压', () => {
    const payload = Buffer.from('表格内容 with unicode ✅', 'utf8');
    const zipped = buildZip([{ name: 'xl/工作表1.xml', data: payload }]);
    const entries = readZip(zipped);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'xl/工作表1.xml');
    assert.ok(entries[0].data.equals(payload));
    assert.ok(entries[0].compressedSize > 0, 'deflate 后应有正的压缩长度');
    assert.ok((entries[0].flags & 0x0800) !== 0);
  });

  test('同样输入调用两次，输出 buffer 完全相等（全部格式）', () => {
    const tableFormats: ArtifactFormat[] = ['csv', 'xlsx', 'md', 'html', 'json'];
    for (const format of tableFormats) {
      const a = writeTable(format, [SALES_SHEET, STOCK_SHEET], { title: 'T' });
      const b = writeTable(format, [SALES_SHEET, STOCK_SHEET], { title: 'T' });
      assert.ok(a.data.equals(b.data), `${format}（表格）输出不确定`);
      assert.equal(a.ext, b.ext);
    }
    const documentFormats: ArtifactFormat[] = ['docx', 'md', 'txt', 'html', 'json'];
    for (const format of documentFormats) {
      const a = writeDocument(format, HELLO_DOC);
      const b = writeDocument(format, HELLO_DOC);
      assert.ok(a.data.equals(b.data), `${format}（文档）输出不确定`);
    }
  });
});
