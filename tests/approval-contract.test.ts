/**
 * Phase 9 / Task 2 —— Approval Decision 跨语言共享契约（TS 侧）。
 *
 * 与 Python 侧 `roveagent/tools/approval_contract_test.py` 读取**同一份**样例集
 * `tests/fixtures/approval_decision_contract.json`。任何一侧的审批语义漂移都会
 * 让两侧测试同时变红。
 *
 * 背景：此前 Python gate 用 `rank >= required + 1`（且完全不看 risk），TS 用
 * `rank >= required`（且对 admin 恒 false）。同一个 (role, required_role)
 * 在两个平面上可能得出相反结论。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canApprove, decideApproval } from '../src/lib/agent/approvals';
import type { ApprovalRisk, ApprovalRole } from '../src/lib/agent/approvals';
import type { RoleKey } from '../src/lib/rbac';

interface DecideCase {
  name: string;
  role: RoleKey;
  required_role: ApprovalRole | null;
  risk: ApprovalRisk;
  approval_required: boolean;
}

interface CanApproveCase {
  name: string;
  role: RoleKey;
  required_role: ApprovalRole;
  can_approve: boolean;
}

interface Contract {
  version: number;
  decide_cases: DecideCase[];
  can_approve_cases: CanApproveCase[];
}

const contract: Contract = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), 'tests/fixtures/approval_decision_contract.json'),
    'utf8',
  ),
) as Contract;

describe('Approval Decision cross-language contract', () => {
  test('fixture is versioned and non-trivial', () => {
    assert.equal(contract.version, 1);
    assert.ok(contract.decide_cases.length > 10);
    assert.ok(contract.can_approve_cases.length > 3);
  });

  test('decideApproval matches the shared contract', () => {
    for (const sample of contract.decide_cases) {
      const decision = decideApproval({
        role: sample.role,
        requiredRole: sample.required_role,
        risk: sample.risk,
      });
      assert.equal(
        decision.approvalRequired,
        sample.approval_required,
        `${sample.name}: ${decision.reason}`,
      );
      // 规范形状必须齐全 —— 两侧都以此结构交换数据
      for (const key of ['role', 'requiredRole', 'risk', 'approvalRequired', 'reason']) {
        assert.ok(key in decision, `missing canonical field: ${key}`);
      }
      // risk 必须被原样回传，供审计使用
      assert.equal(decision.risk, sample.risk);
    }
  });

  test('HIGH and CRITICAL never auto-skip for any role', () => {
    for (const risk of ['high', 'critical'] as const) {
      for (const role of ['staff', 'manager', 'owner', 'admin'] as const) {
        const decision = decideApproval({ role, requiredRole: 'manager', risk });
        assert.equal(
          decision.approvalRequired,
          true,
          `${role} must not auto-skip ${risk} risk`,
        );
      }
    }
  });

  test('MEDIUM and LOW keep the senior-role exemption', () => {
    for (const risk of ['low', 'medium'] as const) {
      assert.equal(decideApproval({ role: 'owner', requiredRole: 'manager', risk }).approvalRequired, false);
      assert.equal(decideApproval({ role: 'manager', requiredRole: 'manager', risk }).approvalRequired, true);
    }
  });

  test('canApprove matches the shared contract', () => {
    for (const sample of contract.can_approve_cases) {
      assert.equal(
        canApprove(sample.role, sample.required_role),
        sample.can_approve,
        sample.name,
      );
    }
  });

  test('decide and canApprove agree on who may act (no second semantics)', () => {
    // 对 HIGH/CRITICAL：decideApproval 要求审批，且 canApprove 的结论必须与之自洽
    // —— 即 owner 能批 owner 级，但平台 admin 级对商户域恒不可批。
    for (const risk of ['high', 'critical'] as const) {
      for (const required of ['manager', 'owner'] as const) {
        const decision = decideApproval({ role: 'owner', requiredRole: required, risk });
        assert.equal(decision.approvalRequired, true);
        // owner 可以批准 manager/owner 级 → 审批链可闭合，不会产生无法完成的审批单
        assert.equal(
          canApprove('owner', required),
          true,
          `owner must be able to close a ${required}-level approval, otherwise the record is unapprovable`,
        );
      }
    }
    // 平台 admin 级：商户域无人可批 —— 必须与 decideApproval 的分支一致。
    // 注意用 low 风险触发 admin 分支：HIGH/CRITICAL 分支排在它之前，
    // 会先以「高危不得跳过」为由返回（这也是契约规定的顺序）。
    const adminLevel = decideApproval({ role: 'owner', requiredRole: 'admin', risk: 'low' });
    assert.equal(adminLevel.approvalRequired, true);
    assert.equal(canApprove('owner', 'admin'), false);
    assert.equal(canApprove('admin', 'admin'), false);
    assert.match(adminLevel.reason, /platform-admin/);

    // 而 high 风险的 admin 级动作命中的是「高危不得跳过」分支
    const adminHigh = decideApproval({ role: 'owner', requiredRole: 'admin', risk: 'high' });
    assert.equal(adminHigh.approvalRequired, true);
    assert.match(adminHigh.reason, /no role may auto-skip/);
  });
});
