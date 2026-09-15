/**
 * 中文字体供给器（Phase 4c / Document Runtime）。
 *
 * 问题
 * ----
 * `src/lib/artifacts/pdf-writer.ts` 的 `discoverPdfFont()` 按固定顺序找字体：
 *
 *   ① 显式路径 ② env RF_PDF_FONT ③ <cwd>/public/fonts 下的 .ttf/.otf/.ttc
 *   ④ Linux 字体目录（NotoSansCJK* / SourceHanSans* / wqy-* / DroidSansFallback*）
 *   ⑤ Windows 字体（msyh.ttc / simhei.ttf / simsun.ttc / arial.ttf）
 *
 * 本机（Windows）实测：① 命中 `C:\WINDOWS\Fonts\msyh.ttc`（30209 glyphs），
 * 中文 PDF 正常产出。**但生产部署在 Linux** —— 精简镜像里通常**没有**
 * Noto CJK，于是中文 PDF 会走 `pdf_font_unavailable` 降级，而这是静默的：
 * 用户只看到「PDF 需要中文字体」。
 *
 * 本脚本做什么
 * ------------
 * 把系统上**已存在**的 CJK 字体落到 `<repo>/public/fonts/`，让候选 ③ 命中，
 * 从而**不依赖具体发行版**。也可以只打印诊断（`--check`）。
 *
 * 不做什么（硬约束）
 * ------------------
 * - **不下载任何东西**（零网络、零新增依赖）
 * - **不覆盖**已存在的字体文件
 * - **不修改** package.json 或任何现有模块
 * - 默认 **dry-run**，加 `--apply` 才真正复制
 *
 * 用法
 * ----
 *   node scripts/setup-cjk-font.mjs            # 诊断：报告找到什么、会做什么
 *   node scripts/setup-cjk-font.mjs --apply    # 执行复制
 *   node scripts/setup-cjk-font.mjs --check    # 只报告 discoverPdfFont 的结果
 *
 * 许可证提示
 * ----------
 * 脚本只复制**本机已有**的系统字体，不引入新的分发物。是否随产品分发
 * 由部署方决定（Windows 系统字体通常不可再分发；Noto/Source Han 为 OFL，
 * 可自由分发）。脚本会在输出里标注来源，便于合规审查。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = path.join(REPO, 'public', 'fonts');
const TARGET_NAME = 'RoveFrame-CJK.ttf';

const APPLY = process.argv.includes('--apply');
const CHECK_ONLY = process.argv.includes('--check');
/** 显式允许复制非 OFL 字体（默认禁止，避免误把系统专有字体提交进仓库）。 */
const ALLOW_PROPRIETARY = process.argv.includes('--allow-proprietary');

/** 可自由分发（OFL / Apache）的许可证白名单。 */
const REDISTRIBUTABLE = /^(OFL|Apache|GPL-2\.0-with-font-exception)/i;

const WINDIR = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
const WIN_FONTS = path.join(WINDIR, 'Fonts');

