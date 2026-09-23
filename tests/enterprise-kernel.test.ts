/**
 * Phase 2/7 — Enterprise Kernel
 * tests/enterprise-kernel.test.ts
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_TEAM, roleCanUseTool, listAgentTeam } from '../src/lib/enterprise/agents';
import {
  executeEnterpriseTool,
  listEnterpriseTools,
  getEnterpriseTool,
} from '../src/lib/enterprise/tool-runtime';
import { assembleMemoryContext } from '../src/lib/enterprise/memory';
import { _setAgentAuditSinkForTest } from '../src/lib/agent/audit';

const BASE_CTX = {
  tenantId: 'tenant_test',
  businessId: 'biz_test',
  userId: 'user_test',
  sessionId: 'session_test',
};

describe('Enterprise: agent team', () => {
  test('six roles defined', () => {
    assert.equal(AGENT_TEAM.length, 6);
    const ids = AGENT_TEAM.map((r) => r.id).sort();
    assert.deepEqual(ids, ['ceo', 'customer', 'developer', 'devops', 'marketing', 'operations']);
  });

  test('listAgentTeam hides system prompts', () => {
    for (const r of listAgentTeam()) {
      assert.equal('systemPrompt' in r, false);
    }
  });

  test('namespace gating per role', () => {
    assert.equal(roleCanUseTool('marketing', 'marketing.create_campaign'), true);
    assert.equal(roleCanUseTool('marketing', 'deployment.deploy'), false);
    assert.equal(roleCanUseTool('devops', 'deployment.deploy'), true);
    assert.equal(roleCanUseTool('developer', 'coding.apply'), true);
    assert.equal(roleCanUseTool('customer', 'system.health_check'), false);
  });
});

describe('Enterprise: tool runtime permission gate', () => {
  /**
   * 本组用例**必须**注入审计 sink，否则它们测的不是权限门，而是数据库连接。
   *
   * 实测（fail-closed 修复后暴露）：`BASE_CTX` 用的是 `tenant_test` / `biz_test`
   * 这类假 id，`writeAgentAction` 的插入会撞
   * `agent_actions_tenant_id_fkey` 外键约束而**抛错**。
   *
   * 在修复之前，`executeEnterpriseTool` 用 `.catch(() => undefined)` 把这个抛错吞了，
   * 于是 "deployment.deploy works for owner+devops" 这条用例**一直是在审计写入失败
   * 的情况下被判为通过**的 —— 它的绿色并不证明审计链是通的。
   * 现在审计失败会变成显式失败，假 id 就再也混不过去了，因此这里注入一个
   * 成功 sink：本组要断言的是权限/命名空间/输入校验，不是审计存储。
   * 审计失败本身的语义由 tests/enterprise-tool-audit-fail-closed.test.ts 覆盖。
   */
  beforeEach(() => { _setAgentAuditSinkForTest(async () => undefined); });
  afterEach(() => { _setAgentAuditSinkForTest(null); });

  test('unknown tool rejected', async () => {
    const r = await executeEnterpriseTool('no.such.tool', {}, { ...BASE_CTX, role: 'owner', agentRole: 'ceo' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /unknown tool/);
  });

  test('staff blocked from deployment.deploy (RBAC)', async () => {
    const r = await executeEnterpriseTool(
      'deployment.deploy',
      {},
      { ...BASE_CTX, role: 'staff', agentRole: 'devops' }
    );
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.match(r.error ?? '', /permission denied/);
  });

  test('owner role but wrong agent role blocked (namespace)', async () => {
    const r = await executeEnterpriseTool(
      'deployment.deploy',
      {},
      { ...BASE_CTX, role: 'owner', agentRole: 'customer' }
    );
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
  });

  test('invalid input rejected by schema', async () => {
    const r = await executeEnterpriseTool(
      'marketing.create_campaign',
      { name: '' },
      { ...BASE_CTX, role: 'owner', agentRole: 'marketing' }
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /invalid input/);
  });

  test('deployment.deploy works for owner+devops without touching servers', async () => {
    const r = await executeEnterpriseTool(
      'deployment.deploy',
      { domain: 'app.example.com' },
      { ...BASE_CTX, role: 'owner', agentRole: 'devops' }
    );
    assert.equal(r.ok, true);
    const data = r.data as { artifacts: string[]; steps: string[] };
    assert.ok(data.artifacts.includes('Dockerfile'));
    assert.equal(data.steps.length, 5);
  });

  test('tool catalogue lists six tools', () => {
    const tools = listEnterpriseTools();
    assert.equal(tools.length, 6);
    assert.ok(getEnterpriseTool('system.health_check'));
  });
});

describe('Enterprise: memory layers degrade gracefully', () => {
  test('assembles with all layers unavailable (no DB) without throwing', async () => {
    const ctx = await assembleMemoryContext({
      tenantId: 'tenant_nope',
      businessId: 'business_nope',
      customerId: 'cust_nope',
    });
    assert.equal(ctx.layers.length, 4);
    for (const layer of ctx.layers) {
      assert.equal(typeof layer.available, 'boolean');
      assert.equal(typeof layer.content, 'string');
    }
    assert.equal(typeof ctx.combined, 'string');
  });

  test('customer layer omitted when customerId not given', async () => {
    const ctx = await assembleMemoryContext({ tenantId: 't', businessId: 'b' });
    assert.equal(ctx.layers.length, 3);
  });
});
