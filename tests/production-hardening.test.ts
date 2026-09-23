/**
 * Production Hardening Sprint
 * tests/production-hardening.test.ts
 *
 * 覆盖：withAuth 中间件原语、proxy 头注入/剥离、公开路由判定、
 * apply 引擎路径复检、持久化存储的内存回退。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPublicApiPath,
  injectRfHeaders,
  stripRfHeaders,
  resolveRequestUser,
  RF_HEADERS,
} from '../src/lib/auth-guard';
import type { AuthenticatedUser } from '../src/lib/auth';
import { revalidateChanges } from '../src/lib/coding-agent/apply-engine';
import type { CodingProposal } from '../src/lib/coding-agent/types';
import {
  saveProposal,
  getProposalById,
  listProposals,
  updateProposalStatus,
} from '../src/lib/coding-agent/persistent-store';
import {
  captureErrorPersisted,
  listCapturedErrors,
  countByFingerprint,
} from '../src/lib/healing/persistent-store';
import { clearProposalStore } from '../src/lib/coding-agent/proposal-store';
import { clearErrorBuffer } from '../src/lib/healing/error-collector';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TENANT = 'tenant_test_hardening';

function makeUser(): AuthenticatedUser {
  return {
    userId: 'user_1',
    email: 'owner@example.com',
    tenantId: TENANT,
    businessId: 'biz_1',
    role: 'owner',
    name: 'Owner',
  };
}

function makeProposal(overrides: Partial<CodingProposal> = {}): CodingProposal {
  return {
    id: `cprop_test_${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task_test',
    status: 'pending_review',
    title: 'Test proposal',
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

// ---------------------------------------------------------------------------
// 公开路由判定
// ---------------------------------------------------------------------------

describe('Auth Guard: public path matching', () => {
  test('public prefixes match exactly and as prefixes', () => {
    assert.equal(isPublicApiPath('/api/auth/login'), true);
    assert.equal(isPublicApiPath('/api/store/menu'), true);
    assert.equal(isPublicApiPath('/api/store/orders'), true);
    assert.equal(isPublicApiPath('/api/customer/favorites'), true);
  });

  test('management routes are NOT public', () => {
    assert.equal(isPublicApiPath('/api/coding-agent'), false);
    assert.equal(isPublicApiPath('/api/healing'), false);
    assert.equal(isPublicApiPath('/api/store/qr-codes'), false);
    assert.equal(isPublicApiPath('/api/settings/wipe'), false);
    assert.equal(isPublicApiPath('/api/agent/chat'), false);
  });

  test('prefix does not over-match (loginx is not login)', () => {
    assert.equal(isPublicApiPath('/api/auth/loginx'), false);
  });
});

// ---------------------------------------------------------------------------
// x-rf-* 头注入与剥离
// ---------------------------------------------------------------------------

describe('Auth Guard: rf header injection', () => {
  test('injectRfHeaders sets tenant context headers', () => {
    const h = new Headers();
    injectRfHeaders(h, makeUser());
    assert.equal(h.get(RF_HEADERS.tenantId), TENANT);
    assert.equal(h.get(RF_HEADERS.userId), 'user_1');
    assert.equal(h.get(RF_HEADERS.role), 'owner');
    assert.equal(h.get(RF_HEADERS.businessId), 'biz_1');
  });

  test('stripRfHeaders removes forged client headers', () => {
    const h = new Headers();
    h.set(RF_HEADERS.tenantId, 'forged_tenant');
    h.set(RF_HEADERS.role, 'owner');
    stripRfHeaders(h);
    assert.equal(h.get(RF_HEADERS.tenantId), null);
    assert.equal(h.get(RF_HEADERS.role), null);
  });

  test('inject overwrites forged headers (strip-then-set)', () => {
    const h = new Headers();
    h.set(RF_HEADERS.tenantId, 'forged_tenant');
    injectRfHeaders(h, makeUser());
    assert.equal(h.get(RF_HEADERS.tenantId), TENANT);
  });

  // Phase 19：这里原有 3 条 getAuthContext 的用例，随该函数一起删除。
  //
  // 说明清楚，避免被读成"删测试让流水线变绿"：那 3 条测试的唯一作用是
  // 测试一个**没有任何生产调用点**的函数（全仓 0 读取，见 auth-guard.ts 文件头
  // 的记录与 Dead_Code_Deletion_Stop_Report.md §6）。函数没了，测它的用例也就
  // 没有对象了。真正的边界（proxy 注入/剥离 + withAuth 完整校验 + 中央变更守卫）
  // 的用例在本文件其余部分与 api-rbac-contract.test.ts 里，一条都没动。
});

// ---------------------------------------------------------------------------
// resolveRequestUser —— 无 token 直接拒绝
// ---------------------------------------------------------------------------

describe('Auth Guard: resolveRequestUser', () => {
  test('missing credential is rejected', async () => {
    const req = new Request('http://localhost/api/x');
    const result = await resolveRequestUser(req);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Apply Engine —— 路径复检
// ---------------------------------------------------------------------------

describe('Apply Engine: revalidateChanges', () => {
  test('accepts a clean create under src/custom/', () => {
    assert.deepEqual(revalidateChanges(makeProposal()), []);
  });

  test('rejects path traversal', () => {
    const p = makeProposal({
      changes: [
        { filePath: 'src/custom/../../package.json', operation: 'create', proposedContent: 'x', rationale: 'evil' },
      ],
    });
    const problems = revalidateChanges(p);
    assert.ok(problems.length > 0);
  });

  test('rejects absolute path', () => {
    const p = makeProposal({
      changes: [
        { filePath: '/etc/passwd', operation: 'create', proposedContent: 'x', rationale: 'evil' },
      ],
    });
    assert.ok(revalidateChanges(p).length > 0);
  });

  test('rejects denied core path even if prefixed innocently', () => {
    const p = makeProposal({
      changes: [
        { filePath: 'src/custom/../lib/crypto.ts', operation: 'modify', proposedContent: 'x', rationale: 'evil' },
      ],
    });
    assert.ok(revalidateChanges(p).length > 0);
  });

  test('rejects create without proposedContent', () => {
    const p = makeProposal({
      changes: [{ filePath: 'src/custom/a.ts', operation: 'create', rationale: 'no content' }],
    });
    assert.ok(revalidateChanges(p).length > 0);
  });

  test('rejects empty change list', () => {
    const p = makeProposal({ changes: [] });
    assert.ok(revalidateChanges(p).length > 0);
  });

  test('rejects writes outside allowlist', () => {
    const p = makeProposal({
      changes: [
        { filePath: 'src/lib/utils.ts', operation: 'modify', proposedContent: 'x', rationale: 'out of scope' },
      ],
    });
    assert.ok(revalidateChanges(p).length > 0);
  });
});

// ---------------------------------------------------------------------------
// 持久化存储 —— 无 DB 环境下回退内存
// ---------------------------------------------------------------------------

describe('Persistent stores: memory fallback without DB', () => {
  // 确定性接缝：显式声明内存模式，而不是依赖「这台机器上没有可连的库」。
  // 原用例没有这个接缝，一旦环境里存在可连的 Supabase（例如 scripts/deploy.env
  // 提供了真实凭据），store 会切到 DB 模式，本组用例全部变红 —— 环境相关的红/绿
  // 不是有效信号。
  const previousStore = process.env.RF_CODING_AGENT_STORE;
  beforeEach(() => {
    process.env.RF_CODING_AGENT_STORE = 'memory';
    clearProposalStore();
    clearErrorBuffer();
  });
  afterEach(() => {
    if (previousStore === undefined) delete process.env.RF_CODING_AGENT_STORE;
    else process.env.RF_CODING_AGENT_STORE = previousStore;
  });

  test('proposal save/get roundtrip works without database', async () => {
    const p = makeProposal({ id: 'cprop_fallback_1' });
    await saveProposal(p, TENANT);
    const found = await getProposalById('cprop_fallback_1', TENANT);
    assert.ok(found);
    assert.equal(found.title, 'Test proposal');
  });

  test('proposal status update roundtrip', async () => {
    const p = makeProposal({ id: 'cprop_fallback_2' });
    await saveProposal(p, TENANT);
    const updated = await updateProposalStatus('cprop_fallback_2', 'approved', TENANT, {
      decidedBy: 'user_1',
      decidedAt: new Date().toISOString(),
    });
    assert.ok(updated);
    assert.equal(updated.status, 'approved');
  });

  // 回归：内存回退路径曾丢失 patch 字段，导致 appliedCommitSha 写不进去、
  // rollback 无法执行（Apply Engine 演练发现的真 bug）
  test('memory fallback preserves patch fields (appliedCommitSha regression)', async () => {
    const p = makeProposal({ id: 'cprop_fallback_patch' });
    await saveProposal(p, TENANT);
    await updateProposalStatus('cprop_fallback_patch', 'applied', TENANT, undefined, {
      appliedAt: new Date().toISOString(),
      appliedBy: 'user_1',
      appliedCommitSha: 'abc123def456',
    });
    const found = await getProposalById('cprop_fallback_patch', TENANT);
    assert.equal(found?.status, 'applied');
    assert.equal(found?.appliedCommitSha, 'abc123def456');
    assert.equal(found?.appliedBy, 'user_1');
  });

  test('proposal list returns saved proposals', async () => {
    await saveProposal(makeProposal({ id: 'cprop_fallback_3' }), TENANT);
    const list = await listProposals(10, TENANT);
    assert.ok(list.some((p) => p.id === 'cprop_fallback_3'));
  });

  test('error capture persists and fingerprints count', async () => {
    await captureErrorPersisted({ message: 'Unexpected end of JSON input' }, TENANT);
    await captureErrorPersisted({ message: 'Unexpected end of JSON input' }, TENANT);
    const list = await listCapturedErrors(10, TENANT);
    assert.ok(list.length >= 2);
    const count = await countByFingerprint(list[0].fingerprint, TENANT);
    assert.ok(count >= 2);
  });
});
