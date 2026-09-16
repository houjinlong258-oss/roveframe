#!/usr/bin/env node
/**
 * 回滚演练（Phase 12 / P0-4）。
 *
 * ## 为什么需要
 *
 * 审计把「无回滚演练」列为 P0：Phase 11 之前工作树根本不在版本控制里，
 * 所以"回滚"这件事从未被执行过，也就从未被证明可行。回滚能力不是
 * "有 git 历史"这么一句话，而是"能在压力下按步骤执行且不丢数据"。
 *
 * ## 做什么
 *
 * 在**临时目录**里用 `git worktree` 检出目标提交，然后核验：
 *
 *   1. 目标提交可达且能完整检出（不是只存在于 reflog 里的悬空对象）；
 *   2. 关键文件在目标提交里齐备；
 *   3. **数据库迁移是否随之回退** —— 这是最容易出事的一步：代码回滚了、
 *      迁移没回滚，旧代码会读到它不认识的列；反过来更糟，新代码已经写入的
 *      数据在旧 schema 下不可读。脚本会比对两个提交之间的 `scripts/migrate*.sql`
 *      与 `schema.ts`，并在有差异时明确标红。
 *
 * 全程**不触碰当前工作树**，结束时清理 worktree。
 *
 * ## 不做什么
 *
 * 它不执行"真实的回滚"（不切换 HEAD、不重建镜像、不重启服务）。演练的目的是
 * 在不产生风险的前提下证明路径可用；真正的回滚仍需人工决策，其步骤由本脚本
 * 在最后打印。
 *
 * ## 用法
 *
 *     node scripts/rollback-drill.mjs                # 演练回退到 HEAD~1
 *     node scripts/rollback-drill.mjs --to <sha>     # 演练回退到指定提交
 *     node scripts/rollback-drill.mjs --keep         # 保留 worktree 供人工检查
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED_FILES = [
  'package.json',
  'src/server.ts',
  'roveagent/api/app.py',
  'Dockerfile',
  'Dockerfile.roveagent',
  'docker-compose.yml',
  '.github/workflows/ci.yml',
];

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tryGit(args, cwd = process.cwd()) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

function parseArgs(argv) {
  const args = { to: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--to') args.to = argv[++i];
    else if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/rollback-drill.mjs [--to <commit>] [--keep]');
    return 0;
  }

  const problems = [];
  const warnings = [];

  const head = git(['rev-parse', 'HEAD']);
  const target = args.to || 'HEAD~1';
  const targetSha = tryGit(['rev-parse', target]);
  if (!targetSha.ok) {
    console.error(`FAIL: 目标提交不可解析: ${target}`);
    return 1;
  }

  console.log('='.repeat(74));
  console.log('回滚演练（不触碰当前工作树）');
  console.log('='.repeat(74));
  console.log(`当前 HEAD : ${head.slice(0, 12)} ${tryGit(['log', '-1', '--format=%s', 'HEAD']).out}`);
  console.log(`演练目标  : ${targetSha.out.slice(0, 12)} ${tryGit(['log', '-1', '--format=%s', targetSha.out]).out}`);
  console.log('');

  // ---- 1. 目标提交可达且可完整检出 -------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), 'rf-rollback-drill-'));
  const worktree = join(tmp, 'wt');
  let added = false;
  try {
    const add = tryGit(['worktree', 'add', '--detach', worktree, targetSha.out]);
    if (!add.ok) {
      problems.push(`无法检出目标提交（提交对象损坏或不可达）: ${add.out}`);
    } else {
      added = true;
      console.log(`[1] 检出成功 -> ${worktree}`);

      // ---- 2. 关键文件齐备 --------------------------------------------
      const missing = REQUIRED_FILES.filter((f) => !existsSync(join(worktree, f)));
      if (missing.length) {
        problems.push(`目标提交缺少关键文件: ${missing.join(', ')}`);
        console.log(`[2] 关键文件: 缺失 ${missing.length} 个`);
      } else {
        console.log(`[2] 关键文件: ${REQUIRED_FILES.length}/${REQUIRED_FILES.length} 齐备`);
      }

      // ---- 3. 迁移/chema 是否随之回退 ---------------------------------
      // 代码回滚而迁移不回滚，是最容易造成数据不可读的一步。
      const changed = tryGit(
        ['diff', '--name-only', targetSha.out, head],
        process.cwd(),
      );
      if (changed.ok) {
        const files = changed.out.split('\n').filter(Boolean);
        const migrations = files.filter((f) => /^scripts\/migrate.*\.sql$/.test(f));
        const schema = files.filter((f) => f === 'src/storage/database/shared/schema.ts');
        console.log(`[3] 两个提交之间共 ${files.length} 个文件变化`);
        if (migrations.length || schema.length) {
          warnings.push(
            '本次回滚跨越了数据库 schema 变更 —— 必须先确认迁移方向，再决定是否回滚代码：\n' +
            [...migrations, ...schema].map((f) => `        · ${f}`).join('\n'),
          );
          console.log(`[3] schema/迁移变化: ${migrations.length + schema.length} 个（见下方警告）`);
        } else {
          console.log('[3] schema/迁移: 无变化 —— 这是一次纯代码回滚，风险较低');
        }
      } else {
        warnings.push('无法比对两个提交的差异，schema 影响未知');
      }
    }
  } finally {
    if (added && !args.keep) {
      tryGit(['worktree', 'remove', '--force', worktree]);
      console.log('[4] worktree 已清理');
    } else if (added) {
      console.log(`[4] worktree 保留（--keep）: ${worktree}`);
    }
    if (!args.keep) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  console.log('');
  for (const w of warnings) console.log(`警告: ${w}`);
  for (const p of problems) console.error(`问题: ${p}`);

  if (problems.length) {
    console.log('\n结论: 回滚路径**不可用** —— 先解决上面的问题。');
    return 1;
  }

  console.log('结论: 回滚路径可用。真实回滚需要人工执行以下步骤（本脚本刻意不代做）：');
  console.log(`  1. git checkout ${targetSha.out.slice(0, 12)}   # 或从该提交重建镜像`);
  console.log('  2. 按上面的 schema 结论决定是否回退迁移（有差异时不要跳过）');
  console.log('  3. 重建镜像并重启；RoveAgent 状态卷不要动（回滚代码不该回滚数据）');
  console.log('  4. 用 node scripts/backup.mjs --verify <备份> 确认手上有一份可用备份');
  console.log('='.repeat(74));
  return 0;
}

process.exit(main());
