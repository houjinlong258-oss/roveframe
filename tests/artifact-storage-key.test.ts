import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { storageSafeName, sanitizeFileName } from '../src/lib/artifacts/protocol';

/**
 * 产物存储 key 必须是 ASCII —— 一次让「所有文件生成都失败」的真实故障。
 *
 * ## 故障现场
 *
 * 用户报告：「生成 PDF 失败，生成所有东西都失败，只能对话」。
 * 复现（真实 /api/agent/chat + 真实 Supabase Storage）拿到的 technical 是：
 *
 *     Invalid key:
 *     00000000-…-000000000000/00000000-…-000000000001/614c7377-…/
 *     写一份本月经营分析报告内容要完整并_成_报告_20260925.pdf
 *
 * 同一次对话里的另一个产物 `Data_1790267931096.xlsx`（程序生成的 ASCII 名）
 * **上传成功，4611 字节**。差异只有一个：文件名里有没有中文。
 *
 * 根因：产物名从老板原话派生（`slugifyTitle(slugFromMessage(…))`），中文用户的
 * 每个文件名都带中文，而 Supabase Storage 对非 ASCII 的 object key 直接返回
 * `Invalid key`。`sanitizeFileName` 只防路径穿越与控制字符，**允许任意 Unicode
 * 字母**，所以它产出的名字不能当 key 用。
 *
 * 于是 PDF / DOCX / XLSX / PPTX / HTML **全部**交付失败 —— 一个根因解释了全部症状。
 *
 * ## 修法：展示名与对象名解耦
 *
 * 展示名（manifest.name）保留中文，老板要看懂；对象名由 `storageSafeName`
 * 确定性地派生为 ASCII。两者必须分开，且派生必须确定性 ——
 * `signArtifact` / `deleteArtifact` / `readArtifactText` / `readArtifactBytes`
 * 都要用它重算路径，各写各的话，写进去的文件就读不回来了。
 */

const ROOT = process.cwd();
const STORE = join('src', 'lib', 'artifacts', 'store.ts');
const storeSource = readFileSync(join(ROOT, STORE), 'utf8');

/** 存储 key 的安全字符集。 */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/** 真实会出现的展示名语料：中文、emoji、空格、路径穿越、超长。 */
const DISPLAY_NAMES = [
  '写一份本月经营分析报告内容要完整并_成_报告_20260925.pdf',
  '本月经营分析报告_20260925.xlsx',
  '四川人家-库存盘点表_20260925.docx',
  '促销海报设计稿.png',
  '季度总结汇报.pptx',
  '经营看板.html',
  '📊 数据报表 2026.pdf',
  'Report_20260925.pdf',
  '../../etc/passwd',
  'a'.repeat(300) + '.pdf',
  'no-extension',
  '   ',
  '报告.zip',
];

describe('storageSafeName —— 派生规则', () => {
  test('中文名派生成 ASCII，且保留扩展名', () => {
    const key = storageSafeName('本月经营分析报告_20260925.pdf', 'pdf');
    assert.ok(SAFE_KEY.test(key), `派生结果必须是安全 ASCII，实际: ${key}`);
    assert.ok(key.endsWith('.pdf'), `扩展名必须保留，实际: ${key}`);
  });

  test('全是中文的名字退化为 artifact.<ext>，而不是空串或纯扩展名', () => {
    assert.equal(storageSafeName('月度报告.pdf', 'pdf'), 'artifact.pdf');
    assert.equal(storageSafeName('报告', 'txt'), 'artifact.txt');
  });

  test('ASCII 名字原样保留（不该被无谓改写）', () => {
    assert.equal(storageSafeName('Report_20260925.pdf', 'pdf'), 'Report_20260925.pdf');
    assert.equal(storageSafeName('Data-1.xlsx', 'xlsx'), 'Data-1.xlsx');
  });

  test('确定性：同一展示名永远派生出同一个 key', () => {
    for (const name of DISPLAY_NAMES) {
      assert.equal(storageSafeName(name, 'pdf'), storageSafeName(name, 'pdf'), `不稳定: ${name}`);
    }
  });

  test('路径穿越被消除：结果里不含 / 也不含 ..', () => {
    const key = storageSafeName('../../etc/passwd', 'txt');
    assert.ok(!key.includes('/'), `不得含斜杠: ${key}`);
    assert.ok(!key.includes('..'), `不得含 ..: ${key}`);
  });

  test('超长名被截断，不会撑爆 key 长度', () => {
    const key = storageSafeName('a'.repeat(300) + '.pdf', 'pdf');
    assert.ok(key.length <= 90, `过长: ${key.length}`);
    assert.ok(SAFE_KEY.test(key));
  });

  test('emoji 与空白被剥离，不会产出以 . 或 _ 开头的 key', () => {
    for (const name of ['📊 数据报表 2026.pdf', '   ', '   .pdf']) {
      const key = storageSafeName(name, 'pdf');
      assert.ok(SAFE_KEY.test(key), `非安全 key: ${key}`);
      assert.ok(!/^[._-]/.test(key), `不得以 . _ - 开头: ${key}`);
    }
  });

  test('没有扩展名时用 fallbackExt', () => {
    assert.equal(storageSafeName('no-extension', 'xlsx'), 'no-extension.xlsx');
    assert.equal(storageSafeName('报告', 'pptx'), 'artifact.pptx');
  });
});

