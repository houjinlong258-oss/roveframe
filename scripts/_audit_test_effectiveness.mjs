/**
 * 只读审计脚本：**测试有效性**的两项测量。
 *
 * A. 路由覆盖：132 个 route.ts 里，有多少条的路径**从未出现在任何测试/验证脚本中**。
 *    这不是"用例数"，而是"这个入口有没有被真的调用过"。
 *
 * B. 断言形态：tests/*.test.ts 里有多少断言是在**读源码文本**（readFileSync + 正则/
 *    includes），而不是在观察行为。源码文本断言不等于行为断言：把 SQL 文件里的
 *    一句话删掉它会红，但**数据库里 RLS 有没有真的开**它看不见。
 *
 * 阴性对照：`--extra-dir <dir>` 可以把一个额外目录当作"测试来源"接进来。
 * 在临时目录里放一个提到某个原本未被覆盖路由的文件，那条路由必须由
 * uncovered 变成 covered —— 否则"未被覆盖"这个结论就是探针自己造出来的。
 *
 * 用法：node scripts/_audit_test_effectiveness.mjs [--extra-dir <dir>] [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');
const extraIdx = process.argv.indexOf('--extra-dir');
const EXTRA_DIRS = extraIdx >= 0 ? [process.argv[extraIdx + 1]] : [];
const JSON_OUT = process.argv.includes('--json');

function walkFiles(dir, out = [], filter = () => true) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out, filter);
    else if (filter(name)) out.push(full);
  }
  return out;
}

// ---------- 路由清单 ----------
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const routes = walkFiles(API_DIR, [], (n) => n === 'route.ts').map((file) => {
  const src = readFileSync(file, 'utf8');
  return {
    urlPath: '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/'),
    methods: METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(src)),
  };
});

// ---------- 测试/验证来源 ----------
const testFiles = [
  ...walkFiles(join(ROOT, 'tests'), [], (n) => n.endsWith('.ts') || n.endsWith('.mts')),
  // 排除本轮自己的取证脚本：否则探针会把自己引用过的路由算成"已覆盖"
  // （实测踩到过：_audit_unauth_probe.mjs 提到 /api/payments/checkout，
  //  于是那条路由被自己的探针"覆盖"了 —— 这是自证循环）。
  ...walkFiles(join(ROOT, 'scripts'), [], (n) => /\.(mjs|mts|ts)$/.test(n) && n.startsWith('_') && !n.startsWith('_audit_')),
  ...walkFiles(join(ROOT, 'roveagent'), [], (n) => n.endsWith('.py')),
  ...EXTRA_DIRS.flatMap((d) => walkFiles(d, [], () => true)),
];
const corpus = new Map();
for (const f of testFiles) {
  const rel = relative(ROOT, f).split(sep).join('/');
  corpus.set(rel, readFileSync(f, 'utf8'));
}
console.log(`# route files: ${routes.length}`);
console.log(`# test/verification sources scanned: ${corpus.size}`);

const covered = [];
const uncovered = [];
for (const r of routes) {
  // 精确路径；动态段用前缀匹配（/api/artifacts/[id] -> /api/artifacts/）
  const prefix = r.urlPath.replace(/\/\[[^\]]+\].*$/, '');
  const hits = [];
  for (const [rel, text] of corpus) {
    if (text.includes(r.urlPath) || (prefix !== r.urlPath && text.includes(prefix))) hits.push(rel);
  }
  (hits.length ? covered : uncovered).push({ ...r, hits: hits.slice(0, 3), hitCount: hits.length });
}

console.log(`ROUTES_REFERENCED_BY_TESTS=${covered.length}`);
console.log(`ROUTES_NEVER_REFERENCED=${uncovered.length}`);
if (!JSON_OUT) {
  console.log('--- never referenced (path absent from every test/verification source) ---');
  for (const r of uncovered) console.log(`  ${r.urlPath}  [${r.methods.join(',')}]`);
}

// ---------- 断言形态 ----------
const testOnly = walkFiles(join(ROOT, 'tests'), [], (n) => n.endsWith('.test.ts'));
let totalAssert = 0;
let textAssert = 0;
const textAssertFiles = [];
const zeroAssertFiles = [];
for (const f of testOnly) {
  const src = readFileSync(f, 'utf8');
  const asserts = (src.match(/assert\./g) ?? []).length;
  totalAssert += asserts;
  const readsSource = /readFileSync\s*\(/.test(src);
  // 文本断言：读了源码/迁移文件，并且用 includes / match 去断言它的内容
  const textual = readsSource && /\.(includes|match|test)\s*\(/.test(src);
  if (textual) {
    textAssertFiles.push({ file: relative(ROOT, f).split(sep).join('/'), asserts, readsSource });
    textAssert += (src.match(/assert\.(ok|equal|match|strictEqual|notEqual|deepEqual)\([^)]*(includes|match|test|\/)/g) ?? []).length;
  }
  if (asserts === 0) zeroAssertFiles.push(relative(ROOT, f).split(sep).join('/'));
}
console.log(`TEST_FILES=${testOnly.length} TOTAL_ASSERT_CALLS=${totalAssert}`);
console.log(`FILES_THAT_READ_SOURCE_AND_ASSERT_ON_TEXT=${textAssertFiles.length}`);
console.log(`ZERO_ASSERT_TEST_FILES=${zeroAssertFiles.length} ${JSON.stringify(zeroAssertFiles)}`);
if (!JSON_OUT) {
  console.log('--- source-text assertion files (top 20 by assert count) ---');
  for (const t of textAssertFiles.sort((a, b) => b.asserts - a.asserts).slice(0, 20)) {
    console.log(`  ${String(t.asserts).padStart(4)} asserts  ${t.file}`);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ uncovered: uncovered.map((r) => r.urlPath), covered: covered.length, textAssertFiles: textAssertFiles.length }, null, 2));
}
