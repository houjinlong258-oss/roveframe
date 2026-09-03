/**
 * Phase 8 — Enterprise AI Change Approval
 * tests/phase8-approval-ui.test.ts
 *
 * 覆盖：
 *   1. diff 引擎：create/delete/modify 三种操作、hunk 折叠、unified diff 文本
 *   2. 审批前检查包：安全扫描规则、权限复检、回滚可用性
 *   3. API 权限：review/PATCH 未认证 401、staff 403（RBAC 不可被 UI 绕过）
 *   4. 状态机：pending→changes_requested（须备注）→approved；终态 409；applied 400
 *   5. 审计：approve/reject/changes_requested 均产生审计记录（含备注与前后状态）
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';

import {
  computeLineDiff,
  buildHunks,
  diffFile,
  formatUnifiedDiff,
} from '../src/lib/coding-agent/diff';
import {
  runSecurityScan,
  buildReviewChecks,
} from '../src/lib/coding-agent/review-checks';
import type { CodingProposal } from '../src/lib/coding-agent/types';
import { PATCH as codingPatch } from '../src/app/api/coding-agent/route';
import { GET as reviewGet } from '../src/app/api/coding-agent/review/route';
import { _seedRoleForTest, _clearAuthCaches } from '../src/lib/auth-guard';
import { _setAuditSinkForTest, type AuditEntry } from '../src/lib/audit';
import {
  saveProposal,
  getProposalById,
  _resetPersistenceProbe,
} from '../src/lib/coding-agent/persistent-store';
import { clearProposalStore } from '../src/lib/coding-agent/proposal-store';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TENANT = 'tenant_phase8';
const OWNER = 'user_owner_p8';
const STAFF = 'user_staff_p8';
const JWT_SECRET = 'phase8-test-secret';

function makeJwt(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email: `${userId}@test.dev`,
      app_metadata: { tenant_id: TENANT },
      exp: Math.floor(Date.now() / 1000) + 600,
    })
  ).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function req(
  url: string,
  method: string,
  userId: string | null,
  body?: unknown
): NextRequest {
  const headers: Record<string, string> = {};
  if (userId) headers.Authorization = `Bearer ${makeJwt(userId)}`;
  if (body) headers['Content-Type'] = 'application/json';
  return new Request(`http://localhost${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

let capturedAudit: AuditEntry[] = [];

function makeProposal(overrides: Partial<CodingProposal> = {}): CodingProposal {
  return {
    id: `cprop_p8_${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task_p8',
    status: 'pending_review',
    title: 'Phase 8 test proposal',
    summary: 'summary',
    changes: [
      {
        filePath: 'src/custom/widgets/hello.ts',
        operation: 'create',
        proposedContent: 'export const hello = 1;\n',
        rationale: 'test',
      },
    ],
    riskLevel: 'safe',
    requiresHumanApproval: true,
    blockedPaths: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.COZE_SUPABASE_JWT_SECRET = JWT_SECRET;
  _clearAuthCaches();
  _seedRoleForTest(OWNER, 'owner');
  _seedRoleForTest(STAFF, 'staff');
  clearProposalStore();
  _resetPersistenceProbe();
  capturedAudit = [];
  _setAuditSinkForTest((e) => capturedAudit.push(e));
});

after(() => {
  delete process.env.COZE_SUPABASE_JWT_SECRET;
  _setAuditSinkForTest(null);
  _clearAuthCaches();
});

// ---------------------------------------------------------------------------
// 1. diff 引擎
// ---------------------------------------------------------------------------

describe('diff engine', () => {
  test('create: 全部行为新增，hunk 头为 -0,0', () => {
    const d = diffFile('src/custom/a.ts', 'create', null, 'line1\nline2\nline3');
    assert.equal(d.isNew, true);
    assert.equal(d.additions, 3);
    assert.equal(d.deletions, 0);
    assert.equal(d.hunks.length, 1);
    assert.equal(d.hunks[0].oldStart, 0);
    assert.equal(d.hunks[0].oldLines, 0);
    assert.equal(d.hunks[0].newStart, 1);
    assert.ok(d.hunks[0].lines.every((l) => l.type === 'add'));
  });

  test('delete: 全部行为删除，新起点为 +0,0', () => {
    const d = diffFile('docs/x.md', 'delete', 'a\nb', undefined);
    assert.equal(d.isDeleted, true);
    assert.equal(d.deletions, 2);
    assert.equal(d.additions, 0);
    assert.equal(d.hunks[0].newStart, 0);
    assert.equal(d.hunks[0].newLines, 0);
  });

  test('modify: 修改行产生 del+add 对，行号正确', () => {
    const d = diffFile('f.ts', 'modify', 'a\nb\nc', 'a\nB\nc');
    const flat = d.hunks.flatMap((h) => h.lines);
    const del = flat.find((l) => l.type === 'del');
    const add = flat.find((l) => l.type === 'add');
    assert.equal(del?.content, 'b');
    assert.equal(del?.oldLine, 2);
    assert.equal(add?.content, 'B');
    assert.equal(add?.newLine, 2);
    // 上下文行带双侧行号
    const ctx = flat.filter((l) => l.type === 'context');
    assert.ok(ctx.every((l) => l.oldLine !== undefined && l.newLine !== undefined));
  });

  test('hunks 折叠：相距远的变更拆成多个 hunk，近的合并', () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = 'CHANGED_A';
    newLines[30] = 'CHANGED_B';
    const d = diffFile('f.ts', 'modify', oldLines.join('\n'), newLines.join('\n'));
    assert.equal(d.hunks.length, 2);

    // 相邻变更（间隔 ≤ 2×context）合并为一个 hunk
    const newLines2 = [...oldLines];
    newLines2[1] = 'CHANGED_A';
    newLines2[4] = 'CHANGED_B';
    const d2 = diffFile('f.ts', 'modify', oldLines.join('\n'), newLines2.join('\n'));
    assert.equal(d2.hunks.length, 1);
  });

  test('formatUnifiedDiff: 标准头与 @@ 标记', () => {
    const d = diffFile('src/custom/a.ts', 'modify', 'x\ny', 'x\nz');
    const text = formatUnifiedDiff(d);
    assert.match(text, /--- a\/src\/custom\/a\.ts/);
    assert.match(text, /\+\+\+ b\/src\/custom\/a\.ts/);
    assert.match(text, /@@ -\d+,\d+ \+\d+,\d+ @@/);
    assert.ok(text.includes('-y'));
    assert.ok(text.includes('+z'));
  });

  test('create 的 unified diff 使用 /dev/null 旧侧', () => {
    const d = diffFile('src/custom/new.ts', 'create', null, 'hello');
    const text = formatUnifiedDiff(d);
    assert.match(text, /--- \/dev\/null/);
  });

  test('computeLineDiff: 空旧文本等价全新增', () => {
    const lines = computeLineDiff('', 'a\nb');
    assert.equal(lines.filter((l) => l.type === 'add').length, 2);
    assert.equal(lines.filter((l) => l.type === 'context').length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. 审批前检查包
// ---------------------------------------------------------------------------

describe('review checks', () => {
  test('安全扫描：命中私钥/AWS key/eval/child_process', () => {
    const p = makeProposal({
      changes: [
        {
          filePath: 'src/custom/evil.ts',
          operation: 'create',
          proposedContent: [
            'const k = "-----BEGIN PRIVATE KEY-----"',
            'const aws = "AKIAIOSFODNN7EXAMPLE"',
            'eval("alert(1)")',
            'import { execSync } from "child_process"',
          ].join('\n'),
          rationale: 'x',
        },
      ],
    });
    const findings = runSecurityScan(p);
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes('private-key-material'));
    assert.ok(rules.includes('aws-access-key'));
    assert.ok(rules.includes('dynamic-code-eval'));
    assert.ok(rules.includes('shell-exec'));
    // high 级别优先排序
    assert.equal(findings[0].severity, 'high');
  });

  test('干净提案：security.ok = true 且无发现', () => {
    const checks = buildReviewChecks(makeProposal());
    assert.equal(checks.security.ok, true);
    assert.equal(checks.security.findings.length, 0);
  });

  test('权限复检：拒绝路径被标出', () => {
    const p = makeProposal({
      changes: [
        { filePath: 'src/lib/auth.ts', operation: 'modify', proposedContent: 'x', rationale: 'x' },
      ],
    });
    const checks = buildReviewChecks(p);
    assert.equal(checks.permission.ok, false);
    assert.ok(checks.permission.problems.length > 0);
  });

  test('回滚可用性：applied + commitSha 才可回滚', () => {
    const applied = buildReviewChecks(
      makeProposal({ status: 'applied', appliedCommitSha: 'abc123' })
    );
    assert.equal(applied.rollback.available, true);

    const pending = buildReviewChecks(makeProposal());
    assert.equal(pending.rollback.available, false);
    assert.match(pending.rollback.reason, /pending_review/);
  });

  test('testGate：applied 且日志全 PASS → pass；apply_failed → fail', () => {
    const pass = buildReviewChecks(
      makeProposal({ status: 'applied', appliedCommitSha: 'x', applyLog: 'unit tests: PASS\ntsc: PASS' })
    );
    assert.equal(pass.testGate.lastResult, 'pass');

    const fail = buildReviewChecks(
      makeProposal({ status: 'apply_failed', applyLog: 'unit tests: FAIL — boom' })
    );
    assert.equal(fail.testGate.lastResult, 'fail');

    const unknown = buildReviewChecks(makeProposal());
    assert.equal(unknown.testGate.lastResult, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 3. API 权限（RBAC 不可被 UI 绕过）
// ---------------------------------------------------------------------------

describe('permission validation', () => {
  test('review GET 未认证 → 401', async () => {
    const res = await reviewGet(req('/api/coding-agent/review?id=x', 'GET', null));
    assert.equal(res.status, 401);
  });

  test('review GET 认证后可读（含 diff 与 checks）', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await reviewGet(req(`/api/coding-agent/review?id=${p.id}`, 'GET', OWNER));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      proposal: { id: string };
      files: Array<{ additions: number }>;
      checks: { permission: { ok: boolean } };
      activity: unknown[];
    };
    assert.equal(body.proposal.id, p.id);
    assert.equal(body.files.length, 1);
    // proposedContent 以 \n 结尾，split 后含末尾空行 → 2 个新增行
    assert.equal(body.files[0].additions, 2);
    assert.equal(body.checks.permission.ok, true);
    assert.ok(Array.isArray(body.activity));
  });

  test('PATCH staff 角色 → 403（UI 无法绕过 RBAC）', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', STAFF, { id: p.id, status: 'approved' })
    );
    assert.equal(res.status, 403);
  });

  test('apply/rollback 之外：review 端点本身不接受写操作语义', async () => {
    // review 只有 GET；POST 未被导出，HTTP 层会 405——这里验证 GET 不改变状态
    const p = makeProposal();
    await saveProposal(p, TENANT);
    await reviewGet(req(`/api/coding-agent/review?id=${p.id}`, 'GET', OWNER));
    const after = await getProposalById(p.id, TENANT);
    assert.equal(after?.status, 'pending_review');
  });
});

// ---------------------------------------------------------------------------
// 4. 状态机流转 + 5. 审计
// ---------------------------------------------------------------------------

describe('approval state transitions & audit', () => {
  test('changes_requested 必须带备注', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'changes_requested' })
    );
    assert.equal(res.status, 400);
  });

  test('pending → changes_requested：状态、备注、审计齐备', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, {
        id: p.id,
        status: 'changes_requested',
        note: 'Please split this into two files',
      })
    );
    assert.equal(res.status, 200);
    const updated = await getProposalById(p.id, TENANT);
    assert.equal(updated?.status, 'changes_requested');
    assert.equal(updated?.reviewNote, 'Please split this into two files');
    assert.equal(updated?.decidedBy, OWNER);

    const audit = capturedAudit.find((a) => a.action === 'coding_proposal.changes_requested');
    assert.ok(audit, 'audit record for changes_requested must exist');
    assert.equal(audit.tenantId, TENANT);
    assert.equal(audit.actorId, OWNER);
    assert.deepEqual(audit.before, { status: 'pending_review' });
    assert.equal((audit.after as { note?: string }).note, 'Please split this into two files');
  });

  test('changes_requested → approved 合法；approved 是临时终态（→rejected 409）', async () => {
    const p = makeProposal({ status: 'changes_requested' });
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'approved' })
    );
    assert.equal(res.status, 200);

    // approved 不在 ALLOWED_TRANSITIONS 的源里
    const res2 = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'rejected' })
    );
    assert.equal(res2.status, 409);
  });

  test('approve 产生审计（before/after 状态）', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'approved' })
    );
    assert.equal(res.status, 200);
    const audit = capturedAudit.find((a) => a.action === 'coding_proposal.approved');
    assert.ok(audit);
    assert.deepEqual(audit.before, { status: 'pending_review' });
    assert.equal((audit.after as { status?: string }).status, 'approved');
  });

  test('reject 产生审计', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'rejected', note: 'not needed' })
    );
    assert.equal(res.status, 200);
    assert.ok(capturedAudit.some((a) => a.action === 'coding_proposal.rejected'));
  });

  test('applied 不能通过 PATCH 设置 → 400', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    const res = await codingPatch(
      req('/api/coding-agent', 'PATCH', OWNER, { id: p.id, status: 'applied' })
    );
    assert.equal(res.status, 400);
  });

  test('跨租户隔离：其他租户访问提案 → 404（内存回退模式也强制）', async () => {
    const p = makeProposal();
    await saveProposal(p, TENANT);
    // 用另一个 tenant 的 JWT（seed role 后本地验签通过，但 tenant 不同）
    const OTHER = 'user_other_p8';
    _seedRoleForTest(OTHER, 'owner');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: OTHER,
        app_metadata: { tenant_id: 'tenant_other' },
        exp: Math.floor(Date.now() / 1000) + 600,
      })
    ).toString('base64url');
    const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    const res = await reviewGet(
      new Request(`http://localhost/api/coding-agent/review?id=${p.id}`, {
        headers: { Authorization: `Bearer ${header}.${payload}.${sig}` },
      }) as unknown as NextRequest
    );
    assert.equal(res.status, 404);

    // PATCH 同样不可越租户
    const res2 = await codingPatch(
      new Request('http://localhost/api/coding-agent', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${header}.${payload}.${sig}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: p.id, status: 'approved' }),
      }) as unknown as NextRequest
    );
    assert.equal(res2.status, 404);
  });
});
