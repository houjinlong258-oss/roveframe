/**
 * Production Hardening — Apply Engine
 *
 * 把"approved"的 CodingProposal 真实落地为代码变更，全流程：
 *
 *   1. 状态守卫：仅 approved 可应用；applied 可回滚
 *   2. 路径复检：每条 change 重新过 permission-guard.checkPath（不信任提案自报）
 *   3. git worktree 隔离：在 .worktrees/<proposalId> 的 agent/<id> 分支写入，
 *      主工作区不被直接编辑
 *   4. 合入主干：git merge --no-ff；冲突即 abort 并标记 apply_failed
 *   5. 自动测试：tsx --test 全量 + tsc 类型检查；任一失败自动 revert 合入
 *   6. 全量留痕：状态、commit sha、日志写回提案 + audit_logs
 *
 * 安全红线：
 *   - 永不动用 git reset --hard / clean -fdx（工作区可能有用户未提交改动）
 *   - 失败回退一律用 revert / merge --abort，不破坏既有工作区
 *   - 工作区与提案目标文件有重叠的未提交改动时拒绝合入（防止覆盖人工修改）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CodingProposal, ProposalStatus } from './types';
import { checkPath } from './permission-guard';
import { getProposalById, updateProposalStatus } from './persistent-store';

const execFileAsync = promisify(execFile);

const WORKTREE_ROOT = '.worktrees';
const TEST_TIMEOUT_MS = 240_000;
const TSC_TIMEOUT_MS = 240_000;
const MAX_FILE_BYTES = 512 * 1024; // 单文件 512KB 上限

export interface ApplyResult {
  ok: boolean;
  status: ProposalStatus;
  commitSha?: string;
  log: string;
}

// ---------------------------------------------------------------------------
// git 帮助函数
// ---------------------------------------------------------------------------

async function git(repoDir: string, args: string[]): Promise<string> {
  // gc.auto=0：Windows 上 auto-gc 在提交后可能因文件锁返回非零退出码，
  // 导致 commit 实际成功却被当作失败
  const { stdout } = await execFileAsync('git', ['-c', 'gc.auto=0', '-C', repoDir, ...args], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOk(repoDir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(repoDir, args) };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function revalidateChanges(proposal: CodingProposal): string[] {  const problems: string[] = [];
  if (proposal.changes.length === 0) {
    problems.push('proposal has no changes');
    return problems;
  }
  for (const change of proposal.changes) {
    // apply 阶段按最宽松的 add_feature 权限模型复检操作类型，
    // 路径本身必须在白名单内且不在拒绝名单内
    const check = checkPath(change.filePath, change.operation, 'add_feature');
    if (!check.allowed) {
      problems.push(`${change.filePath}: ${check.reason ?? 'blocked'}`);
      continue;
    }
    if (change.operation !== 'delete') {
      if (typeof change.proposedContent !== 'string' || change.proposedContent.length === 0) {
        problems.push(`${change.filePath}: missing proposedContent`);
      } else if (Buffer.byteLength(change.proposedContent, 'utf8') > MAX_FILE_BYTES) {
        problems.push(`${change.filePath}: exceeds ${MAX_FILE_BYTES} bytes`);
      }
    }
    // 禁止路径穿越
    const normalized = change.filePath.replace(/\\/g, '/');
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      problems.push(`${change.filePath}: path traversal or absolute path`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 测试门禁
// ---------------------------------------------------------------------------

async function runGate(repoRoot: string, log: string[]): Promise<boolean> {
  // 测试子进程不得继承演示模式：RF_E2E_DEMO=1 时提案内存库会以
  // .demo/coding-proposals.json 为后备，测试里的临时提案会整文件覆盖
  // 主进程演示数据，导致 apply 期间提案 404（UI 验收中真实发生）。
  const gateEnv: NodeJS.ProcessEnv = { ...process.env };
  delete gateEnv.RF_E2E_DEMO;

  // 1) 单元测试
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const testFiles = (await import('node:fs/promises'))
    .readdir(path.join(repoRoot, 'tests'))
    .then((files) => files.filter((f) => f.endsWith('.test.ts')).map((f) => path.join('tests', f)));

  try {
    await execFileAsync(process.execPath, [tsxCli, '--test', ...(await testFiles)], {
      cwd: repoRoot,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: gateEnv,
    });
    log.push('unit tests: PASS');
  } catch (e) {
    // execFile 错误信息只含命令行；真实失败原因在 stderr/stdout，必须带上
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).slice(-1500);
    log.push(`unit tests: FAIL — ${detail}`);
    return false;
  }

  // 2) 类型检查
  const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await execFileAsync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
      cwd: repoRoot,
      timeout: TSC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: gateEnv,
    });
    log.push('tsc: PASS');
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).slice(-1500);
    log.push(`tsc: FAIL — ${detail}`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export async function applyProposal(
  proposalId: string,
  actor: { userId: string; tenantId: string }
): Promise<ApplyResult> {
  const log: string[] = [];
  const repoRoot = process.cwd();

  const fail = async (reason: string, patch?: Partial<CodingProposal>): Promise<ApplyResult> => {
    log.push(`FAILED: ${reason}`);
    await updateProposalStatus(proposalId, 'apply_failed', actor.tenantId, undefined, {
      applyLog: log.join('\n'),
      ...patch,
    });
    return { ok: false, status: 'apply_failed', log: log.join('\n') };
  };

  // 1. 状态守卫
  const proposal = await getProposalById(proposalId, actor.tenantId);
  if (!proposal) return fail('proposal not found');
  if (proposal.status !== 'approved') {
    return fail(`proposal status is '${proposal.status}', expected 'approved'`);
  }

  // 2. 路径复检
  const problems = revalidateChanges(proposal);
  if (problems.length > 0) {
    return fail(`path revalidation failed: ${problems.join('; ')}`);
  }

  // 3. git 预检
  const isRepo = await gitOk(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok) return fail('not inside a git work tree');

  const branch = `agent/${proposalId}`;
  const wtDir = path.join(repoRoot, WORKTREE_ROOT, proposalId);

  // 工作区与目标文件重叠检查（防止覆盖人工未提交改动）
  const dirty = await git(repoRoot, ['status', '--porcelain']);
  if (dirty) {
    const dirtyFiles = dirty
      .split('\n')
      .map((l) => l.slice(3).trim().replace(/\\/g, '/'));
    const targets = proposal.changes.map((c) => c.filePath.replace(/\\/g, '/'));
    const overlap = targets.filter((t) => dirtyFiles.some((d) => d === t || d.endsWith(`/${t}`)));
    if (overlap.length > 0) {
      return fail(`working tree has uncommitted changes overlapping targets: ${overlap.join(', ')}`);
    }
  }

  // 4. worktree 隔离写入
  try {
    await mkdir(path.join(repoRoot, WORKTREE_ROOT), { recursive: true });
    const branchExists = (await gitOk(repoRoot, ['rev-parse', '--verify', branch])).ok;
    if (branchExists) {
      // 重试语义：上次失败可能已把提案内容提交进分支（commit 先于 merge）。
      // 若直接检出旧分支，写入相同内容会得到 "no effective changes" 卡死重试。
      // -B 将分支重置到 HEAD，保证每次 apply 都从主干干净起步。
      await git(repoRoot, ['worktree', 'add', '--force', '-B', branch, wtDir, 'HEAD']);
    } else {
      await git(repoRoot, ['worktree', 'add', '-b', branch, wtDir, 'HEAD']);
    }
    log.push(`worktree created: ${WORKTREE_ROOT}/${proposalId} on ${branch}`);

    for (const change of proposal.changes) {
      const target = path.join(wtDir, change.filePath);
      if (change.operation === 'delete') {
        await rm(target, { force: true });
        log.push(`delete ${change.filePath}`);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, change.proposedContent ?? '', 'utf8');
        log.push(`${change.operation} ${change.filePath}`);
      }
    }

    await git(wtDir, ['add', '-A']);
    const hasStaged = (await git(wtDir, ['status', '--porcelain'])).length > 0;
    if (!hasStaged) return fail('no effective changes after writing files');
    await git(wtDir, [
      'commit',
      '-m',
      `agent: ${proposal.title.slice(0, 80)} (${proposalId})`,
    ]);
    log.push('worktree commit created');
  } catch (e) {
    return fail(`worktree write failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // worktree 只承担暂存职责，合入前即可移除
    await gitOk(repoRoot, ['worktree', 'remove', '--force', wtDir]);
  }

  // 5. 合入主干（--no-ff 保留独立提交轨迹，便于 revert）
  const merge = await gitOk(repoRoot, [
    'merge',
    '--no-ff',
    branch,
    '-m',
    `merge: apply proposal ${proposalId} — ${proposal.title.slice(0, 60)}`,
  ]);
  if (!merge.ok) {
    await gitOk(repoRoot, ['merge', '--abort']);
    return fail(`merge conflict, aborted: ${merge.out.slice(0, 1000)}`);
  }
  const commitSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  log.push(`merged as ${commitSha}`);

  // 6. 测试门禁；失败自动 revert
  const passed = await runGate(repoRoot, log);
  if (!passed) {
    const revert = await gitOk(repoRoot, ['revert', '--no-edit', '-m', '1', commitSha]);
    log.push(revert.ok ? `gate failed; merge reverted` : `gate failed; AUTO-REVERT FAILED: ${revert.out}`);
    return fail('test gate failed; merge reverted', { appliedCommitSha: commitSha });
  }

  await updateProposalStatus(proposalId, 'applied', actor.tenantId, undefined, {
    appliedAt: new Date().toISOString(),
    appliedBy: actor.userId,
    appliedCommitSha: commitSha,
    applyLog: log.join('\n'),
  });
  return { ok: true, status: 'applied', commitSha, log: log.join('\n') };
}

// ---------------------------------------------------------------------------
// rollback —— git revert 已合入的提案
// ---------------------------------------------------------------------------

export async function rollbackProposal(
  proposalId: string,
  actor: { userId: string; tenantId: string }
): Promise<ApplyResult> {
  const log: string[] = [];
  const repoRoot = process.cwd();

  const fail = async (reason: string): Promise<ApplyResult> => {
    log.push(`FAILED: ${reason}`);
    await updateProposalStatus(proposalId, 'applied', actor.tenantId, undefined, {
      applyLog: log.join('\n'),
    });
    return { ok: false, status: 'applied', log: log.join('\n') };
  };

  const proposal = await getProposalById(proposalId, actor.tenantId);
  if (!proposal) return fail('proposal not found');
  if (proposal.status !== 'applied' || !proposal.appliedCommitSha) {
    return fail(`proposal status is '${proposal.status}' with no applied commit; nothing to roll back`);
  }

  const sha = proposal.appliedCommitSha;
  const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', sha])).split(' ');
  const isMerge = parents.length > 2;

  const revert = await gitOk(
    repoRoot,
    isMerge ? ['revert', '--no-edit', '-m', '1', sha] : ['revert', '--no-edit', sha]
  );
  if (!revert.ok) {
    return fail(`git revert failed (resolve conflicts manually): ${revert.out.slice(0, 1000)}`);
  }
  const rollbackSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  log.push(`reverted ${sha} as ${rollbackSha}`);

  const passed = await runGate(repoRoot, log);
  if (!passed) log.push('WARNING: test gate failed after rollback — manual intervention required');

  await updateProposalStatus(proposalId, 'rolled_back', actor.tenantId, undefined, {
    rolledBackAt: new Date().toISOString(),
    rolledBackBy: actor.userId,
    rollbackCommitSha: rollbackSha,
    applyLog: log.join('\n'),
  });
  return { ok: true, status: 'rolled_back', commitSha: rollbackSha, log: log.join('\n') };
}

/** 供路由层做存在性判断（避免把 process.cwd 假设泄漏到路由） */
export function applyEngineAvailable(): boolean {
  return existsSync(path.join(process.cwd(), '.git'));
}
