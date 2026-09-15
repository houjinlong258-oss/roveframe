"""Step 1.75 验证：Agent → Toolset 映射。

覆盖用户的 6 项验收测试 + 安全回归。

运行::

    python -m pytest roveagent/api/toolsets_test.py -v
"""
from __future__ import annotations

import unittest

from roveagent.api.toolsets import (
    CLIENT_IGNORED_FIELDS,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_TOOLSETS,
    MAX_ITERATIONS_CEILING,
    _AGENT_RUNTIME,
    describe_runtime,
    resolve_max_iterations,
    resolve_toolsets,
)
from roveagent.tools.framework import ApprovalPolicy, EnterpriseToolGate, RiskLevel
from roveagent.toolsets import TOOLSETS


class ToolsetNameValidityTest(unittest.TestCase):
    """映射表里出现的每个 toolset 名必须在 toolsets.py 真实存在。

    这条测试是**为了防止一类静默失败**：``process`` 曾被误当作 toolset 名
    （实际 registry 里 ``process`` 属于 ``terminal`` 工具集）。写错的名字
    不会报错，只会让工具悄悄不出现。
    """

    def test_all_mapped_toolsets_exist(self) -> None:
        names: set[str] = set()
        for toolsets, _ in _AGENT_RUNTIME.values():
            names.update(toolsets)
        names.update(DEFAULT_TOOLSETS)
        for name in sorted(names):
            with self.subTest(toolset=name):
                self.assertIn(
                    name, TOOLSETS,
                    f"toolset {name!r} 不在 toolsets.py 中 —— 会被静默忽略",
                )

    def test_process_is_not_a_toolset_name(self) -> None:
        """锁定事实：process 属于 terminal 工具集，不存在独立 process toolset。"""
        self.assertNotIn("process", TOOLSETS)


class ResolverMappingTest(unittest.TestCase):
    """测试 1 / 5：按 agent 解析出的 toolset。"""

    def test_1_developer_gets_file_toolset(self) -> None:
        resolved = resolve_toolsets("developer")
        self.assertIn("file", resolved)
        self.assertIn("terminal", resolved)
        self.assertIn("todo", resolved)

    def test_1b_developer_read_file_is_reachable(self) -> None:
        """file 工具集一旦授予，read_file 才可能被递到模型面前。

        注意：工具注册在**模块 import 时**发生（内核里由工具发现流程完成）。
        因此这里显式 import 一次 file_tools，否则 registry 是空的。
        """
        import roveagent.tools.file_tools  # noqa: F401  触发注册
        from roveagent.tools.registry import registry

        self.assertIn("file", resolve_toolsets("developer"))
        self.assertEqual(registry.get_toolset_for_tool("read_file"), "file")

    def test_5_ceo_has_no_file_or_terminal(self) -> None:
        for agent in ("ceo", "operations", "marketing"):
            with self.subTest(agent=agent):
                resolved = resolve_toolsets(agent)
                self.assertNotIn("file", resolved)
                self.assertNotIn("terminal", resolved)
                self.assertNotIn("process", resolved)

    def test_devops_gets_terminal_but_not_file(self) -> None:
        resolved = resolve_toolsets("devops")
        self.assertIn("terminal", resolved)
        self.assertNotIn("file", resolved)

    def test_unknown_agent_fails_closed(self) -> None:
        for agent in ("unknown", "", "  ", "root", "../devops", "DEVELOPER "):
            with self.subTest(agent=agent):
                resolved = resolve_toolsets(agent)
                # 大小写与空白不敏感；未知 agent 必须是默认只读集合
                if agent.strip().lower() in _AGENT_RUNTIME:
                    continue
                self.assertEqual(resolved, DEFAULT_TOOLSETS)

    def test_case_and_whitespace_insensitive(self) -> None:
        self.assertEqual(resolve_toolsets("  Developer "), resolve_toolsets("developer"))


