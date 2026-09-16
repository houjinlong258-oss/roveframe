#!/usr/bin/env node
/**
 * RoveAgent 状态备份（Phase 12 / P0-4）。
 *
 * ## 为什么需要
 *
 * 审计把「无备份」列为 P0：RoveAgent 的数据根（容器里的 `/data` 卷）装着
 * 聊天会话、租户记忆、审计记录、任务队列与已安装技能。在此之前它**没有任何
 * 备份手段** —— 卷丢了就是永久丢失，而审计链路本身也在这上面。
 *
 * ## 做什么
 *
 * 把数据根整目录复制到 `backups/<UTC 时间戳>/`，并写一份 `manifest.json`：
 * 每个文件的相对路径、字节数、sha256，以及总计。`--verify` 可以据此逐文件
 * 复校，确认这份备份是完整且未被截断的。
 *
 * 刻意选择**目录复制**而不是打包：不引入任何依赖（无 tar 库）、跨平台一致、
 * 且备份内容可以直接用普通工具查看 —— 出事时这比省几个字节重要。
 *
 * ## 已知边界（不掩盖）
 *
 * - **SQLite 热备**：`state.db` / `chat_sessions.db` / `enterprise_memory.db`
 *   在服务运行中被复制时，可能拿到写入中途的快照。脚本会对 `.db` 文件打印
 *   显式告警。要拿到一致快照，请停服务后备份，或使用容器卷快照。
 * - **数据库本体不在此脚本内**：Supabase 是外部服务，备份它需要 DSN 或
 *   供应商自带机制，见文件末尾说明。
 * - **不加密**：输出目录可能含租户数据，请落在受控位置。
 *
 * ## 用法
 *
 *     node scripts/backup.mjs                      # 备份默认数据根
 *     node scripts/backup.mjs --root /data         # 指定数据根
 *     node scripts/backup.mjs --out /backups       # 指定输出目录
 *     node scripts/backup.mjs --verify backups/xxx # 校验一份已有备份
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const EXCLUDED_DIRS = new Set(['__pycache__', '.git', 'node_modules']);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 递归收集文件（返回绝对路径），跳过排除目录。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function defaultRoot() {
  return process.env.ROVEAGENT_ROOT
    || join(process.env.ROVEAGENT_HOME || '', 'roveagent')
    || '.roveagent';
}

function parseArgs(argv) {
  const args = { root: process.env.ROVEAGENT_ROOT || '.roveagent', out: 'backups', verify: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--verify') args.verify = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function verify(backupDir) {
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`FAIL: ${manifestPath} 不存在，这不是一份由本脚本产出的备份`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let checked = 0;
  const problems = [];
  for (const f of manifest.files) {
    const full = join(backupDir, 'data', f.path);
    if (!existsSync(full)) {
      problems.push(`缺失: ${f.path}`);
      continue;
    }
    const actualSize = statSync(full).size;
    if (actualSize !== f.bytes) {
      problems.push(`大小不符: ${f.path} (期望 ${f.bytes}, 实际 ${actualSize})`);
      continue;
    }
    if (sha256(full) !== f.sha256) {
      problems.push(`sha256 不符: ${f.path}`);
      continue;
    }
    checked += 1;
  }
  console.log(`校验 ${checked}/${manifest.files.length} 个文件（来源 ${manifest.source}，时间 ${manifest.createdAt}）`);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} 处问题`);
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    return 1;
  }
  console.log('OK: 备份完整且逐文件校验通过');
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/backup.mjs [--root <数据根>] [--out <输出目录>] | --verify <备份目录>');
    return 0;
  }

  if (args.verify) {
    return verify(resolve(args.verify));
  }

  const root = resolve(args.root);
  if (!existsSync(root)) {
    console.error(`FAIL: 数据根不存在: ${root}`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = resolve(args.out, stamp);
  const destData = join(destDir, 'data');
  mkdirSync(destData, { recursive: true });

  const files = walk(root);
  const entries = [];
  let totalBytes = 0;
  let hotDatabases = 0;

  for (const file of files) {
    const rel = relative(root, file);
    const dest = join(destData, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(file, dest);
    const bytes = statSync(dest).size;
    totalBytes += bytes;
    entries.push({ path: rel.split('\\').join('/'), bytes, sha256: sha256(dest) });
    if (rel.endsWith('.db')) hotDatabases += 1;
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    source: root,
    fileCount: entries.length,
    totalBytes,
    files: entries,
    notes: [
      'SQLite 文件在服务运行中被复制时可能是写入中途的快照；一致备份请停服务或使用卷快照。',
      'Supabase（外部数据库）不在此备份内，见 scripts/backup.mjs 文件末尾说明。',
    ],
  };
  writeFileSync(join(destDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`备份完成: ${destDir}`);
  console.log(`  文件 ${entries.length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (hotDatabases > 0) {
    console.warn(
      `  警告: 含 ${hotDatabases} 个 .db 文件 —— 服务运行中复制可能是不一致快照。` +
      '要拿到一致快照请停服务或使用容器卷快照。',
    );
  }
  console.log(`  校验: node scripts/backup.mjs --verify "${destDir}"`);
  return 0;
}

/* ---------------------------------------------------------------------------
 * Supabase（外部数据库）备份说明 —— 刻意不做成脚本的一部分
 *
 * 它需要 DSN 或供应商凭据，而"在应用服务器上放数据库超级凭据"正是 R-03 要
 * 消除的模式。正确做法是二选一：
 *
 *   1. 托管备份：在 Supabase 项目设置里启用 PITR / 每日备份（推荐，无需凭据）。
 *   2. 独立备份主机：用 `pg_dump "$DATABASE_URL" -Fc` 在有凭据的机器上执行，
 *      产物落到对象存储。不要把 DATABASE_URL 配到本应用服务器上。
 *
 * 本脚本覆盖的是**应用侧状态**（会话/记忆/审计/任务），它与数据库是两类
 * 不同且互补的恢复单元。
 * ------------------------------------------------------------------------- */

export { verify, walk, sha256, defaultRoot };
process.exit(main());
