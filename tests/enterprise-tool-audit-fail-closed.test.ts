import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeEnterpriseTool } from '../src/lib/enterprise/tool-runtime';
import { _setAgentAuditSinkForTest } from '../src/lib/agent/audit';
import type { AgentAuditEvent, AgentToolContext } from '../src/lib/agent/types';

/**
 * `executeEnterpriseTool` 的**审计失败语义**。
 *
 * ## 被修的是什么
 *
 * 四个调用点（permission denied / agent-role denied / succeeded / failed）都写成
 * `await writeAgentAction(...).catch(() => undefined)` —— 把审计写入失败吞掉了。
 * 危险的方向只有一个：**工具已经执行成功，而记录它的那行没写进去，调用方却被告知
 * `ok: true`**。那是"做了一件无法证明做过的事"。
 *
 * 同一条链上的另一个守卫（`src/lib/mutation-guard.ts`）是 fail-closed：
 * 审计写不进去就 503「security audit unavailable」，绝不把未记录的操作报成成功。
 * 本文件把工具运行时对齐到同一语义。
 *
 * ## 为什么用注入 sink 而不是"制造一次真的库错误"
 *
 * 后者要么依赖库的当前状态（不稳），要么往生产库里塞坏数据（不可接受）。
 * sink 缝与 `src/lib/audit.ts` 的 `_setAuditSinkForTest` 同一约定。
 *
 * ## 本文件自带正反两个方向
 *
 *   · 反方向（审计失败）：执行成功不得报 ok；拒绝必须能被区分为"拒绝但没记下来"。
 *   · 正方向（审计正常）：成功仍然 ok:true；拒绝仍然是 blocked + permission denied。
 * 只有反方向会把"什么都失败"的坏实现也判成通过，只有正方向会把当前的坏实现判成通过。
 */

function ctxFor(role: 'owner' | 'staff') {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    businessId: '00000000-0000-0000-0000-000000000001',
    userId: 'audit-fail-closed-test-user',
    role,
    agentRole: 'devops' as const,
    sessionId: 'audit-fail-closed-test-session',
    locale: 'en',
  };
}

/** 只记录、不抛错 —— 模拟"审计正常"。 */
const okSink = async (_c: AgentToolContext, _e: AgentAuditEvent) => undefined;

/** 总是抛错 —— 模拟"审计写不进去"。 */
const failingSink = async () => {
  throw new Error('MUTATION/FAULT: audit store unavailable');
};

describe('executeEnterpriseTool 审计失败必须 fail-closed', () => {
  beforeEach(() => { _setAgentAuditSinkForTest(null); });
  afterEach(() => { _setAgentAuditSinkForTest(null); });

  // ---------------------------------------------------------------------
  // 反方向：审计失败
  // ---------------------------------------------------------------------

  test('工具执行成功但审计写失败 -> 不得返回 ok:true', async () => {
    _setAgentAuditSinkForTest(failingSink);

    // deployment.deploy 的 run() 是纯函数（generateDeploymentPlan），不碰库，
    // 因此这里唯一会失败的就是审计写入本身。
    // owner 持 '*'，devops 命名空间允许 deployment.* —— 两个闸门都应当放行。
    const result = await executeEnterpriseTool('deployment.deploy', {}, ctxFor('owner'));

    assert.equal(
      result.ok, false,
      '工具执行了、审计没写进去，却报 ok:true —— 这就是"做了一件无法证明做过的事"。'
      + `实际返回：${JSON.stringify(result)}`,
    );
    assert.match(
      String(result.error), /audit/i,
      '失败原因必须指出是审计不可用，而不是一个语焉不详的失败',
    );
    assert.equal(result.auditFailed, true, '必须有一个显式的 auditFailed 标记供调用方判别');
  });

  test('权限拒绝 + 审计写失败 -> 必须能与"普通拒绝"区分', async () => {
    _setAgentAuditSinkForTest(failingSink);

    // staff 没有 deployment:execute（只有 owner 的 '*' 有）
    const result = await executeEnterpriseTool('deployment.deploy', {}, ctxFor('staff'));

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true, '仍然是被拒绝');
    assert.match(
      String(result.error), /audit/i,
      '拒绝本身记不下来也是一件事，不能静默：调用方要能看出"记录缺失"',
    );
    assert.equal(result.auditFailed, true);
  });

  // ---------------------------------------------------------------------
  // 正方向：审计正常（防止把修复做成"一律失败"）
  // ---------------------------------------------------------------------

  test('审计正常时，成功路径仍然是 ok:true（修复不得把所有调用判成失败）', async () => {
    _setAgentAuditSinkForTest(okSink);

    const result = await executeEnterpriseTool('deployment.deploy', {}, ctxFor('owner'));

    assert.equal(result.ok, true, `审计正常时应当成功，实际 ${JSON.stringify(result)}`);
    assert.equal(result.auditFailed, undefined, '审计成功时不应带 auditFailed');
    assert.ok(result.data !== undefined, '成功路径必须带回数据');
  });

  test('审计正常时，权限拒绝仍然是被拒绝且原因明确', async () => {
    _setAgentAuditSinkForTest(okSink);

    const result = await executeEnterpriseTool('deployment.deploy', {}, ctxFor('staff'));

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(String(result.error), /permission denied/);
    assert.equal(result.auditFailed, undefined);
  });

  test('负向对照：sink 注入本身是生效的（否则上面几条什么都没证明）', async () => {
    let calls = 0;
    _setAgentAuditSinkForTest(async () => { calls++; });

    await executeEnterpriseTool('deployment.deploy', {}, ctxFor('owner'));
    assert.equal(calls, 1, 'sink 必须真的被调用到 —— 否则"审计失败"那条根本没走到审计');

    // 而且失败的 sink 必须真的让 writeAgentAction 抛错（否则修复无从谈起）
    _setAgentAuditSinkForTest(failingSink);
    const { writeAgentAction } = await import('../src/lib/agent/audit');
    await assert.rejects(
      () => writeAgentAction({} as AgentToolContext, {} as AgentAuditEvent),
      /audit store unavailable/,
      'writeAgentAction 在 sink 抛错时必须向外抛，而不是吞掉',
    );
  });
});
