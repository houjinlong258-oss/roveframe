/**
 * Phase 8 — Enterprise AI Change Approval
 * review-checks.ts
 *
 * 审批前检查包：在审批人点下 Approve 之前，把四类关键信号聚合展示——
 *
 *   1. permission：复用 Apply Engine 的 revalidateChanges 路径复检
 *      （不信任提案自报，与 apply 时执行的检查完全同源）
 *   2. security：对 proposedContent 做静态安全扫描（私钥/硬编码凭据/
 *      动态代码执行/shell 调用/破坏性文件操作）
 *   3. testGate：声明 apply 时会执行的门禁步骤，并解析最近一次 apply
 *      日志给出上次结果
 *   4. rollback：回滚可用性（仅 applied 且有 appliedCommitSha 时可回滚）
 *
 * 全部为纯函数 + 只读派生，不写任何状态。
 */

import { CodingProposal } from './types';
import { revalidateChanges } from './apply-engine';

// ---------------------------------------------------------------------------
// 安全扫描
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  filePath: string;
  /** 1-based 行号 */
  line: number;
  rule: string;
  severity: 'high' | 'medium';
  /** 命中行摘要（截断，避免把秘密本身回显到 UI） */
  excerpt: string;
}

interface SecurityRule {
  rule: string;
  severity: 'high' | 'medium';
  re: RegExp;
}

const SECURITY_RULES: SecurityRule[] = [
  { rule: 'private-key-material', severity: 'high', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { rule: 'aws-access-key', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    rule: 'hardcoded-credential',
    severity: 'medium',
    re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  { rule: 'dynamic-code-eval', severity: 'medium', re: /\beval\s*\(|new Function\s*\(/ },
  { rule: 'shell-exec', severity: 'high', re: /child_process|execSync\s*\(/ },
  {
    rule: 'destructive-fs',
    severity: 'medium',
    re: /rmSync\s*\(|rm\s*\([^)]*recursive|unlinkSync\s*\(/,
  },
];

/** 扫描提案全部 proposedContent，返回安全发现列表（按严重度排序） */
export function runSecurityScan(proposal: CodingProposal): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const change of proposal.changes) {
    if (!change.proposedContent) continue;
    const lines = change.proposedContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      for (const { rule, severity, re } of SECURITY_RULES) {
        if (re.test(text)) {
          findings.push({
            filePath: change.filePath,
            line: i + 1,
            rule,
            severity,
            // 摘要不回显完整行：命中秘密类规则时隐藏等号后内容
            excerpt: rule.includes('credential') || rule.includes('key')
              ? text.slice(0, 60).replace(/([:=]\s*['"])[^'"]+/, '$1***')
              : text.trim().slice(0, 80),
          });
        }
      }
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 检查包
// ---------------------------------------------------------------------------

export interface ReviewChecks {
  permission: { ok: boolean; problems: string[] };
  security: { ok: boolean; findings: SecurityFinding[] };
  testGate: {
    /** apply 时会执行的门禁步骤（声明式展示） */
    steps: string[];
    /** 最近一次 apply 的门禁结果（从 applyLog 解析） */
    lastResult: 'pass' | 'fail' | 'unknown';
    detail?: string;
  };
  rollback: { available: boolean; reason: string };
}

export const TEST_GATE_STEPS = ['unit tests (tsx --test tests/)', 'tsc -p tsconfig.json'] as const;

/** 聚合四类检查。pure derivation，无副作用。 */
export function buildReviewChecks(proposal: CodingProposal): ReviewChecks {
  // 1. 权限复检（与 apply 引擎同源）
  const problems = revalidateChanges(proposal);

  // 2. 安全扫描（high 级别发现视为不通过）
  const findings = runSecurityScan(proposal);
  const hasHigh = findings.some((f) => f.severity === 'high');

  // 3. 测试门禁：解析最近 apply 日志
  let lastResult: ReviewChecks['testGate']['lastResult'] = 'unknown';
  let detail: string | undefined;
  if (proposal.status === 'applied' && proposal.applyLog) {
    const pass = /unit tests: PASS/.test(proposal.applyLog) && /tsc: PASS/.test(proposal.applyLog);
    lastResult = pass ? 'pass' : 'unknown';
  } else if (proposal.status === 'apply_failed' && proposal.applyLog) {
    lastResult = 'fail';
    const lines = proposal.applyLog.split('\n').filter((l) => l.trim().length > 0);
    detail = lines[lines.length - 1]?.slice(0, 300);
  }

  // 4. 回滚可用性
  const rollbackAvailable = proposal.status === 'applied' && !!proposal.appliedCommitSha;
  const rollbackReason = rollbackAvailable
    ? `revert ${proposal.appliedCommitSha}`
    : proposal.status === 'applied'
      ? 'applied but missing commit sha'
      : `status is '${proposal.status}'`;

  return {
    permission: { ok: problems.length === 0, problems },
    security: { ok: !hasHigh, findings },
    testGate: { steps: [...TEST_GATE_STEPS], lastResult, detail },
    rollback: { available: rollbackAvailable, reason: rollbackReason },
  };
}
