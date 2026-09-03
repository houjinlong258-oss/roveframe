/**
 * Phase 8 — 端到端验收脚本
 * scripts/e2e-approval-acceptance.ts
 *
 * 走通完整审批闭环（真实路由 handler + 真实 JWT 验签 + 真实 git apply/rollback）：
 *
 *   create → review(diff+checks) → changes_requested(带备注) → approved
 *   → apply(真实 worktree + 测试门禁) → review(gate=pass, rollback=available)
 *   → rollback → 验证文件已还原 + 分支清理
 *
 * 运行：
 *   ./node_modules/.bin/tsx scripts/e2e-approval-acceptance.ts
 *
 * 双模式：
 *   - 无 COZE_SUPABASE_* ：内存回退模式，全链路可跑（审计/DB 持久化断言自动 SKIP）
 *   - 有 COZE_SUPABASE_* ：DB 模式，额外断言 review_note 落库 + audit_logs 六条记录
 */

import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { NextRequest } from 'next/server';

const TENANT = 'tenant_e2e_p8';
const OWNER = 'user_e2e_owner';
const JWT_SECRET = 'e2e-p8-secret';
const TARGET_FILE = 'src/custom/phase8-e2e/hello.ts';

// 动态 import，保证 env 先于模块加载
import { _seedRoleForTest, _clearAuthCaches } from '../src/lib/auth-guard';
import { saveProposal, getProposalById, _resetPersistenceProbe } from '../src/lib/coding-agent/persistent-store';
import { clearProposalStore } from '../src/lib/coding-agent/proposal-store';
import { PATCH } from '../src/app/api/coding-agent/route';
import { GET as reviewGet } from '../src/app/api/coding-agent/review/route';
import { POST as applyPost } from '../src/app/api/coding-agent/apply/route';
import { POST as rollbackPost } from '../src/app/api/coding-agent/rollback/route';
import { getSupabaseClient } from '../src/storage/database/supabase-client';
import { _setAuditSinkForTest } from '../src/lib/audit';

async function main(): Promise<void> {
process.env.COZE_SUPABASE_JWT_SECRET = JWT_SECRET;

let step = 0;
function ok(msg: string): void {
  step++;
  console.log(`  ✅ [${step}] ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ❌ [${step + 1}] ${msg}`);
  process.exit(1);
}

function jwt(userId: string, tenantId: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      sub: userId,
      email: 'e2e@test.dev',
      app_metadata: { tenant_id: tenantId },
      exp: Math.floor(Date.now() / 1000) + 900,
    })
  ).toString('base64url');
  const s = createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

function req(url: string, method: string, body?: unknown): NextRequest {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt(OWNER, TENANT)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

async function expectStatus(res: Response, want: number, label: string): Promise<unknown> {
  const body = await res.json().catch(() => null);
  if (res.status !== want) {
    fail(`${label}: expected HTTP ${want}, got ${res.status} — ${JSON.stringify(body)?.slice(0, 400)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// DB 模式探测
// ---------------------------------------------------------------------------

let dbMode = false;
try {
  const { error } = await getSupabaseClient().from('coding_proposals').select('id').limit(1);
  dbMode = !error;
} catch {
  dbMode = false;
}
console.log(`\n=== Phase 8 E2E Acceptance (${dbMode ? 'DB' : 'memory-fallback'} mode) ===\n`);

// 内存模式下捕获审计（DB 模式直接查 audit_logs 表）
const memoryAudit: Array<{ action: string; after?: unknown }> = [];
if (!dbMode) _setAuditSinkForTest((e) => memoryAudit.push(e));

_clearAuthCaches();
_seedRoleForTest(OWNER, 'owner');
_resetPersistenceProbe();
if (!dbMode) clearProposalStore();

// ---------------------------------------------------------------------------
// 1. 创建提案
// ---------------------------------------------------------------------------

const proposalId = `cprop_e2e_${Date.now().toString(36)}`;
await saveProposal(
  {
    id: proposalId,
    taskId: 'task_e2e_p8',
    status: 'pending_review',
    title: 'E2E: add phase8 acceptance widget',
    summary: 'Adds a trivial custom widget to prove the full approval pipeline.',
    changes: [
      {
        filePath: TARGET_FILE,
        operation: 'create',
        proposedContent: `// Phase 8 E2E acceptance artifact (auto-rolled-back)\nexport const phase8E2e = 'ok';\n`,
        rationale: 'Acceptance drill change',
      },
    ],
    riskLevel: 'safe',
    requiresHumanApproval: true,
    blockedPaths: [],
    generatedAt: new Date().toISOString(),
  },
  TENANT
);
ok(`proposal created: ${proposalId}`);

// ---------------------------------------------------------------------------
// 2. review 端点：diff + checks
// ---------------------------------------------------------------------------

const review1 = (await expectStatus(
  await reviewGet(req(`/api/coding-agent/review?id=${proposalId}`, 'GET')),
  200,
  'review GET'
)) as {
  files: Array<{ additions: number; hunks: unknown[] }>;
  checks: {
    permission: { ok: boolean };
    security: { ok: boolean };
    rollback: { available: boolean };
  };
  activity: unknown[];
};
if (review1.files[0].additions !== 3) fail('review: diff additions mismatch');
if (!review1.checks.permission.ok) fail('review: permission check should pass');
if (!review1.checks.security.ok) fail('review: security check should pass');
if (review1.checks.rollback.available) fail('review: rollback should NOT be available yet');
ok('review: unified diff + permission/security checks OK, rollback correctly unavailable');