describe('不变量：任何展示名派生出的 key 都在安全字符集内', () => {
  test('全语料逐条满足 SAFE_KEY', () => {
    for (const name of DISPLAY_NAMES) {
      const key = storageSafeName(name, 'pdf');
      assert.ok(SAFE_KEY.test(key), `展示名「${name}」派生出非安全 key: ${key}`);
    }
  });

  test('负向对照：原始展示名本身**并不**满足该字符集（否则上面的断言是空转的）', () => {
    const violating = DISPLAY_NAMES.filter((name) => !SAFE_KEY.test(name));
    assert.ok(
      violating.length >= 3,
      `语料里必须有若干本身就不安全的展示名，否则这条不变量测不出任何东西。实际: ${violating.length}`,
    );
    // 中文名必须在内，它正是线上失败的那一类
    assert.ok(violating.some((n) => /[\u4e00-\u9fa5]/.test(n)), '中文展示名必须落在不安全集合里');
  });

  test('负向对照：sanitizeFileName 保留中文 —— 它不能当 key 用（本缺陷的成因）', () => {
    const display = sanitizeFileName('写一份本月经营分析报告.pdf', 'pdf');
    assert.ok(/[\u4e00-\u9fa5]/.test(display), 'sanitizeFileName 允许中文，这是它作为展示名清洗器的设计');
    assert.equal(SAFE_KEY.test(display), false, '正因为它不安全，才必须再过一层 storageSafeName');
  });
});

/**
 * 「路径由展示名拼成」的检测器。
 * 返回所有 `/ ${record.name}` 或 `/ ${name}` 形式的路径插值。
 * 由下面的自测用例证明它**能返回非空**，否则它是条永远为真（永远通过）的断言。
 */
function pathsBuiltFromDisplayName(source: string): string[] {
  return [...source.matchAll(/\/\$\{(?:record\.)?name\}/g)].map((m) => m[0]);
}

describe('store.ts 的存储路径必须走 objectNameFor', () => {
  test('没有任何路径直接拼接展示名', () => {
    const offenders = pathsBuiltFromDisplayName(storeSource);
    assert.deepEqual(
      offenders,
      [],
      `存储路径不得直接用展示名（中文会撞 Invalid key）：${offenders.join(', ')}\n` +
        '统一改用 objectNameFor(record) —— 写入/签名/删除/读取必须用同一个派生。',
    );
  });

  test('写入、签名、删除、读取四处都确实用了 objectNameFor', () => {
    const uses = (storeSource.match(/objectNameFor\(/g) ?? []).length;
    assert.ok(
      uses >= 5,
      `objectNameFor 至少应被使用 5 次（定义 1 + 写入 1 + 签名 1 + 删除 1 + 读取 2），实际 ${uses} 次`,
    );
  });

  test('负向对照：检测器能把「直接拼展示名」的写法判出来', () => {
    const bad = 'await storage.download(`${prefix}/${artifactId}/${record.name}`)';
    assert.equal(pathsBuiltFromDisplayName(bad).length, 1, '检测器必须能识别被拼进路径的 record.name');
    const bad2 = 'const objectPath = `${p}/${id}/${name}`';
    assert.equal(pathsBuiltFromDisplayName(bad2).length, 1, '检测器必须能识别被拼进路径的裸 name');
    const good = 'await storage.download(`${prefix}/${artifactId}/${objectNameFor(record)}`)';
    assert.equal(pathsBuiltFromDisplayName(good).length, 0, '检测器不得把正确写法误判为违规');
  });
});