class BudgetTest(unittest.TestCase):
    """迭代预算映射。"""

    def test_budget_by_agent(self) -> None:
        self.assertEqual(resolve_max_iterations("ceo"), 8)
        self.assertEqual(resolve_max_iterations("operations"), 8)
        self.assertEqual(resolve_max_iterations("developer"), 16)
        self.assertEqual(resolve_max_iterations("devops"), 16)

    def test_unknown_agent_gets_default_budget(self) -> None:
        self.assertEqual(resolve_max_iterations("nobody"), DEFAULT_MAX_ITERATIONS)

    def test_budget_never_exceeds_ceiling(self) -> None:
        for agent in _AGENT_RUNTIME:
            with self.subTest(agent=agent):
                self.assertLessEqual(
                    resolve_max_iterations(agent), MAX_ITERATIONS_CEILING,
                )


class ClientAuthorityTest(unittest.TestCase):
    """测试 6：客户端不能指定 toolset。"""

    def test_6_chat_request_has_no_toolset_field(self) -> None:
        """ChatRequest 不得定义任何客户端可控的工具/预算字段。"""
        from roveagent.api.app import ChatRequest

        fields = set(ChatRequest.model_fields.keys())
        leaked = fields & CLIENT_IGNORED_FIELDS
        self.assertEqual(
            leaked, set(),
            f"ChatRequest 暴露了不应由客户端控制的字段：{sorted(leaked)}",
        )

    def test_6b_resolver_ignores_any_extra_argument(self) -> None:
        """resolver 只接受 agent key —— 多传客户端值不会改变结果。"""
        baseline = resolve_toolsets("developer")
        # 即使调用方手滑把客户端提供的 toolset 传进来，签名也不接受
        with self.assertRaises(TypeError):
            resolve_toolsets("developer", ("safe",))  # type: ignore[call-arg]
        self.assertEqual(resolve_toolsets("developer"), baseline)

    def test_6c_unknown_agent_cannot_escalate_via_request_field(self) -> None:
        """未知 agent 不会因为任何请求字段而拿到 file/terminal。"""
        resolved = resolve_toolsets("totally-unknown")
        self.assertNotIn("file", resolved)
        self.assertNotIn("terminal", resolved)

    def test_describe_runtime_reports_known_flag(self) -> None:
        self.assertTrue(describe_runtime("developer")["known"])
        self.assertFalse(describe_runtime("nobody")["known"])


class PermissionInteractionTest(unittest.TestCase):
    """测试 3 / 4：toolset 授权不改变门控权限判定（两层是「与」关系）。"""

    def setUp(self) -> None:
        self.gate = EnterpriseToolGate()

    def test_3_read_file_permission_unchanged(self) -> None:
        """Step 1.5 的修复不得被 Step 1.75 回退。"""
        policy = self.gate.policy_for("read_file")
        self.assertEqual(policy.permission, "files:read")
        self.assertEqual(policy.approval, ApprovalPolicy.NONE)

    def test_4_write_file_requires_high_risk_manager_approval(self) -> None:
        """Phase 9：write_file 升为 HIGH —— 任何角色都不得自动跳过审批。"""
        policy = self.gate.policy_for("write_file")
        self.assertEqual(policy.permission, "files:write")
        self.assertEqual(policy.risk, RiskLevel.HIGH)
        self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

    def test_4b_patch_still_requires_manager(self) -> None:
        policy = self.gate.policy_for("patch")
        self.assertEqual(policy.approval, ApprovalPolicy.MANAGER)

    def test_toolset_grant_does_not_bypass_gate(self) -> None:
        """拿到 file 工具集 ≠ 能写文件：写仍需 files:write 且不可免审批直执。"""
        from roveagent.tools.framework import ToolContext

        self.assertIn("file", resolve_toolsets("developer"))
        ctx = ToolContext(
            tenant_id="t", business_id="b", user_id="u", role="owner",
            permissions=frozenset({"files:read"}),  # 只有读权限
            request_id="r", task_id="k", agent_id="developer",
        )
        decision = self.gate.authorize(ctx, "write_file", {"path": "x", "content": "y"})
        self.assertFalse(decision.allowed, "仅有 files:read 不得写入")


if __name__ == "__main__":
    unittest.main(verbosity=2)
