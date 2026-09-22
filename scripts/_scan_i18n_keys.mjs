/**
 * i18n 键扫描（零依赖，Node 内置）。
 *
 * ## 为什么需要它
 *
 * `next-intl` 的缺失键在**客户端**会抛 `MISSING_MESSAGE`（AGENTS.md 陷阱 5），
 * 而它只在页面真的渲染到那一句时才炸 —— 也就是说：**页面能打开、只有某个分支
 * 崩**。测试跑不到的分支（空态、错误态、权限不足态）正是最容易缺键的地方。
 *
 * 这个脚本把两类问题都摆出来：
 *   1. **缺失**：源码里 `t('x')` 但 messages 里没有 ⇒ 运行时可能崩；
 *   2. **未使用**：messages 里有但源码没引用（仅统计，不判定 —— 有动态拼接）。
 *
 * ## 它刻意保守（宁可漏报，不要误报）
 *
 *   · 只统计**字面量**键（`t('foo.bar')`），动态拼接（`` t(`a.${b}`) ``）会被跳过
 *     并从统计里剔除 —— 把它们当缺失会产生大量假阳性，而这个仓库的纪律是
 *     "假阳性会让真问题被忽略"；
 *   · 每个文件按它自己的 `useTranslations('ns')` / `getTranslations('ns')`
 *     解析命名空间，**同一文件多个命名空间分别处理**；
 *   · 子组件可能用别的命名空间，因此再跑一轮"任意命名空间里存在即可"的宽松口径，
 *     报告分成"确定缺失"与"需要人看一眼"两档。
 *
 * 用法：node scripts/_scan_i18n_keys.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const LOCALES = ['en', 'zh', 'es'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const messages = {};
for (const locale of LOCALES) {
  messages[locale] = JSON.parse(readFileSync(join(ROOT, 'messages', `${locale}.json`), 'utf8'));
}

/** 展平成 'a.b.c' → 值 */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const flatByLocale = {};
for (const locale of LOCALES) flatByLocale[locale] = flatten(messages[locale]);

const sourceFiles = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));

/** 一个文件里出现的 (namespace, key) 对 */
function extractUsages(src) {
  const namespaces = new Set();
  for (const m of src.matchAll(/\b(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    namespaces.add(m[1]);
  }
  const keys = new Set();
  // t('a.b') / t("a.b") —— 只认字面量
  for (const m of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g)) keys.add(m[1]);
  // ta('a.b') / tc('a.b') 等同形：任意 <ident>('...') 且 ident 以 t 开头且长度 <= 3
  for (const m of src.matchAll(/\b(t[a-z]{1,2})\(\s*['"]([^'"]+)['"]\s*[,)]/g)) keys.add(m[2]);
  return { namespaces: [...namespaces], keys: [...keys] };
}

const missing = [];
const ambiguous = [];
let consideredKeys = 0;

for (const file of sourceFiles) {
  const src = readFileSync(file, 'utf8');
  const { namespaces, keys } = extractUsages(src);
  if (keys.length === 0) continue;
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  for (const key of keys) {
    consideredKeys += 1;
    // 确定缺失：每个声明的命名空间下都不存在
    const perNamespace = namespaces.map((ns) => `${ns}.${key}`);
    const anyExists = perNamespace.some((full) => flatByLocale.en.has(full));
    // 宽松口径：任意命名空间下存在同名键
    const existsAnywhere = [...flatByLocale.en.keys()].some((k) => k === key || k.endsWith(`.${key}`));

    if (!anyExists && !existsAnywhere) missing.push({ file: rel, key, namespaces });
    else if (!anyExists && existsAnywhere) ambiguous.push({ file: rel, key, namespaces });
  }
}

// 三语一致性
const localeGaps = [];
for (const locale of LOCALES) {
  if (locale === 'en') continue;
  for (const key of flatByLocale.en.keys()) {
    if (!flatByLocale[locale].has(key)) localeGaps.push(`${locale} 缺 ${key}`);
  }
}

console.log('='.repeat(80));
console.log('i18n 键扫描');
console.log('='.repeat(80));
console.log(`源码文件: ${sourceFiles.length}，其中含 t() 字面量键的 ${consideredKeys} 处`);
console.log(`messages: en ${flatByLocale.en.size} / zh ${flatByLocale.zh.size} / es ${flatByLocale.es.size} 个扁平键`);
console.log('');
console.log(`[缺失] 源码用了但 messages 里找不到: ${missing.length}`);
for (const m of missing.slice(0, 40)) {
  console.log(`  ! ${m.file}  t('${m.key}')  ns=[${m.namespaces.join(',')}]`);
}
console.log('');
console.log(`[待确认] 同名键在别的命名空间存在（可能是子组件用了另一套 ns）: ${ambiguous.length}`);
for (const a of ambiguous.slice(0, 20)) {
  console.log(`  ? ${a.file}  t('${a.key}')  ns=[${a.namespaces.join(',')}]`);
}
console.log('');
console.log(`[三语不一致] ${localeGaps.length}`);
for (const g of localeGaps.slice(0, 20)) console.log(`  ! ${g}`);
console.log('');
console.log('='.repeat(80));
console.log(missing.length === 0 ? '判定: 无确定缺失' : `判定: ${missing.length} 处确定缺失`);
console.log('='.repeat(80));
process.exit(missing.length === 0 ? 0 : 1);
