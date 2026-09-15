"""Phase 9 / Task 2 —— Approval Decision 跨语言共享契约（Python 侧）。

与 TS 侧 `tests/approval-contract.test.ts` 读取**同一份**样例集
`tests/fixtures/approval_decision_contract.json`。任何一侧的审批语义漂移都会
让两侧测试同时变红 —— 这是本契约存在的唯一理由。

背景：此前 Python gate 用 `rank >= required + 1` 且完全不看 risk，TS 用
`rank >= required` 且对 admin 恒 false。同一个 (role, required_role) 在两个
平面上可能得出相反结论。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from roveagent.tools.framework import EnterpriseToolGate

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "tests" / "fixtures" / "approval_decision_contract.json"
)


class ApprovalContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(_FIXTURE.read_text(encoding="utf-8"))

    def test_fixture_is_present_and_versioned(self) -> None:
        self.assertEqual(self.contract["version"], 1)
        self.assertGreater(len(self.contract["decide_cases"]), 10)
        self.assertGreater(len(self.contract["can_approve_cases"]), 3)

    def test_decide_approval_matches_shared_contract(self) -> None:
        for case in self.contract["decide_cases"]:
            with self.subTest(case=case["name"]):
                decision = EnterpriseToolGate.decide_approval(
                    case["role"], case["required_role"], case["risk"],
                )
                self.assertEqual(
                    decision["approval_required"],
                    case["approval_required"],
                    f"{case['name']}: {decision['reason']}",
                )
                # 规范形状必须齐全 —— 两侧都以此结构交换数据
                for key in ("role", "required_role", "risk", "approval_required", "reason"):
                    self.assertIn(key, decision)
                self.assertEqual(decision["role"], case["role"])
                self.assertEqual(decision["required_role"], case["required_role"])

    def test_high_and_critical_never_auto_skip(self) -> None:
        """Task 1/2 的核心收紧点，独立于样例集再断言一次。"""
        for risk in ("high", "critical"):
            for role in ("staff", "manager", "owner", "admin"):
                with self.subTest(risk=risk, role=role):
                    decision = EnterpriseToolGate.decide_approval(role, "manager", risk)
                    self.assertTrue(
                        decision["approval_required"],
                        f"{role} 不得对 {risk} 风险动作免审直执",
                    )

    def test_medium_and_low_keep_senior_role_exemption(self) -> None:
        """收紧范围不得扩大到 MEDIUM/LOW —— 否则会大面积中断日常流程。"""
        for risk in ("low", "medium"):
            with self.subTest(risk=risk):
                self.assertFalse(
                    EnterpriseToolGate.decide_approval("owner", "manager", risk)["approval_required"],
                )
                self.assertTrue(
                    EnterpriseToolGate.decide_approval("manager", "manager", risk)["approval_required"],
                )

    def test_gate_check_approval_delegates_to_the_shared_rule(self) -> None:
        """gate 的 check_approval 必须与 decide_approval 完全一致（无第二套语义）。"""
        from roveagent.tools.framework import RiskLevel, ToolContext, ToolPolicy

        for case in self.contract["decide_cases"]:
            if case["required_role"] is None:
                continue
            approval_policy = {
                "manager": "manager", "owner": "owner", "admin": "admin",
            }[case["required_role"]]
            policy = ToolPolicy(
                pattern="contract_probe",
                permission="",
                risk={
                    "low": RiskLevel.LOW, "medium": RiskLevel.MEDIUM,
                    "high": RiskLevel.HIGH, "critical": RiskLevel.CRITICAL,
                }[case["risk"]],
                approval=approval_policy,
            )
            ctx = ToolContext(
                tenant_id="t", business_id="b", user_id="u", role=case["role"],
                permissions=frozenset({"*"}), request_id="r", task_id="k",
            )
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    EnterpriseToolGate.check_approval(policy, ctx),
                    not case["approval_required"],
                )


if __name__ == "__main__":
    unittest.main()