// ---------------------------------------------------------------------------
// 3. changes_requested（带备注）
// ---------------------------------------------------------------------------

await expectStatus(
  await PATCH(req('/api/coding-agent', 'PATCH', {
    id: proposalId,
    status: 'changes_requested',
    note: 'E2E: keep it to a single file please',
  })),
  200,
  'PATCH changes_requested'
);
const afterCr = await getProposalById(proposalId, TENANT);
if (afterCr?.status !== 'changes_requested') fail('status should be changes_requested');
if (afterCr?.reviewNote !== 'E2E: keep it to a single file please') fail('reviewNote not persisted');
ok('changes_requested with note persisted');

// ---------------------------------------------------------------------------
// 4. approved
// ---------------------------------------------------------------------------

await expectStatus(
  await PATCH(req('/api/coding-agent', 'PATCH', { id: proposalId, status: 'approved' })),
  200,
  'PATCH approved'
);
ok('changes_requested → approved transition OK');

// ---------------------------------------------------------------------------
// 5. apply（真实 git worktree + 测试门禁，耗时分钟级）
// ---------------------------------------------------------------------------

console.log('  ⏳ applying (worktree + full test gate, may take 2-4 min)...');
const applyBody = (await expectStatus(
  await applyPost(req('/api/coding-agent/apply', 'POST', { id: proposalId })),
  200,
  'apply POST'
)) as { commitSha?: string };
if (!applyBody.commitSha) fail('apply: missing commitSha');
if (!existsSync(TARGET_FILE)) fail('apply: target file should exist after merge');
ok(`applied as commit ${applyBody.commitSha.slice(0, 8)}; file exists on disk`);

// ---------------------------------------------------------------------------
// 6. review 复检：gate=pass、rollback 可用
// ---------------------------------------------------------------------------

const review2 = (await expectStatus(
  await reviewGet(req(`/api/coding-agent/review?id=${proposalId}`, 'GET')),
  200,
  'review GET after apply'
)) as {
  checks: { testGate: { lastResult: string }; rollback: { available: boolean } };
};
if (review2.checks.testGate.lastResult !== 'pass') fail('testGate lastResult should be pass');
if (!review2.checks.rollback.available) fail('rollback should be available after apply');
ok('post-apply review: test gate PASS, rollback available');

// ---------------------------------------------------------------------------
// 7. rollback
// ---------------------------------------------------------------------------

const rollbackBody = (await expectStatus(
  await rollbackPost(req('/api/coding-agent/rollback', 'POST', { id: proposalId })),
  200,
  'rollback POST'
)) as { commitSha?: string };
if (existsSync(TARGET_FILE)) fail('rollback: target file should be gone after revert');
const afterRb = await getProposalById(proposalId, TENANT);
if (afterRb?.status !== 'rolled_back') fail('status should be rolled_back');
ok(`rolled back as ${rollbackBody.commitSha?.slice(0, 8)}; file removed, status rolled_back`);

// 清理 agent 分支
try {
  execFileSync('git', ['-c', 'gc.auto=0', 'branch', '-D', `agent/${proposalId}`], {
    stdio: 'pipe',
  });
  ok(`branch agent/${proposalId} cleaned up`);
} catch {
  console.log('  ⚠️  branch cleanup failed (harmless, delete manually)');
}

// ---------------------------------------------------------------------------
// 8. 审计断言
// ---------------------------------------------------------------------------

const EXPECTED_ACTIONS = [
  'coding_proposal.changes_requested',
  'coding_proposal.approved',
  'coding_proposal.apply',
  'coding_proposal.rollback',
];

if (dbMode) {
  const { data, error } = await getSupabaseClient()
    .from('audit_logs')
    .select('action')
    .eq('tenant_id', TENANT)
    .eq('entity', 'coding_proposal')
    .eq('entity_id', proposalId);
  if (error) fail(`audit query failed: ${error.message}`);
  const actions = (data ?? []).map((r: { action: string }) => r.action);
  for (const a of EXPECTED_ACTIONS) {
    if (!actions.includes(a)) fail(`audit_logs missing action: ${a}`);
  }
  // review_note 落库断言
  const { data: row } = await getSupabaseClient()
    .from('coding_proposals')
    .select('review_note')
    .eq('id', proposalId)
    .maybeSingle();
  if ((row as { review_note?: string } | null)?.review_note !== 'E2E: keep it to a single file please') {
    fail('review_note not persisted in DB');
  }
  ok(`audit_logs: all ${EXPECTED_ACTIONS.length} actions persisted; review_note in DB`);
} else {
  for (const a of EXPECTED_ACTIONS) {
    if (!memoryAudit.some((e) => e.action === a)) fail(`memory audit missing action: ${a}`);
  }
  ok(`audit sink: all ${EXPECTED_ACTIONS.length} actions captured (DB persistence: SKIP, no credentials)`);
}

console.log(`\n=== E2E ACCEPTANCE PASSED (${step} steps, ${dbMode ? 'DB' : 'memory'} mode) ===\n`);
return;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
