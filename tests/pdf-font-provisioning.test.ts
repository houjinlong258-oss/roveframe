import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 中文字体必须在**每一次部署构建**里被供给 —— 否则云端中文 PDF 静默降级。
 *
 * ## 现场
 *
 * 用户部署在 Coze 云端，`.coze` 的 `[deploy] build = bash scripts/build.sh`。
 * 而字体是**供给(fetch)不是源码**：`.gitignore` 里写着
 * "CJK fonts are PROVISIONED, not source"，`public/fonts/*.ttf` 被排除
 * （那个文件 16.95 MB）。所以任何一次干净检出或云端构建都不会自带它。
 *
 * Dockerfile 早就补了这一步，**但 build.sh 没有** —— 于是云端构建出来的实例
 * 永远没有字体，中文 PDF 一直降级成 Word/网页，而用户只看到"生成 PDF 失败"。
 *
 * 这条守卫锁住三件事的**耦合**，缺一不可：
 *   1. `.gitignore` 排除该字体      → 所以它必须被供给
 *   2. 构建脚本执行供给脚本          → 所以在部署时真的有
 *   3. 读取端在 `public/fonts` 找它  → 所以供给到那里是有效的
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const buildSh = read('scripts/build.sh');
const dockerfile = read('Dockerfile');
const gitignore = read('.gitignore');
const pdfWriter = read('src/lib/artifacts/pdf-writer.ts');

/**
 * 构建脚本是否**在有守卫的情况下**供给字体。
 *
 * `set -Eeuo pipefail` 下，一行裸的 `node scripts/setup-pdf-font.mjs` 失败会**中断整个构建**
 * —— 那与"缺字体只是少一个格式"的既定取舍矛盾。所以必须是 `if ! …; then` 或 `|| …` 形式。
 * 由下面的自证用例证明它能返回 true，否则是空断言。
 */
function provisionsFontSafely(script: string): boolean {
  const guarded = /if\s+!\s*node\s+scripts\/setup-pdf-font\.mjs/.test(script)
    || /node\s+scripts\/setup-pdf-font\.mjs[^\n]*\|\|/.test(script);
  return guarded;
}

describe('字体供给的三段耦合', () => {
  test('① .gitignore 确实排除了该字体（所以必须供给）', () => {
    assert.match(
      gitignore,
      /public\/fonts\/\*\.ttf/,
      '若这条规则被删，说明字体进了版本库 —— 那时本守卫的前提变了，要重新评估',
    );
  });

  test('② 读取端在 public/fonts 找字体（所以供给到那里有效）', () => {
    assert.match(
      pdfWriter,
      /public['"`,\s]*[)']?\s*[,)]?\s*fonts|'public',\s*'fonts'|"public",\s*"fonts"/,
      '读取端必须包含 public/fonts 这一候选，否则构建供给到哪里都没用',
    );
  });

  test('③ 云端构建脚本供给字体，且失败不中断构建', () => {
    assert.match(buildSh, /node scripts\/setup-pdf-font\.mjs/, 'build.sh 必须执行字体供给脚本');
    assert.equal(
      provisionsFontSafely(buildSh),
      true,
      'build.sh 开头是 set -Eeuo pipefail，裸调用会让缺字体变成构建失败；' +
        '必须用 if ! … / || … 包住（缺字体只是少一个格式，不是新的失败模式）',
    );
  });

  test('④ Docker 构建同样供给（两条部署路径行为一致）', () => {
    assert.match(dockerfile, /node scripts\/setup-pdf-font\.mjs/, 'Dockerfile 必须也供给字体');
    assert.match(dockerfile, /\|\|\s*echo/, 'Dockerfile 的供给也是 best-effort');
  });

  test('⑤ 云端构建脚本就是 .coze 声明的那一个（防止改错文件）', () => {
    const coze = read('.coze');
    assert.match(coze, /\[deploy\][\s\S]*?build\s*=\s*\["bash",\s*"scripts\/build\.sh"\]/,
      '.coze 的 deploy.build 必须仍指向 scripts/build.sh —— 否则上面几条守的是别的文件');
  });
});

describe('负向对照：检测器能判出缺失与不安全写法', () => {
  test('没有供给步骤的构建脚本必须被判为不合格', () => {
    const without = '#!/bin/bash\nset -Eeuo pipefail\npnpm next build\n';
    assert.equal(provisionsFontSafely(without), false, '检测器必须能识别"根本没做这一步"');
    assert.equal(/node scripts\/setup-pdf-font\.mjs/.test(without), false);
  });

  test('裸调用（会被 pipefail 中断）必须被判为不安全', () => {
    const unguarded = '#!/bin/bash\nset -Eeuo pipefail\nnode scripts/setup-pdf-font.mjs\npnpm next build\n';
    assert.equal(
      provisionsFontSafely(unguarded),
      false,
      '裸调用在 set -e 下失败即中断 —— 检测器必须把这种写法判为不合格',
    );
  });

  test('两种安全写法都要被判为合格', () => {
    assert.equal(provisionsFontSafely('if ! node scripts/setup-pdf-font.mjs; then echo WARN; fi'), true);
    assert.equal(provisionsFontSafely('node scripts/setup-pdf-font.mjs || echo WARN'), true);
  });
});
