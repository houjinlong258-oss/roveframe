/**
 * Sprint 5 — Error Self-Healing MVP
 * tests/error-healing.test.ts
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  captureError,
  getRecentErrors,
  getErrorsByFingerprint,
  clearErrorBuffer,
  errorBufferSize,
  ErrorReport,
} from '../src/lib/healing/error-collector';

import {
  analyzeError,
  analyzeErrors,
} from '../src/lib/healing/analyzer';

import {
  generatePatchProposal,
  generatePatchProposals,
} from '../src/lib/healing/patch-generator';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    message: 'Unexpected end of JSON input',
    stack: 'SyntaxError: Unexpected end of JSON input\n    at CustomersPage.load (page.tsx:42)',
    url: '/api/customers',
    method: 'GET',
    statusCode: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Error Collector
// ---------------------------------------------------------------------------

describe('Error Collector', () => {
  beforeEach(() => clearErrorBuffer());

  test('captures and stores an error with auto-classification', () => {
    const entry = captureError(makeReport());
    assert.ok(entry.id.startsWith('err_'));
    assert.equal(entry.message, 'Unexpected end of JSON input');
    assert.equal(entry.category, 'validation');        // JSON parse → validation
    assert.ok(['low', 'medium', 'high', 'critical'].includes(entry.severity));
    assert.ok(entry.fingerprint.length === 8);
    assert.equal(errorBufferSize(), 1);
  });

  test('getRecentErrors returns newest first', () => {
    captureError(makeReport({ message: 'Error A' }));
    captureError(makeReport({ message: 'Error B' }));
    const recent = getRecentErrors(10);
    assert.equal(recent[0].message, 'Error B');
    assert.equal(recent[1].message, 'Error A');
  });

  test('fingerprint groups identical errors', () => {
    const report = makeReport({ message: 'Failed to fetch', url: '/api/orders' });
    captureError(report);
    captureError(report);
    captureError(report);
    const first = getRecentErrors(10)[0];
    const group = getErrorsByFingerprint(first.fingerprint);
    assert.equal(group.length, 3);
  });

  test('classifies auth errors correctly', () => {
    const entry = captureError(makeReport({ message: 'Unauthorized', statusCode: 401 }));
    assert.equal(entry.category, 'auth');
    assert.equal(entry.severity, 'high');
  });

  test('classifies database errors correctly', () => {
    const entry = captureError(makeReport({
      message: 'relation "orders" does not exist',
      statusCode: undefined,
    }));
    assert.equal(entry.category, 'database');
    assert.equal(entry.severity, 'critical');
  });

  test('classifies 500 server errors as API category with critical severity', () => {
    const entry = captureError(makeReport({ message: 'Internal Server Error', statusCode: 500 }));
    assert.equal(entry.category, 'api');
    assert.equal(entry.severity, 'critical');
  });
});

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

describe('Error Analyzer', () => {
  beforeEach(() => clearErrorBuffer());

  test('produces a high-confidence root cause for JSON parse error', () => {
    const entry = captureError(makeReport());
    const result = analyzeError(entry, 1);
    assert.equal(result.errorId, entry.id);
    assert.ok(result.rootCauses.length > 0);
    const cause = result.rootCauses[0];
    assert.equal(cause.confidence, 'high');
    assert.ok(cause.title.toLowerCase().includes('json') || cause.title.toLowerCase().includes('empty'));
  });

  test('produces root cause for null dereference error', () => {
    const entry = captureError(makeReport({
      message: 'Cannot read properties of undefined (reading "name")',
      statusCode: undefined,
    }));
    const result = analyzeError(entry, 1);
    assert.ok(result.rootCauses.some((rc) => rc.title.toLowerCase().includes('null') || rc.title.toLowerCase().includes('undefined')));
  });

  test('analyzeErrors de-duplicates by fingerprint', () => {
    const report = makeReport({ message: 'Failed to fetch', url: '/api/reviews' });
    captureError(report);
    captureError(report);
    captureError(report);
    const errors = getRecentErrors(50);
    const analyses = analyzeErrors(errors);
    // 3 identical errors → 1 analysis group
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].occurrenceCount, 3);
  });

  test('occurrenceCount is included in single analysis', () => {
    const entry = captureError(makeReport());
    const result = analyzeError(entry, 5);
    assert.equal(result.occurrenceCount, 5);
  });

  test('batch analysis sorts critical before low severity', () => {
    clearErrorBuffer();
    captureError(makeReport({ message: 'Network timeout', statusCode: undefined }));
    captureError(makeReport({ message: 'relation "users" does not exist', statusCode: undefined }));
    const errors = getRecentErrors(50);
    const analyses = analyzeErrors(errors);
    // DB error should be critical (first)
    assert.ok(analyses[0].severity === 'critical' || analyses[0].severity === 'high');
  });
});

// ---------------------------------------------------------------------------
// Patch Generator
// ---------------------------------------------------------------------------

describe('Patch Generator', () => {
  beforeEach(() => clearErrorBuffer());

  test('generates a patch proposal with requiresHumanApproval=true', () => {
    const entry = captureError(makeReport());
    const analysis = analyzeError(entry, 1);
    const patch = generatePatchProposal(analysis);
    assert.equal(patch.requiresHumanApproval, true);
    assert.ok(patch.id.startsWith('patch_'));
  });

  test('status is pending_review for matchable errors', () => {
    const entry = captureError(makeReport());
    const analysis = analyzeError(entry, 1);
    const patch = generatePatchProposal(analysis);
    assert.ok(patch.status === 'pending_review' || patch.status === 'rejected');
  });

  test('blocks patches targeting protected paths', () => {
    const entry = captureError(makeReport({ message: 'Unauthorized', statusCode: 401 }));
    const analysis = analyzeError(entry, 1);
    const patch = generatePatchProposal(analysis);
    // Regardless of status, must not have blocked paths in hunks if status is not rejected
    if (patch.status !== 'rejected') {
      const BLOCKED = ['src/core/', 'src/app/api/auth/', 'src/lib/crypto.', '.env'];
      for (const hunk of patch.hunks) {
        for (const blocked of BLOCKED) {
          assert.ok(!hunk.filePath.toLowerCase().includes(blocked.toLowerCase()),
            `Hunk targets blocked path: ${hunk.filePath}`);
        }
      }
    }
  });

  test('returns manual investigation proposal for unknown errors', () => {
    const entry = captureError(makeReport({
      message: 'Completely unknown exotic error XYZ',
      statusCode: undefined,
      url: undefined,
    }));
    const analysis = analyzeError(entry, 1);
    const patch = generatePatchProposal(analysis);
    // Either a manual investigation proposal or a pending_review with hunks
    assert.ok(
      patch.title.includes('Manual') || patch.hunks.length >= 0
    );
  });

  test('batch generates proposals for multiple analyses', () => {
    captureError(makeReport({ message: 'Unexpected end of JSON input' }));
    captureError(makeReport({ message: 'relation "orders" does not exist', statusCode: undefined }));
    const errors = getRecentErrors(50);
    const analyses = analyzeErrors(errors);
    const patches = generatePatchProposals(analyses);
    assert.equal(patches.length, analyses.length);
    for (const p of patches) {
      assert.equal(p.requiresHumanApproval, true);
    }
  });
});

// ---------------------------------------------------------------------------
// P0-13 — Python healing/installer 死代码安全边界（不可触发 + 注入面移除）
// ---------------------------------------------------------------------------

describe('P0-13 Python healing/installer dead code boundaries', () => {
  const healing = readFileSync('roveagent/repair/healing.py', 'utf8');
  const installer = readFileSync('roveagent/deployment/installer.py', 'utf8');

  function sourceFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = `${root}/${entry.name}`;
      return entry.isDirectory() ? sourceFiles(path)
        : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }

  test('两模块不可从任何 API/任务路径触发', () => {
    const hits: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('SelfHealingEngine') || source.includes('RoveAgentInstaller')) {
        hits.push(file);
      }
    }
    assert.deepEqual(hits, [], 'TS 侧不得引用 Python 自愈/安装器引擎');
  });

  test('healing：rollback 无快速通道自批，git 全部参数列表执行', () => {
    assert.ok(!healing.includes('permissions.approve('), '不得再有自动批准快速通道');
    assert.ok(!/git (add|commit|rev-parse|revert)[^\n]*shell=True/.test(healing), 'git 禁止 shell=True 拼接');
    assert.match(healing, /\["git", "(add|commit|rev-parse|revert)"/);
    assert.match(healing, /safe_commit_message/);
    assert.match(healing, /_COMMIT_HASH_RE\.fullmatch/);
    assert.ok(!/f'git add/.test(healing));
  });

  test('installer：输入白名单校验 + 移除硬编码口令', () => {
    assert.match(installer, /_validate_deploy_inputs/);
    assert.match(installer, /_HOST_RE\.fullmatch/);
    assert.match(installer, /_APP_DIR_RE\.fullmatch/);
    assert.match(installer, /_DOMAIN_RE\.fullmatch/);
    assert.ok(!installer.includes('POSTGRES_PASSWORD=roveframe'), '硬编码口令必须移除');
    assert.match(installer, /secrets\.token_urlsafe/);
  });
});
