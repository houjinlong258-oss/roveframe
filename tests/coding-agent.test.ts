/**
 * Sprint 6 — AI Coding Agent
 * tests/coding-agent.test.ts
 *
 * Tests for: permission-guard, context-builder, proposal-store.
 * code-generator is NOT tested here (requires live AI — tested via integration).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPath,
  getAllowedWritePaths,
  validateTask,
} from '../src/lib/coding-agent/permission-guard';

import {
  buildCodingContext,
} from '../src/lib/coding-agent/context-builder';

import {
  saveProposal,
  listProposals,
  getProposalById,
  updateProposalStatus,
  clearProposalStore,
  proposalStoreSize,
} from '../src/lib/coding-agent/proposal-store';

import { CodingTask, CodingProposal } from '../src/lib/coding-agent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: 'task_test_001',
    type: 'add_feature',
    description: 'Add a birthday discount banner to the customer page',
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<CodingProposal> = {}): CodingProposal {
  return {
    id: `cprop_${Math.random().toString(36).slice(2)}`,
    taskId: 'task_test_001',
    status: 'pending_review',
    title: 'Add Birthday Discount Banner',
    summary: 'Creates a new banner component in src/custom/',
    changes: [
      {
        filePath: 'src/custom/components/BirthdayBanner.tsx',
        operation: 'create',
        proposedContent: 'export function BirthdayBanner() { return <div>🎂</div>; }',
        rationale: 'New feature component',
      },
    ],
    riskLevel: 'safe',
    requiresHumanApproval: true,
    blockedPaths: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Permission Guard
// ---------------------------------------------------------------------------

describe('Coding Agent — Permission Guard', () => {
  test('allows create in src/custom/', () => {
    const result = checkPath('src/custom/components/MyFeature.tsx', 'create', 'add_feature');
    assert.equal(result.allowed, true);
  });

  test('allows modify in docs/', () => {
    const result = checkPath('docs/my-doc.md', 'modify', 'documentation');
    assert.equal(result.allowed, true);
  });

  test('blocks write to src/core/', () => {
    const result = checkPath('src/core/engine.ts', 'modify', 'refactor');
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('denied'));
  });

  test('blocks write to src/app/api/auth/', () => {
    const result = checkPath('src/app/api/auth/me/route.ts', 'modify', 'fix_bug');
    assert.equal(result.allowed, false);
  });

  test('blocks write to .env', () => {
    const result = checkPath('.env', 'modify', 'add_config');
    assert.equal(result.allowed, false);
  });

  test('blocks write to package.json', () => {
    const result = checkPath('package.json', 'modify', 'add_feature');
    assert.equal(result.allowed, false);
  });

  test('blocks write to src/lib/crypto.ts', () => {
    const result = checkPath('src/lib/crypto.ts', 'modify', 'fix_bug');
    assert.equal(result.allowed, false);
  });

  test('blocks file outside allowed prefixes (e.g. src/app/api/orders/)', () => {
    const result = checkPath('src/app/api/orders/route.ts', 'modify', 'add_feature');
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('outside allowed'));
  });

  test('blocks delete operation for fix_bug task type', () => {
    const result = checkPath('src/custom/old-component.tsx', 'delete', 'fix_bug');
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('delete'));
  });

  test('getAllowedWritePaths returns non-empty list including src/custom/', () => {
    const paths = getAllowedWritePaths();
    assert.ok(paths.length > 0);
    assert.ok(paths.some((p) => p.includes('src/custom')));
  });

  test('validateTask rejects too-short description', () => {
    const task = makeTask({ description: 'Add' });
    const result = validateTask(task);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('10 characters')));
  });

  test('validateTask rejects task with blocked target file', () => {
    const task = makeTask({ targetFiles: ['src/core/secret.ts'] });
    const result = validateTask(task);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('blocked')));
  });

  test('validateTask accepts valid task', () => {
    const task = makeTask({ targetFiles: ['src/custom/my-feature.ts'] });
    const result = validateTask(task);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

describe('Coding Agent — Context Builder', () => {
  test('builds a context with taskId matching task', () => {
    const task = makeTask();
    const context = buildCodingContext(task);
    assert.equal(context.taskId, task.id);
  });

  test('context includes projectSummary', () => {
    const task = makeTask();
    const context = buildCodingContext(task);
    assert.ok(context.projectSummary.length > 0);
    assert.ok(context.projectSummary.includes('RoveFrame'));
  });

  test('context includes allowedWritePaths', () => {
    const task = makeTask();
    const context = buildCodingContext(task);
    assert.ok(context.allowedWritePaths.length > 0);
  });

  test('context relevantFiles is an array (may be empty in test env)', () => {
    const task = makeTask();
    const context = buildCodingContext(task);
    assert.ok(Array.isArray(context.relevantFiles));
  });
});

// ---------------------------------------------------------------------------
// Proposal Store
// ---------------------------------------------------------------------------

describe('Coding Agent — Proposal Store', () => {
  beforeEach(() => clearProposalStore());

  test('saves and retrieves a proposal by id', () => {
    const proposal = makeProposal();
    saveProposal(proposal);
    const found = getProposalById(proposal.id);
    assert.ok(found !== undefined);
    assert.equal(found?.id, proposal.id);
  });

  test('listProposals returns newest first', () => {
    const p1 = makeProposal({ id: 'cprop_aaa', title: 'First' });
    const p2 = makeProposal({ id: 'cprop_bbb', title: 'Second' });
    saveProposal(p1);
    saveProposal(p2);
    const list = listProposals(10);
    assert.equal(list[0].title, 'Second');
    assert.equal(list[1].title, 'First');
  });

  test('updateProposalStatus changes status', () => {
    const proposal = makeProposal();
    saveProposal(proposal);
    const updated = updateProposalStatus(proposal.id, 'approved');
    assert.equal(updated?.status, 'approved');
    assert.equal(getProposalById(proposal.id)?.status, 'approved');
  });

  test('updateProposalStatus returns undefined for missing id', () => {
    const result = updateProposalStatus('nonexistent_id', 'rejected');
    assert.equal(result, undefined);
  });

  test('proposalStoreSize returns correct count', () => {
    saveProposal(makeProposal());
    saveProposal(makeProposal());
    assert.equal(proposalStoreSize(), 2);
  });

  test('requiresHumanApproval is always true on stored proposals', () => {
    const proposal = makeProposal();
    saveProposal(proposal);
    const found = getProposalById(proposal.id);
    assert.equal(found?.requiresHumanApproval, true);
  });
});
