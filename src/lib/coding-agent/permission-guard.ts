/**
 * Sprint 6 — AI Coding Agent
 * permission-guard.ts
 *
 * Enforces which file paths the Coding Agent is allowed to propose changes for.
 * Integrates with the Sprint 3 Agent Permission System philosophy:
 * Coding Agent → READ anywhere in src/, WRITE only src/custom/* and docs/
 *
 * SAFETY: This guard is checked BEFORE any proposal is returned.
 *         Blocked proposals are returned with status='rejected' and no content.
 */

import { CodingTask, CodingTaskType } from './types';

// ---------------------------------------------------------------------------
// Write-allow list (relative path prefixes the agent may propose changes for)
// ---------------------------------------------------------------------------

const ALLOWED_WRITE_PREFIXES: string[] = [
  'src/custom/',
  'docs/',
  'messages/',       // i18n strings only — no logic
  'public/',         // Static assets
];

// ---------------------------------------------------------------------------
// Absolute deny list — no proposal may ever target these paths
// ---------------------------------------------------------------------------

const DENIED_PATH_PATTERNS: string[] = [
  'src/core/',
  'src/app/api/auth/',
  'src/lib/auth.',
  'src/lib/crypto.',
  'src/lib/migration.',
  'src/lib/tenant.',
  'src/lib/rbac.',
  'src/server.',
  'src/proxy.',
  'next.config.',
  'eslint.config.',
  '.env',
  'pnpm-lock',
  'package.json',
  'tsconfig',
  '.gitignore',
  'AGENTS.md',
];

// ---------------------------------------------------------------------------
// Task-type to permitted operations mapping
// ---------------------------------------------------------------------------

const TASK_TYPE_PERMISSIONS: Record<CodingTaskType, { allowCreate: boolean; allowModify: boolean; allowDelete: boolean }> = {
  add_feature:   { allowCreate: true,  allowModify: true,  allowDelete: false },
  fix_bug:       { allowCreate: false, allowModify: true,  allowDelete: false },
  add_config:    { allowCreate: false, allowModify: true,  allowDelete: false },
  add_workflow:  { allowCreate: true,  allowModify: true,  allowDelete: false },
  add_plugin:    { allowCreate: true,  allowModify: false, allowDelete: false },
  refactor:      { allowCreate: false, allowModify: true,  allowDelete: false },
  documentation: { allowCreate: true,  allowModify: true,  allowDelete: false },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Check whether a proposed file path is allowed for the given task type and operation. */
export function checkPath(
  filePath: string,
  operation: 'create' | 'modify' | 'delete',
  taskType: CodingTaskType
): PathCheckResult {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  // 1. Hard deny list
  for (const pattern of DENIED_PATH_PATTERNS) {
    if (normalized.startsWith(pattern.toLowerCase()) || normalized.includes(pattern.toLowerCase())) {
      return {
        allowed: false,
        reason: `Path matches denied pattern: ${pattern}`,
      };
    }
  }

  // 2. Must be in allow list
  const inAllowList = ALLOWED_WRITE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix.toLowerCase())
  );
  if (!inAllowList) {
    return {
      allowed: false,
      reason: `Path is outside allowed write prefixes: ${ALLOWED_WRITE_PREFIXES.join(', ')}`,
    };
  }

  // 3. Operation permission
  const ops = TASK_TYPE_PERMISSIONS[taskType];
  if (operation === 'create' && !ops.allowCreate) {
    return { allowed: false, reason: `Task type '${taskType}' does not allow 'create' operations` };
  }
  if (operation === 'modify' && !ops.allowModify) {
    return { allowed: false, reason: `Task type '${taskType}' does not allow 'modify' operations` };
  }
  if (operation === 'delete' && !ops.allowDelete) {
    return { allowed: false, reason: `Task type '${taskType}' does not allow 'delete' operations` };
  }

  return { allowed: true };
}

/** Return the list of allowed write path prefixes for context injection into AI prompt. */
export function getAllowedWritePaths(): string[] {
  return [...ALLOWED_WRITE_PREFIXES];
}

/** Validate an entire task before dispatching to code-generator. */
export function validateTask(task: CodingTask): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!task.description || task.description.trim().length < 10) {
    errors.push('Task description must be at least 10 characters.');
  }
  if (task.description && task.description.length > 2000) {
    errors.push('Task description must not exceed 2000 characters.');
  }

  // Validate any explicitly requested target files
  for (const filePath of task.targetFiles ?? []) {
    const check = checkPath(filePath, 'modify', task.type);
    if (!check.allowed) {
      errors.push(`Target file '${filePath}' blocked: ${check.reason}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
