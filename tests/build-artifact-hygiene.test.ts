import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 部署产物里不得夹带 `.next/dev`。
 *
 * ## 实测（2026-09-25）
 *
 *     .next            495.8 MB
 *     ├── dev          389.6 MB   ← 开发模式产物，生产不读
 *     ├── server       102.3 MB   ← 真正要跑的
 *     └── static         2.1 MB
 *
 * 而 **`next build` 不会清理 `.next/dev`** —— 同一份 workspace 上各测一次，
 * 构建前后都是 389.6 MB。于是 79% 的产物是开发垃圾。
 *
 * 云端部署尤其吃亏：`.coze` 的 `[dev]`（prepare.sh + dev.sh）与
 * `[deploy]`（build.sh + start.sh）指向**同一个 workspace**，开发预览写下的
 * `.next/dev` 会被原样带进部署产物。（Docker 构建是全新 builder 阶段、只跑一次
 * `next build`，所以没这个问题 —— 那里删掉也只是无操作。）
 *
 * 本测试锁住"构建脚本会清掉它"，并顺带确认那个目录确实是 dev 产物、不是运行时要读的。
 */

const ROOT = process.cwd();
const buildSh = readFileSync(join(ROOT, 'scripts', 'build.sh'), 'utf8');

/**
 * 构建脚本是否在 `next build` **之后**清理 `.next/dev`。
 *
 * 顺序有意义：构建过程本身不该受影响，只有确定要产出部署产物时才清。
 * 两种写法都要认（字面路径 / 变量），且不锚定行尾 —— 第一版把 `rm -rf "…"; fi`
 * 这种同行多语句的写法漏判了，是负向对照把它抓出来的。
 * 由下面的自证用例证明它能返回 true，否则是空断言。
 */
function cleansDevArtifactsAfterBuild(script: string): boolean {
  const clean = /rm -rf\s+"?\$?\{?DEV_ARTIFACTS\}?"?|rm -rf\s+\.next\/dev/.exec(script);
  const build = /next build/.exec(script);
  if (clean === null) return false;
  return build !== null && clean.index > build.index;
}

describe('部署产物不夹带开发垃圾', () => {
  test('.next/dev 确实是开发产物（运行时要读的是 server / static）', () => {
    const nextDir = join(ROOT, '.next');
    if (!existsSync(nextDir)) {
      // 没构建过不代表没问题；直接跳过目录断言，只保留脚本断言
      return;
    }
    const entries = readdirSync(nextDir);
    // 生产运行入口读的是 .next/server 与 .next/static；dev 只是开发服务器的磁盘状态
    assert.ok(entries.includes('server'), '生产构建必须产出 .next/server');
    assert.ok(
      !entries.includes('dev') || statSync(join(nextDir, 'dev')).isDirectory(),
      '.next/dev 若存在应当是目录（开发模式产物）',
    );
  });

  test('构建脚本在 next build 之后清理 .next/dev', () => {
    assert.match(
      buildSh,
      /DEV_ARTIFACTS="\.next\/dev"|rm -rf\s+\.next\/dev/,
      'build.sh 必须清理 .next/dev —— next build 不会帮你清（实测前后都是 389.6 MB）',
    );
    assert.equal(
      cleansDevArtifactsAfterBuild(buildSh),
      true,
      '清理必须发生在 next build **之后**：构建过程不该受影响，只在产出部署产物时才清',
    );
  });

  test('清理前先判断存在，并对不存在的目录保持无操作（Docker 全新构建场景）', () => {
    assert.match(
      buildSh,
      /if \[ -d "\$\{DEV_ARTIFACTS\}" \]; then/,
      '应当先判断目录存在再删 —— Docker 的全新 builder 阶段没有这个目录，删它是无操作',
    );
  });

  test('负向对照：检测器能判出「没清」与「清在构建之前」', () => {
    const none = '#!/bin/bash\npnpm next build\npnpm tsup src/server.ts\n';
    assert.equal(cleansDevArtifactsAfterBuild(none), false, '没有清理步骤必须判为不合格');

    const before = '#!/bin/bash\nrm -rf .next/dev\npnpm next build\n';
    assert.equal(
      cleansDevArtifactsAfterBuild(before),
      false,
      '清在 next build 之前必须判为不合格 —— 那样连构建都可能受影响',
    );

    const after = '#!/bin/bash\npnpm next build\nDEV_ARTIFACTS=".next/dev"\nif [ -d "${DEV_ARTIFACTS}" ]; then rm -rf "${DEV_ARTIFACTS}"; fi\n';
    assert.equal(cleansDevArtifactsAfterBuild(after), true, '正确顺序必须判为合格');
  });
});
