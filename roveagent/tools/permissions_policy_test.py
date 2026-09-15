"""Step 1.5 验证：EnterpriseToolGate 策略表修正。

覆盖测试 1–5（用户验收标准）+ 安全回归断言。

运行::

    python -m unittest roveagent.tools.permissions_policy_test -v
    # 或
    python -m pytest roveagent/tools/permissions_policy_test.py -v
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from roveagent.tools.framework import (
    ApprovalPolicy,
    EnterpriseToolGate,
    RiskLevel,
    ToolContext,
)


def _ctx(role: str = "owner", permissions: tuple[str, ...] = ()) -> ToolContext:
    return ToolContext(
        tenant_id="tenant-1",
        business_id="biz-1",
        user_id="user-1",
        role=role,
        permissions=frozenset(permissions),
        request_id="req-1",
        task_id="task-1",
        agent_id="developer",
    )


class PolicyResolutionTest(unittest.TestCase):
    """测试 1–3：策略解析结果。静态表，不需真实工具。"""

    def setUp(self) -> None:
        self.gate = EnterpriseToolGate()

    # -- 测试 1 ----------------------------------------------------------
    def test_1_read_file_requires_files_read(self) -> None:
        policy = self.gate.policy_for("read_file")
        self.assertEqual(policy.pattern, "read_file")
        self.assertEqual(policy.permission, "files:read")
        self.assertEqual(policy.risk, RiskLevel.LOW)
        self.assertEqual(policy.approval, ApprovalPolicy.NONE)

    # -- 测试 2 ----------------------------------------------------------
    def test_2_write_file_risk_raised_to_high(self) -> None:
        """Phase 9：write_file / patch 由 MEDIUM 升为 HIGH。

        原因：MEDIUM 走的是「上级免审」语义，owner/admin 可凭角色等级直接改文件而不
        产生审批单。文件写入属于不可逆副作用，必须强制第二方确认。
        """
        for name in ("write_file", "patch"):
            with self.subTest(tool=name):
                policy = self.gate.policy_for(name)
                self.assertEqual(policy.permission, "files:write")
                self.assertEqual(policy.risk, RiskLevel.HIGH)
                self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

    # -- 测试 3 ----------------------------------------------------------
    def test_3_terminal_requires_admin_process_with_approval(self) -> None:
        policy = self.gate.policy_for("terminal")
        self.assertEqual(policy.pattern, "terminal")
        self.assertEqual(policy.permission, "admin:process")
        self.assertEqual(policy.risk, RiskLevel.HIGH)
        self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

    def test_3b_process_matches_exact_policy(self) -> None:
        policy = self.gate.policy_for("process")
        self.assertEqual(policy.pattern, "process")
        self.assertEqual(policy.permission, "admin:process")
        self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

    # -- 其他文件工具 -----------------------------------------------------
    def test_search_files_requires_files_read(self) -> None:
        policy = self.gate.policy_for("search_files")
        self.assertEqual(policy.permission, "files:read")
        self.assertEqual(policy.approval, ApprovalPolicy.NONE)

    # -- 业务查询工具必须保持各自的细粒度权限（严格分离的回归保护）--------
    def test_business_read_tools_keep_their_specific_permissions(self) -> None:
        """策略表更靠前的位置已为每个业务查询工具登记了各自的权限点。

        这些行必须在 `read_*` 通配之前命中 —— 本测试锁住这个事实，
        因为一旦有人把 `read_*` 上移，所有业务查询都会退化成 analytics:read。
        """
        expected = {
            "read_sales": "orders:read",
            "read_orders": "orders:read",
            "read_customers": "customers:read",
            "read_products": "products:read",
            "read_inventory": "inventory:read",
            "read_reviews": "reviews:read",
            "read_payments": "payments:read",
            "read_business_profile": "settings:read",
        }
        for name, permission in expected.items():
            with self.subTest(tool=name):
                policy = self.gate.policy_for(name)
                self.assertEqual(
                    policy.permission, permission,
                    f"{name} 必须命中显式行（{permission}），而不是 read_* 通配",
                )
                self.assertNotEqual(policy.pattern, "read_*")

    def test_business_read_tools_are_not_file_permissions(self) -> None:
        """文件权限不得泄漏到业务查询工具上。"""
        for name in ("read_sales", "read_orders", "read_customers",
                     "read_products", "read_inventory", "read_reviews",
                     "read_payments", "read_business_profile"):
            with self.subTest(tool=name):
                self.assertNotIn(
                    self.gate.policy_for(name).permission,
                    ("files:read", "files:write"),
                )

    # -- process_kill 保持原有 ADMIN 语义（行位置更靠前）-------------------
    def test_process_kill_keeps_admin_approval(self) -> None:
        policy = self.gate.policy_for("process_kill")
        self.assertEqual(policy.pattern, "process_kill")
        self.assertEqual(policy.permission, "admin:process")
        self.assertEqual(policy.approval, ApprovalPolicy.ADMIN)
        # 原表为 HIGH（不是 CRITICAL）—— 本次不改动它，此处锁住原值防止意外变更
        self.assertEqual(policy.risk, RiskLevel.HIGH)

    # -- 未开放危险工具：必须留在兜底或显式受限，不得静默提权 --------------
    def test_dangerous_tools_not_silently_opened(self) -> None:
        """部署类工具不得被本次改动放宽。"""
        for name in ("deploy_production", "deploy_app", "rollback"):
            with self.subTest(tool=name):
                policy = self.gate.policy_for(name)
                # deploy_* 命中 CRITICAL + ADMIN；其余命中兜底（仍受 未注册→拒绝 保护）
                if name.startswith("deploy_"):
                    self.assertEqual(policy.approval, ApprovalPolicy.ADMIN)
                    self.assertEqual(policy.risk, RiskLevel.CRITICAL)

    # -- 兜底策略必须仍然是空的（防止误把兜底写成放行）--------------------
    def test_fallback_policy_still_denies_unknown_tools(self) -> None:
        fallback = self.gate.policy_for("totally_unknown_tool_xyz")
        self.assertTrue(self.gate._is_fallback(fallback))
        decision = self.gate.authorize(_ctx(), "totally_unknown_tool_xyz", {})
        self.assertFalse(decision.allowed)
        self.assertIn("not registered", decision.reason)


class GateAuthorizationTest(unittest.TestCase):
    """测试 4–5：authorize() 行为（需要工具已注册，故断言实际决策）。"""

    def setUp(self) -> None:
        self.gate = EnterpriseToolGate()

    # -- 测试 4 ----------------------------------------------------------
    def test_4_developer_with_files_read_passes_gate(self) -> None:
        """developer agent 拿到 files:read 后，read_file 必须通过门控。"""
        decision = self.gate.authorize(
            _ctx(role="owner", permissions=("files:read",)),
            "read_file",
            {"path": "README.md"},
        )
        self.assertTrue(decision.allowed, f"被拒原因：{decision.reason}")
        self.assertFalse(decision.requires_approval)

    def test_4b_developer_without_files_read_is_denied(self) -> None:
        """反向断言：没有 files:read 时必须拒绝（不能因为改动而放行）。"""
        decision = self.gate.authorize(
            _ctx(role="owner", permissions=("analytics:read",)),
            "read_file",
            {"path": "README.md"},
        )
        self.assertFalse(decision.allowed)
        self.assertIn("files:read", decision.reason)

    def test_4c_analytics_permission_no_longer_unlocks_file_read(self) -> None:
        """缺陷 A 的回归保护：analytics:read 不得再单独解锁 read_file。"""
        decision = self.gate.authorize(
            _ctx(role="owner", permissions=("analytics:read",)),
            "read_file",
            {},
        )
        self.assertFalse(decision.allowed)

    # -- 测试 5 ----------------------------------------------------------
    def test_5_terminal_enters_approval_flow(self) -> None:
        """测试 5：terminal 必须进入审批流程。

        注意角色语义（实测确认的设计事实，非本次改动引入）：
        `_role_gate` 用 `_ROLE_RANK[role] >= _ROLE_RANK[required] + 1`，
        即 owner(3) >= manager(2)+1 → owner 可自行放行 MANAGER 级动作。
        因此这里用 manager(2) 作为发起者：2 >= 2+1 不成立 → 必须审批。
        """
        decision = self.gate.authorize(
            _ctx(role="manager", permissions=("admin:process",)),
            "terminal",
            {"command": "ls -la"},
        )
        self.assertFalse(decision.allowed)
        self.assertTrue(
            decision.requires_approval,
            f"terminal 应进入审批，实际 allowed={decision.allowed} reason={decision.reason}",
        )
        self.assertEqual(decision.approval_policy, ApprovalPolicy.MANAGER)
        self.assertEqual(decision.risk, RiskLevel.HIGH)

    def test_5b_terminal_without_admin_process_is_denied(self) -> None:
        """没有 admin:process 权限 → 直接拒绝，且不产生审批单。"""
        decision = self.gate.authorize(
            _ctx(role="manager", permissions=()),
            "terminal",
            {"command": "ls"},
        )
        self.assertFalse(decision.allowed)
        self.assertFalse(decision.requires_approval)

    def test_5c_high_risk_actions_never_auto_skip_approval(self) -> None:
        """Phase 9：HIGH / CRITICAL 风险动作，任何角色都不得自动跳过审批。

        旧契约（本用例原名 test_5c_owner_bypasses_manager_level_via_role_rank）：
        owner 凭 `rank >= required + 1` 的层级语义可自行放行 MANAGER 级动作，
        terminal 因此**不产生任何审批单**。这正是审计发现的缺口之一 ——
        terminal / write_file / send_* 恰是最需要第二方确认的动作。

        新契约：HIGH/CRITICAL 一律进入审批，owner 与 admin 也不例外。
        """
        decision = self.gate.authorize(
            _ctx(role="owner", permissions=("admin:process",)),
            "terminal",
            {"command": "ls -la"},
        )
        self.assertFalse(decision.allowed, "HIGH 风险动作不得对 owner 免审放行")
        self.assertTrue(decision.requires_approval)

    def test_5c2_medium_risk_keeps_senior_role_exemption(self) -> None:
        """MEDIUM/LOW 保留「上级免审」语义 —— 收紧范围只限高危动作。

        刻意不扩大到 MEDIUM：一次改动让全部工具都要求审批，会中断日常经营流程，
        且与本次任务「不得导致大量工具失效」的约束冲突。
        """
        policy = self.gate.policy_for("image_generate")
        self.assertEqual(policy.risk, RiskLevel.MEDIUM)
        self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

        # 经理本人（rank 2）不满足 rank >= 2+1 → 需要审批
        manager_decision = self.gate.authorize(
            _ctx(role="manager", permissions=()), "image_generate", {},
        )
        self.assertTrue(manager_decision.requires_approval)

        # 业主（rank 3）满足 → MEDIUM 下仍可免审直执
        owner_decision = self.gate.authorize(
            _ctx(role="owner", permissions=()), "image_generate", {},
        )
        self.assertTrue(owner_decision.allowed, owner_decision.reason)

    def test_5d_terminal_no_longer_hits_fallback_policy(self) -> None:
        """缺陷 B 的回归保护：terminal/process 不得再命中兜底策略。"""
        for name in ("terminal", "process"):
            with self.subTest(tool=name):
                policy = self.gate.policy_for(name)
                self.assertFalse(
                    self.gate._is_fallback(policy),
                    f"{name} 仍命中兜底策略 —— 会被免审批直执",
                )


class AuditRootTest(unittest.TestCase):
    """问题 C：审计根目录与内核数据根统一。

    路径断言统一用 pathlib 构造期望值 —— 在 Windows 上 os.path.join("/tmp/x", "audit")
    会产生混合分隔符（"\\tmp\\x/audit"），不能用字符串字面量比较。
    """

    def test_audit_root_prefers_roveagent_root(self) -> None:
        from pathlib import Path

        from roveagent.enterprise.gate_hook import audit_root

        with mock.patch.dict(
            os.environ,
            {"ROVEAGENT_ROOT": "/tmp/rf-root", "ROVEAGENT_HOME": "/tmp/rf-home"},
            clear=False,
        ):
            self.assertEqual(audit_root(), Path("/tmp/rf-root") / "audit")

    def test_audit_root_falls_back_to_legacy_home(self) -> None:
        from pathlib import Path

        from roveagent.enterprise.gate_hook import audit_root

        env = {k: v for k, v in os.environ.items() if k != "ROVEAGENT_ROOT"}
        env["ROVEAGENT_HOME"] = "/tmp/rf-home"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(audit_root(), Path("/tmp/rf-home") / "audit")

    def test_audit_root_defaults_to_home(self) -> None:
        from pathlib import Path

        from roveagent.enterprise.gate_hook import audit_root

        env = {
            k: v for k, v in os.environ.items()
            if k not in ("ROVEAGENT_ROOT", "ROVEAGENT_HOME")
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(audit_root(), Path.home() / ".roveagent" / "audit")

    def test_default_sink_writes_under_roveagent_root(self) -> None:
        import json
        import tempfile
        from pathlib import Path

        from roveagent.enterprise.gate_hook import _default_audit_sink

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"ROVEAGENT_ROOT": tmp}, clear=False):
                _default_audit_sink({"tool": "read_file", "allowed": True})
            written = Path(tmp) / "audit" / "tool_gate.jsonl"
            self.assertTrue(written.exists(), "审计未写入 ROVEAGENT_ROOT/audit")
            self.assertEqual(
                json.loads(written.read_text(encoding="utf-8").strip())["tool"],
                "read_file",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
