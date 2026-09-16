import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 12 / P0-4 —— 备份与回滚演练这两个运维脚本的行为契约。
 *
 * 备份校验器必须**能拒绝损坏的备份**。一个永远返回 OK 的校验器毫无价值，
 * 而且比没有更危险 —— 它会在真正需要恢复的那天才暴露。因此这里的重点是
 * 负向用例：篡改、缺失、无 manifest，三种都必须失败。
 *
 * 同一教训在本仓库出现过两次：secret 扫描的 `git grep --cached` 位置错误导致
 * "0 命中"被误读为"干净"；Mock LLM 的回复文案被误读成 Gate 生效。**任何
 * "通过" 结论都必须先有能产生 "不通过" 的证据。**
 */

let root: string;
let outDir: string;

function run(args: string[]) {
  // spawnSync 而不是 execFileSync：报告里的热备警告走 stderr（console.warn），
  // 而 execFileSync 成功时只返回 stdout —— 那样断言 stderr 的用例会假失败。
  // 这次假失败正好证明了该用例在真的检查输出，而不是永远通过。
  const result = spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    all: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('backup / verify (P0-4)', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'rf-backup-src-'));
    outDir = mkdtempSync(join(tmpdir(), 'rf-backup-dst-'));
    mkdirSync(join(root, 'audit'), { recursive: true });
    mkdirSync(join(root, 'tasks'), { recursive: true });
    writeFileSync(join(root, 'audit', 'tool_gate.jsonl'), '{"tool":"read_sales","allowed":false}\n');
    writeFileSync(join(root, 'state.db'), 'sqlite-placeholder-bytes');
    writeFileSync(join(root, 'SOUL.md'), '# soul\n');
    writeFileSync(join(root, 'tasks', '1.json'), '{"id":1}\n');
  });

  after(() => {
    for (const dir of [root, outDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function backupDir() {
    const result = run(['--root', root, '--out', outDir]);
    assert.equal(result.code, 0, result.stdout);
    const entries = execFileSync(process.execPath, [
      '-e',
      `const fs=require('fs');const d=process.argv[1];const e=fs.readdirSync(d).sort();process.stdout.write(require('path').join(d,e[e.length-1]));`,
      outDir,
    ], { encoding: 'utf8' });
    return entries;
  }

  test('a fresh backup verifies clean', () => {
    const dir = backupDir();
    const result = run(['--verify', dir]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.all, /备份完整且逐文件校验通过/);
  });

  test('the manifest records per-file sha256 and byte counts', () => {
    const dir = backupDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.fileCount, 4);
    assert.equal(manifest.files.length, 4);
    for (const f of manifest.files) {
      assert.match(f.sha256, /^[a-f0-9]{64}$/, `sha256 形态不对: ${f.path}`);
      assert.ok(f.bytes > 0);
    }
  });

  test('detects a DELETED file', () => {
    const dir = backupDir();
    rmSync(join(dir, 'data', 'SOUL.md'));
    const result = run(['--verify', dir]);
    assert.equal(result.code, 1, '删除文件后校验必须失败');
    assert.match(result.all, /缺失: SOUL\.md/);
  });

  test('detects a size change', () => {
    const dir = backupDir();
    writeFileSync(join(dir, 'data', 'tasks', '1.json'), '{"id":1,"extra":"more bytes"}\n');
    const result = run(['--verify', dir]);
    assert.equal(result.code, 1);
    assert.match(result.all, /大小不符/);
  });

  test('detects SAME-SIZE content tampering via sha256', () => {
    // 这是关键用例：大小相同、内容不同的篡改只能靠哈希发现。
    // 只比对大小的校验器会放它过去。
    const dir = backupDir();
    const file = join(dir, 'data', 'audit', 'tool_gate.jsonl');
    const buf = readFileSync(file);
    const idx = buf.indexOf(0x66); // 'f' of "false"
    assert.ok(idx >= 0, '测试数据里应含 false 字样');
    buf[idx] = 0x74; // -> "true", 长度不变
    writeFileSync(file, buf);

    const result = run(['--verify', dir]);
    assert.equal(result.code, 1, '同大小篡改必须被拒绝');
    assert.match(result.all, /sha256 不符/);
  });

  test('refuses a directory that is not a backup', () => {
    const plain = mkdtempSync(join(tmpdir(), 'rf-not-a-backup-'));
    try {
      const result = run(['--verify', plain]);
      assert.equal(result.code, 1);
      assert.match(result.all, /不是一份由本脚本产出的备份/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('refuses a missing data root', () => {
    const result = run(['--root', join(tmpdir(), 'definitely-not-here-rf'), '--out', outDir]);
    assert.equal(result.code, 1);
    assert.match(result.all, /数据根不存在/);
  });

  test('warns about hot SQLite files', () => {
    const dir = backupDir();
    const result = run(['--root', root, '--out', outDir]);
    assert.match(result.all, /\.db 文件/, '含 .db 时必须提示热备风险');
    assert.ok(existsSync(join(dir, 'manifest.json')));
  });
});
