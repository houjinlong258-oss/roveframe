/**
 * Sprint 6 — AI Coding Agent
 * types.ts
 *
 * All types shared across the Coding Agent subsystem.
 *
 * SAFETY: Code changes are NEVER applied automatically.
 * Every CodingProposal requires human approval before any file is touched.
 */

// ---------------------------------------------------------------------------
// Task input
// ---------------------------------------------------------------------------

export type CodingTaskType =
  | 'add_feature'       // Add a new component / workflow / business rule
  | 'fix_bug'           // Fix a reported runtime error
  | 'add_config'        // Adjust a configuration value
  | 'add_workflow'      // Add a new agent workflow definition
  | 'add_plugin'        // Scaffold a new plugin manifest + entry
  | 'refactor'          // Refactor existing custom code (src/custom/* only)
  | 'documentation';    // Add or update docs

export interface CodingTask {
  id: string;
  type: CodingTaskType;
  /** Natural language description from the operator */
  description: string;
  /** Optional: related error fingerprint from Sprint 5 error-collector */
  relatedErrorFingerprint?: string;
  /** Optional: specific file hints (relative paths) */
  targetFiles?: string[];
  /** Operator / tenant context */
  businessId?: string;
  userId?: string;
  requestedAt: string;  // ISO-8601
}

// ---------------------------------------------------------------------------
// Context snapshot (read-only codebase excerpt fed to AI)
// ---------------------------------------------------------------------------

export interface CodeContextFile {
  relativePath: string;
  /** First 120 lines of relevant file content */
  excerpt: string;
  lineCount: number;
}

export interface CodingContext {
  taskId: string;
  relevantFiles: CodeContextFile[];
  projectSummary: string;   // Brief structural description injected into prompt
  allowedWritePaths: string[]; // Paths the agent is PERMITTED to propose changes for
}

// ---------------------------------------------------------------------------
// Proposal (output — never auto-applied)
// ---------------------------------------------------------------------------

export type ProposalStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'applied'
  | 'apply_failed'
  | 'rolled_back';

export interface CodeChange {
  /** Relative path from project root */
  filePath: string;
  /** 'create' | 'modify' | 'delete' */
  operation: 'create' | 'modify' | 'delete';
  /** Full proposed file content (for create/modify) */
  proposedContent?: string;
  /** Human-readable explanation of what changed and why */
  rationale: string;
}

export interface CodingProposal {
  id: string;
  taskId: string;
  status: ProposalStatus;
  title: string;
  summary: string;
  changes: CodeChange[];
  /** Risk assessment */
  riskLevel: 'safe' | 'moderate' | 'review_required';
  /** Always true — no auto-apply in Sprint 6 */
  requiresHumanApproval: true;
  /** Paths blocked by safety filter (empty if all clear) */
  blockedPaths: string[];
  generatedAt: string;
  /** Model / capability used */
  model?: string;

  // --- Production Hardening 新增字段（可选，向后兼容内存实现） ---
  /** 租户隔离 */
  tenantId?: string;
  /** 审批人 / 审批时间 */
  decidedBy?: string;
  decidedAt?: string;
  /** Apply Engine 落地信息 */
  appliedAt?: string;
  appliedBy?: string;
  appliedCommitSha?: string;
  /** 回滚信息 */
  rolledBackAt?: string;
  rolledBackBy?: string;
  rollbackCommitSha?: string;
  /** 最近一次 apply 的日志摘要（失败原因等） */
  applyLog?: string;
  /** Phase 8：审批人备注（request changes / reject 时填写） */
  reviewNote?: string;
}
