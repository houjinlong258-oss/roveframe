/**
 * 把三端 PWA 原型里的**共享底座**搬进仓库，并做必要的改写。
 *
 * 为什么是脚本而不是手工复制：同一套改写要在顾客端、员工端、老板端上重复三次
 * （类型、i18n、CSS、`'use client'`、motion 替换、Vite env 替换）。手抄三遍必然漏。
 * 跑一次比说三遍准。
 *
 * 用法：
 *   node scripts/_vendor_pwa_assets.mjs <原型解压目录>
 *
 * 这个脚本**不搬运组件** —— 组件的 motion→CSS 改写需要逐个看 JSX 结构，
 * 机械替换会改坏。组件搬运见 docs/current/Phase18_PWA_Integration_Plan.md。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sourceRoot = process.argv[2];
if (!sourceRoot || !existsSync(sourceRoot)) {
  console.error('用法: node scripts/_vendor_pwa_assets.mjs <原型解压目录>');
  process.exit(2);
}

const repo = process.cwd();
const report = [];

function write(rel, content) {
  const target = path.join(repo, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  report.push(`${rel}  (${content.length} bytes)`);
}

// ---------------------------------------------------------------------------
// 1) 类型定义 —— 原样搬
// ---------------------------------------------------------------------------

const typesSrc = readFileSync(path.join(sourceRoot, 'src/types/index.ts'), 'utf8');
write('src/types/index.ts', typesSrc);

// ---------------------------------------------------------------------------
// 2) i18n —— 原样搬
//
// 这是一套**独立于 next-intl** 的查表实现（`getTranslations(locale)`）。
// 保留它而不是合并进 messages/*.json 的理由：三端 UI 有 350KB 的 t.xxx 调用，
// 重写成 next-intl 是另一次大改造，风险高于收益。这是一笔**明确记账的技术债**，
// 记录在 docs/current/Phase18_PWA_Frontend_Review.md，不是"没注意到"。
// ---------------------------------------------------------------------------

const i18nSrc = readFileSync(path.join(sourceRoot, 'src/lib/i18n.ts'), 'utf8');
write('src/lib/i18n.ts', i18nSrc);

// ---------------------------------------------------------------------------
// 3) 自定义 CSS 层
//
// 原型的 index.css 开头是 `@import "tailwindcss"` 与一个 `@layer base`（设置 body）。
// 两者都必须去掉：
//   · 仓库已有自己的 Tailwind 入口（globals.css），重复导入会二次注入 preflight；
//   · body 样式仓库已经定义过，覆盖它会让现有 20 个页面的字体与底色一起变。
// 其余 1300+ 行是 apple-* 玻璃态与 rf-* 布局，前缀互不重叠，整体保留。
// ---------------------------------------------------------------------------

const cssSrc = readFileSync(path.join(sourceRoot, 'src/index.css'), 'utf8');
let css = cssSrc.replace(/@import\s+["']tailwindcss["'];[ \t]*\r?\n/, '');
css = css.replace(/@layer\s+base\s*\{[\s\S]*?\n\}[ \t]*\r?\n/, '');

const removedTailwind = !/@import\s+["']tailwindcss["']/.test(css);
const removedBase = !/@layer\s+base/.test(css);
if (!removedTailwind || !removedBase) {
  console.error(`CSS 剥离失败: tailwind 导入已移除=${removedTailwind} base 层已移除=${removedBase}`);
  process.exit(1);
}

const header = [
  '/* ---------------------------------------------------------------------------',
  ' * Phase 18 三端 PWA 的设计层（从原型 src/index.css 提取）。',
  ' *',
  ' * 由 scripts/_vendor_pwa_assets.mjs 生成 —— 不要手工编辑这个文件，',
  ' * 改原型后重新跑脚本。',
  ' *',
  ' * 保留的是 apple-* 玻璃态组件类与 rf-* 布局类；',
  ' * 剥离了 `@import "tailwindcss"` 与 `@layer base`（仓库 globals.css 已各自定义，',
  ' * 重复应用会把现有页面的字体与底色一起改掉）。',
  ' * ------------------------------------------------------------------------- */',
  '',
  '',
].join('\n');

write('src/app/pwa-tier.css', header + css);

// 变量撞名检查：撞了就会互相覆盖，而且是静默的
const rfVars = [...new Set([...css.matchAll(/(--rf-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))];
const globalsPath = path.join(repo, 'src/app/globals.css');
const globalVars = existsSync(globalsPath)
  ? [...new Set([...readFileSync(globalsPath, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))]
  : [];
const collisions = rfVars.filter((v) => globalVars.includes(v));

console.log('搬运结果:');
for (const line of report) console.log('  ' + line);
console.log(`  rf 变量 ${rfVars.length} 个，与 globals.css 撞名 ${collisions.length} 个${collisions.length ? ': ' + collisions.join(', ') : ''}`);
if (collisions.length > 0) {
  console.error('撞名会导致静默覆盖，先解决再继续。');
  process.exit(1);
}
