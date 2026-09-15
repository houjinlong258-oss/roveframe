"""P0-11：门控链 fail-open 治理测试。

覆盖：
- 未登记工具必须拒绝（兜底策略不再免审批直执）；
- 已注册工具兜底策略保持原语义；
- 安全中间件（fail_closed 标记）异常 → 执行链终止，真实工具不执行；
- 普通中间件异常 → 保持既有跳过语义；
- 写文件类工具升级为经理审批；
- 权限由服务端推导（客户端只能裁剪不能放大）。
"""
from __future__ import annotations

import json
import unittest

from roveagent.api.permissions import derive_permissions
from roveagent.clisupport.middleware import _run_execution_chain
from roveagent.tools.framework import EnterpriseToolGate, ToolContext, ToolPolicy
from roveagent.tools.registry import registry


def _register_tool(name: str) -> None:
    registry.register(
        name=name,
        toolset="test",
        schema={"name": name, "description": "test tool", "parameters": {"type": "object", "properties": {}}},
        handler=lambda args, **kw: "ok",
    )


class GateFailClosedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.gate = EnterpriseToolGate(audit_sink=lambda _event: None)
        self.ctx = ToolContext(
            tenant_id="t-1", business_id="b-1", user_id="u-1", role="owner",
            permissions=frozenset({"*"}), request_id="r1", task_id="t1",
        )

    def test_unknown_tool_is_denied(self) -> None:
        decision = self.gate.authorize(self.ctx, "definitely_not_registered_xyz", {})
        self.assertFalse(decision.allowed)
        self.assertIn("not registered", decision.reason)

    def test_registered_tool_without_explicit_policy_is_denied(self) -> None:
        """Phase 9：default deny。

        旧契约（本用例原名 test_registered_fallback_tool_stays_allowed）：
        已注册工具即使没有显式策略行，命中兜底也放行。
        实测后果：101 个已注册工具中 82 个落在这条路径上，等于「已注册 = 免权限、
        免审批直执」，其中含 execute_code / computer_use / browser_exec /
        browser_cdp / setup_mcp。新契约：未显式登记的工具一律拒绝。
        """
        _register_tool("some_runtime_tool_xyz")
        decision = self.gate.authorize(self.ctx, "some_runtime_tool_xyz", {})
        self.assertFalse(decision.allowed, "无显式策略行的已注册工具必须被拒绝")
        self.assertIn("no explicit policy row", decision.reason)
        registry.deregister("some_runtime_tool_xyz")

    def test_explicit_policy_tools_need_no_registry_lookup(self) -> None:
        # read_sales 有显式策略；即使未注册也不走兜底拒绝逻辑
        decision = self.gate.authorize(self.ctx, "read_sales", {"period": "week"})
        self.assertTrue(decision.allowed, decision.reason)

    def test_write_file_requires_manager_approval(self) -> None:
        """Phase 9：write_file 已升为 HIGH 风险 → 任何角色都不得自动跳过审批。

        旧契约：经理直执需审批，业主凭层级语义免审批。
        新契约：HIGH/CRITICAL 一律产生审批单，owner 也不能自行放行。
        """
        policy = self.gate.policy_for("write_file")
        self.assertEqual(policy.approval, "manager")
        self.assertEqual(policy.risk.name, "HIGH")
        manager_ctx = ToolContext(
            tenant_id="t-1", business_id="b-1", user_id="u-1", role="manager",
            permissions=frozenset({"files:write"}), request_id="r1", task_id="t1",
        )
        decision = self.gate.authorize(manager_ctx, "write_file", {})
        self.assertTrue(decision.requires_approval)
        self.assertFalse(decision.allowed)
        owner_decision = self.gate.authorize(self.ctx, "write_file", {})
        self.assertTrue(
            owner_decision.requires_approval,
            "HIGH 风险动作必须对 owner 也生成审批单",
        )
        self.assertFalse(owner_decision.allowed)

    def test_security_middleware_crash_terminates_chain(self) -> None:
        def security_mw(**kwargs):
            raise RuntimeError("gate exploded")

        security_mw.fail_closed = True  # type: ignore[attr-defined]
        executed = []

        def terminal(args):
            executed.append(args)
            return "EXECUTED"

        result = _run_execution_chain(
            "tool_execution", [security_mw], terminal,
            tool_name="read_sales", args={"period": "week"},
        )
        self.assertIn("enterprise_gate_unavailable", str(result))
        self.assertEqual(executed, [], "真实工具不得被执行")

    def test_plain_middleware_crash_still_skips(self) -> None:
        # 无 fail_closed 标记的普通中间件保持既有跳过语义
        def plain_mw(**kwargs):
            raise RuntimeError("observer boom")

        executed = []

        def terminal(args):
            executed.append(args)
            return "EXECUTED"

        result = _run_execution_chain(
            "tool_execution", [plain_mw], terminal,
            tool_name="read_sales", args={"period": "week"},
        )
        self.assertEqual(result, "EXECUTED")
        self.assertEqual(len(executed), 1)

    def test_gate_middleware_carries_fail_closed_marker(self) -> None:
        from roveagent.enterprise.gate_hook import enterprise_gate_middleware
        self.assertTrue(getattr(enterprise_gate_middleware, "fail_closed", False))


class PermissionDerivationTest(unittest.TestCase):
    def test_owner_keeps_requested(self) -> None:
        granted = derive_permissions("owner", ["anything:at_all", "*"], [])
        self.assertEqual(granted, frozenset({"anything:at_all", "*"}))

    def test_staff_is_clamped(self) -> None:
        granted = derive_permissions(
            "staff", ["orders:read", "payments:write", "emails:read"], [])
        self.assertEqual(granted, frozenset({"orders:read"}))
        self.assertNotIn("payments:write", granted)

    def test_unknown_role_is_empty(self) -> None:
        self.assertEqual(derive_permissions("hacker", ["*"], []), frozenset())

    def test_employee_permissions_are_merged(self) -> None:
        granted = derive_permissions(
            "staff", ["orders:read"], ["analytics:read"])
        self.assertEqual(granted, frozenset({"orders:read", "analytics:read"}))


if __name__ == "__main__":
    unittest.main()
