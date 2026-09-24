import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 文件中心的「最近 N 个」必须是**真的最近 N 个**。
 *
 * ## 实测缺陷（2026-09-25）
 *
 * 端到端出片成功后，用 `?limit=5` 拉文件列表，**刚生成的视频不在里面** ——
 * 明明在桶里（用 limit=50 就能看到，且它是最新一条）。
 *
 * 原因：`listArtifacts` 在 `storage.list` 的返回顺序上**先按 limit 截断、后按时间排序**，
 * 而该顺序是任意的（不保证按时间）。于是 `limit=5` 的实际语义是
 * 「随便 5 个产物，排个序」而不是「最新的 5 个」。
 *
 * 对用户的影响很直接：生成完文件去看文件中心，最新的那个可能不在列表里，
 * 看起来像"没保存成功"。
 */

const ROOT = process.cwd();
const STORE = join('src', 'lib', 'artifacts', 'store.ts');
const source = readFileSync(join(ROOT, STORE), 'utf8');

/** 取出 `listArtifacts` 的函数体（到下一个顶层 export 为止）。 */
function listArtifactsBody(src: string): string {
  const start = src.indexOf('export async function listArtifacts');
  assert.ok(start !== -1, '找不到 listArtifacts，守卫需要同步更新');
  const rest = src.slice(start + 10);
  const nextExport = rest.indexOf('\nexport ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

const body = listArtifactsBody(source);

/**
 * 是否存在「先按 limit 截断、后排序」的错误顺序。
 * 由下面的负向对照证明它能返回 true，否则它是一条空断言。
 */
function slicesBeforeSorting(src: string): boolean {
  const sortAt = src.search(/\.sort\(\(a, b\) => b\.createdAt/);
  if (sortAt === -1) return false;
  const before = src.slice(0, sortAt);
  return /\.slice\(\s*0\s*,\s*options\.limit/.test(before)
    || /\.slice\(\s*0\s*,\s*options\.limit\s*\?\?/.test(before);
}

describe('文件中心列表：limit 必须在排序之后', () => {
  test('存在按 createdAt 倒序的排序', () => {
    assert.match(
      body,
      /\.sort\(\(a, b\) => b\.createdAt\.localeCompare\(a\.createdAt\)\)/,
      '列表必须按创建时间倒序，否则「最近」无从谈起',
    );
  });

  test('limit 的截断发生在排序之后', () => {
    assert.equal(
      slicesBeforeSorting(body),
      false,
      'limit 不能在排序前截断 —— storage.list 的返回顺序是任意的，' +
        '先截断会让 limit=5 变成「随便 5 个」，刚生成的文件可能不在列表里。',
    );
    const sortAt = body.search(/\.sort\(\(a, b\) => b\.createdAt/);
    assert.ok(
      /\.slice\(0, options\.limit\)/.test(body.slice(sortAt)),
      '排序之后必须真的按 limit 截断，否则 limit 参数失效',
    );
  });

  test('负向对照：检测器能把「先截断后排序」判出来', () => {
    const buggy = [
      'const ids = folders.map((e) => e.name).filter(isArtifactId).slice(0, options.limit ?? MAX_LISTED_ARTIFACTS);',
      'const records = await mapLimited(ids, 8, (id) => readManifest(scope, id));',
      'filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));',
    ].join('\n');
    assert.equal(slicesBeforeSorting(buggy), true, '检测器必须能识别出这种错误顺序');

    const good = [
      'const ids = folders.map((e) => e.name).filter(isArtifactId);',
      'filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));',
      'if (options.limit) filtered = filtered.slice(0, options.limit);',
    ].join('\n');
    assert.equal(slicesBeforeSorting(good), false, '检测器不得把正确顺序误判为错误');
  });
});
