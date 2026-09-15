#!/usr/bin/env node
/**
 * 一键准备 PDF 中文字体。
 *
 * 为什么需要这一步：PDF 要正确排版中文，必须把一份 TrueType 字体嵌进文件里。
 * 本机开发机上通常有系统字体（Windows 的 msyh/simhei、macOS 的 PingFang），
 * 但**精简的 Linux 容器往往一个 CJK 字体都没有** —— 那种情况下
 * `writePdf` 会如实降级（不出豆腐块 PDF，改交付 Word/HTML）。
 *
 * 运行：node scripts/setup-pdf-font.mjs
 * 结果：public/fonts/report-cjk.ttf（随后 discoverPdfFont() 会自动选中它）
 *
 * 只用 Node 内置模块，不引入任何依赖。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const OUT_DIR = path.resolve(process.cwd(), 'public', 'fonts');
const OUT_FILE = path.join(OUT_DIR, 'report-cjk.ttf');

/** 候选源：全部是 TrueType 轮廓（glyf）的 CJK 字体 —— CFF/OTF 无法嵌入，已排除 */
const SOURCES = [
  {
    label: 'Noto Sans SC (Google Fonts, variable TTF)',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
  },
  {
    label: 'Noto Sans SC (jsDelivr 镜像)',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
  },
  {
    label: 'Noto Sans SC (npmmirror 镜像)',
    url: 'https://registry.npmmirror.com/-/binary/fontsource/noto-sans-sc/NotoSansSC-Regular.ttf',
  },
];

/** 校验：必须是 sfnt 且带 glyf 表（PDF 嵌入只支持 TrueType 轮廓） */
function inspectSfnt(buffer) {
  if (buffer.length < 12) return { ok: false, reason: 'too small' };
  const tag = buffer.readUInt32BE(0);
  if (tag === 0x74746366) {
    return { ok: true, note: 'TrueType Collection (.ttc)，取第一个字体' };
  }
  if (tag !== 0x00010000 && tag !== 0x74727565) {
    return { ok: false, reason: `不是 TrueType sfnt (tag=0x${tag.toString(16)})，可能是 CFF/OTF` };
  }
  const numTables = buffer.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const offset = 12 + i * 16;
    if (offset + 16 > buffer.length) return { ok: false, reason: 'table directory truncated' };
    tables.push(buffer.toString('ascii', offset, offset + 4));
  }
  if (!tables.includes('glyf')) {
    return { ok: false, reason: `缺少 glyf 表（CFF 轮廓不能嵌入 PDF）；tables=${tables.slice(0, 8).join(',')}` };
  }
  return { ok: true, note: `${numTables} 张表，含 glyf` };
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  if (existsSync(OUT_FILE)) {
    const size = statSync(OUT_FILE).size;
    console.log(`已存在：${path.relative(process.cwd(), OUT_FILE)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    console.log('如需重新下载，先删除该文件。');
    return 0;
  }

  const tmp = `${OUT_FILE}.part`;
  for (const source of SOURCES) {
    process.stdout.write(`尝试 ${source.label} … `);
    try {
      await download(source.url, tmp);
      const info = inspectSfnt(readFileSync(tmp));
      if (!info.ok) {
        console.log(`跳过（${info.reason}）`);
        rmSync(tmp, { force: true });
        continue;
      }
      const { renameSync } = await import('node:fs');
      renameSync(tmp, OUT_FILE);
      const size = statSync(OUT_FILE).size;
      console.log('OK');
      console.log(`\n已保存：${path.relative(process.cwd(), OUT_FILE)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`校验：${info.note}`);
      console.log('\n现在中文 PDF 会直接可用（writePdf 会自动发现这个文件并做字形子集化）。');
      return 0;
    } catch (error) {
      console.log(`失败（${error instanceof Error ? error.message : String(error)}）`);
      rmSync(tmp, { force: true });
    }
  }

  console.error('\n所有下载源都不可用。你可以手动处理：');
  console.error('1. 下载任意 TrueType 轮廓（非 OTF/CFF）的中文字体，例如 Noto Sans SC；');
  console.error(`2. 放到 ${path.relative(process.cwd(), OUT_FILE)}；`);
  console.error('3. 或用 RF_PDF_FONT=/absolute/path/to/font.ttf 指定已有字体。');
  console.error('\n在放置字体之前，系统不会产出排版错误的中文 PDF —— 它会如实告诉你并改交付 Word/HTML。');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