/** 可自由分发（OFL）优先，其次才是系统自带字体。 */
const CANDIDATES = [
  // ---- Linux: Noto / Source Han（OFL，首选，生产环境目标）----
  { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', license: 'OFL-1.1' },
  { file: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', license: 'OFL-1.1' },
  { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', license: 'OFL-1.1' },
  { file: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', license: 'OFL-1.1' },
  { file: '/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf', license: 'OFL-1.1' },
  { file: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', license: 'GPL-2.0-with-font-exception' },
  { file: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', license: 'Apache-2.0' },
  // ---- Windows（本机开发用；见文末许可证提示）----
  { file: path.join(WIN_FONTS, 'simhei.ttf'), license: 'proprietary-Microsoft' },
  { file: path.join(WIN_FONTS, 'msyh.ttc'), license: 'proprietary-Microsoft' },
  { file: path.join(WIN_FONTS, 'simsun.ttc'), license: 'proprietary-Microsoft' },
  // ---- macOS ----
  { file: '/System/Library/Fonts/PingFang.ttc', license: 'Apple-system' },
  { file: '/Library/Fonts/Arial Unicode.ttf', license: 'proprietary' },
];

/** 扫描目录找任何 CJK 字体（当显式候选都没命中时的兜底）。 */
const SCAN_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  `${process.env.HOME ?? ''}/.fonts`,
];
const CJK_HINT = /(NotoSansCJK|NotoSerifCJK|NotoSansSC|SourceHan|wqy|DroidSansFallback|msyh|simhei|simsun|PingFang)/i;

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* 权限/坏链接：跳过 */
    }
  }
  return null;
}

function walk(dir, depth = 0, out = []) {
  if (depth > 4 || out.length >= 40) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1, out);
    } else if (/\.(ttf|ttc|otf)$/i.test(entry.name) && CJK_HINT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function report() {
  console.log('# 中文字体诊断（Phase 4c）');
  console.log(`repo        : ${REPO}`);
  console.log(`fonts dir   : ${FONTS_DIR}`);
  console.log(`platform    : ${process.platform}`);
  console.log(`RF_PDF_FONT : ${process.env.RF_PDF_FONT ?? '(unset)'}`);
  console.log('');

  const already = existsSync(FONTS_DIR)
    ? readdirSync(FONTS_DIR).filter((n) => /\.(ttf|ttc|otf)$/i.test(n))
    : [];
  console.log(`public/fonts 现有字体: ${already.length ? already.join(', ') : '(无)'}`);
  console.log('');

  const explicit = firstExisting(CANDIDATES.map((c) => c.file));
  const scanned = explicit ? [] : SCAN_DIRS.flatMap((d) => walk(d)).slice(0, 10);

  if (explicit) {
    const meta = CANDIDATES.find((c) => c.file === explicit);
    console.log(`发现候选（显式路径）: ${explicit}`);
    console.log(`  许可证标注        : ${meta?.license ?? 'unknown'}`);
    return { source: explicit, license: meta?.license ?? 'unknown', already };
  }

  if (scanned.length > 0) {
    console.log(`发现候选（目录扫描，${scanned.length} 个）:`);
    for (const p of scanned) console.log(`  - ${p}`);
    return { source: scanned[0], license: 'inspect-manually', already, scanned };
  }

  console.log('未在本机发现任何 CJK 字体。');
  console.log('可选项：');
  console.log('  1) 安装系统字体（Debian/Ubuntu）: apt-get install fonts-noto-cjk');
  console.log('  2) 手动放置 OFL 字体到 public/fonts/（Noto Sans CJK / Source Han Sans）');
  console.log('  3) 设 RF_PDF_FONT=<绝对路径> 指向任意 CJK 字体');
  return { source: null, license: null, already };
}

function main() {
  console.log('（默认 dry-run；加 --apply 才会复制）\n');
  const result = report();

  if (CHECK_ONLY) {
    console.log('\n[--check] 仅诊断，未做任何写入。');
    return result.source ? 0 : 1;
  }

  if (result.already.length > 0) {
    console.log('\n[skip] public/fonts 已有字体，pdf-writer 的候选 ③ 会命中。');
    return 0;
  }

  if (!result.source) {
    console.log('\n[FAIL] 无可用源字体 —— 中文 PDF 会降级。请按上面选项处理。');
    return 1;
  }

  const target = path.join(FONTS_DIR, TARGET_NAME);
  console.log(`\n计划: ${result.source}`);
  console.log(`  ->  ${target}`);

  // 合规护栏：默认只复制**可自由分发**的字体。
  //
  // 为什么需要它：Windows 的 msyh/simhei/simsun 是专有字体，把它们复制进
  // 仓库并随产品分发是许可证风险。本机自用没问题，但一次 `git add` 就会
  // 变成再分发。因此默认拒绝，需要显式 `--allow-proprietary`。
  const redistributable = REDISTRIBUTABLE.test(result.license ?? '');
  if (!redistributable && !ALLOW_PROPRIETARY) {
    console.log(`\n[REFUSED] 该字体许可证为 "${result.license}"，不可自由分发。`);
    console.log('  复制进仓库并随产品分发存在许可证风险，因此默认拒绝。');
    console.log('');
    console.log('  推荐做法（生产环境）：');
    console.log('    Debian/Ubuntu : apt-get install fonts-noto-cjk   # OFL-1.1');
    console.log('    Alpine        : apk add font-noto-cjk');
    console.log('    或设置环境变量  : RF_PDF_FONT=<CJK 字体绝对路径>  # 不进仓库，最干净');
    console.log('');
    console.log('  本机开发确认可用时，可显式覆盖：');
    console.log('    node scripts/setup-cjk-font.mjs --apply --allow-proprietary');
    console.log('    （仅本机使用；请勿把该文件提交进 git）');
    return 3;
  }

  if (!APPLY) {
    console.log('\n[dry-run] 未写入。确认无误后加 --apply 执行。');
    return 0;
  }

  try {
    mkdirSync(FONTS_DIR, { recursive: true });
    copyFileSync(result.source, target);
    console.log(`\n[OK] 已复制。许可证标注: ${result.license}`);
    if (!REDISTRIBUTABLE.test(result.license ?? '')) {
      console.log('[WARN] 该字体不可自由分发 —— 请勿提交进 git，仅限本机使用。');
    }
    console.log('重启服务后中文 PDF 即可正常产出。');
    return 0;
  } catch (error) {
    console.error(`\n[FAIL] 复制失败: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

process.exit(main());
