"""P0 安全边界测试：Python RoveAgent 记忆隔离（SECURITY_FIX_PLAN.md S3）。

覆盖场景矩阵：
- same tenant / different business：L2/L4 与 built-in 记忆目录双维度隔离
- same user / different user（同业务不同会话）：L4 会话记忆互不可见
- unauthorized tool call：缺权限拒绝、OWNER 审批策略不直执、缺上下文 fail-closed
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from roveagent.enterprise.run_context import bind_tool_context
from roveagent.state.enterprise_memory import EnterpriseMemory, MemoryLayer
from roveagent.tools import memory_tool
from roveagent.tools.framework import EnterpriseToolGate, ToolContext


def _context(tenant: str, business: str, role: str = "owner",
             permissions: frozenset[str] | None = None) -> ToolContext:
    return ToolContext(
        tenant_id=tenant,
        business_id=business,
        user_id=f"user-{tenant}",
        role=role,
        permissions=permissions if permissions is not None else frozenset({"*"}),
        request_id=f"request-{tenant}",
        task_id=f"task-{tenant}",
        agent_id="ceo",
    )


class EnterpriseMemoryL4IsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="roveframe-mem-")
        self.memory = EnterpriseMemory(os.path.join(self.tmp, "enterprise_memory.db"))

    def tearDown(self) -> None:
        self.memory.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_l4_never_crosses_sessions_in_the_same_business(self) -> None:
        """same user / different user（同业务不同会话）：L4 只回本会话。"""
        self.memory.add(
            "会话 A 私密讨论：退款 200 美元", MemoryLayer.L4_SESSION,
            tenant_id="tenant-a", business_id="business-a",
            session_id="session-a", kind="episode",
        )
        self.memory.add(
            "会话 B 私密讨论：裁员计划", MemoryLayer.L4_SESSION,
            tenant_id="tenant-a", business_id="business-a",
            session_id="session-b", kind="episode",
        )
        hits_b = self.memory.search(
            "私密讨论", tenant_id="tenant-a", business_id="business-a",
            session_id="session-b",
        )
        self.assertEqual(len(hits_b), 1)
        self.assertTrue(any("裁员计划" in h.content for h in hits_b))
        self.assertTrue(all("退款 200 美元" not in h.content for h in hits_b))

        hits_a = self.memory.search(
            "私密讨论", tenant_id="tenant-a", business_id="business-a",
            session_id="session-a",
        )
        self.assertEqual(len(hits_a), 1)
        self.assertTrue(any("退款 200 美元" in h.content for h in hits_a))
        self.assertTrue(all("裁员计划" not in h.content for h in hits_a))

    def test_l4_excluded_when_caller_has_no_session(self) -> None:
        """未提供 session_id 的检索不得注入任何 L4 记录。"""
        self.memory.add(
            "会话 X 私密内容", MemoryLayer.L4_SESSION,
            tenant_id="tenant-a", business_id="business-a", session_id="session-x",
        )
        self.memory.add(
            "业务级公开事实", MemoryLayer.L2_TENANT,
            tenant_id="tenant-a", business_id="business-a",
        )
        hits = self.memory.search(
            "私密", tenant_id="tenant-a", business_id="business-a",
        )
        self.assertEqual([h.content for h in hits], [])
        hits2 = self.memory.search(
            "公开事实", tenant_id="tenant-a", business_id="business-a",
        )
        self.assertEqual(len(hits2), 1)

    def test_same_tenant_different_businesses_l2_and_l4_isolated(self) -> None:
        """same tenant / different business：L2/L4 均不可跨业务读取。"""
        self.memory.add(
            "business-a 经营机密：新菜成本", MemoryLayer.L2_TENANT,
            tenant_id="tenant-shared", business_id="business-a",
        )
        self.memory.add(
            "business-a 会话机密", MemoryLayer.L4_SESSION,
            tenant_id="tenant-shared", business_id="business-a", session_id="s-a",
        )
        hits = self.memory.search(
            "机密", tenant_id="tenant-shared", business_id="business-b",
            session_id="s-a",
        )
        self.assertEqual(hits, [])
        self.assertEqual(
            self.memory.count("tenant-shared", "business-b"), 0,
        )
        self.assertEqual(
            self.memory.count("tenant-shared", "business-a"), 2,
        )

    def test_search_requires_tenant_and_business(self) -> None:
        with self.assertRaises(ValueError):
            self.memory.search("x", tenant_id="", business_id="b")
        with self.assertRaises(ValueError):
            self.memory.search("x", tenant_id="t", business_id="")


class MemoryToolTenantScopingTest(unittest.TestCase):
    """built-in 记忆工具（MEMORY.md/USER.md）在绑定 ToolContext 时按租户×业务隔离。"""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="roveframe-memdir-")
        self.old_home = os.environ.get("ROVEAGENT_HOME")
        os.environ["ROVEAGENT_HOME"] = self.tmp

    def tearDown(self) -> None:
        if self.old_home is None:
            os.environ.pop("ROVEAGENT_HOME", None)
        else:
            os.environ["ROVEAGENT_HOME"] = self.old_home
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unbound_context_keeps_profile_dir(self) -> None:
        directory = memory_tool.get_memory_dir()
        self.assertEqual(directory, Path(self.tmp) / "memories")

    def test_bound_context_scopes_per_tenant_and_business(self) -> None:
        with bind_tool_context(_context("tenant-a", "business-a")):
            dir_a = memory_tool.get_memory_dir()
        with bind_tool_context(_context("tenant-a", "business-b")):
            dir_b = memory_tool.get_memory_dir()
        self.assertEqual(
            dir_a, Path(self.tmp) / "memories" / "enterprise" / "tenant-a" / "business-a",
        )
        self.assertEqual(
            dir_b, Path(self.tmp) / "memories" / "enterprise" / "tenant-a" / "business-b",
        )
        self.assertNotEqual(dir_a, dir_b)

    def test_traversal_chars_sanitized(self) -> None:
        with bind_tool_context(_context("../../etc", "a/../b")):
            directory = memory_tool.get_memory_dir()
        self.assertNotIn("..", directory.parts)
        self.assertTrue(
            str(directory).startswith(str(Path(self.tmp) / "memories" / "enterprise")),
        )

    def test_memory_store_writes_stay_isolated_between_businesses(self) -> None:
        store_a = memory_tool.MemoryStore()
        with bind_tool_context(_context("tenant-a", "business-a")):
            store_a.add("memory", "business A 的私有记忆")
        store_b = memory_tool.MemoryStore()
        with bind_tool_context(_context("tenant-a", "business-b")):
            store_b.add("memory", "business B 的私有记忆")

        file_a = Path(self.tmp) / "memories" / "enterprise" / "tenant-a" / "business-a" / "MEMORY.md"
        file_b = Path(self.tmp) / "memories" / "enterprise" / "tenant-a" / "business-b" / "MEMORY.md"
        self.assertTrue(file_a.exists())
        self.assertTrue(file_b.exists())
        content_a = file_a.read_text(encoding="utf-8")
        content_b = file_b.read_text(encoding="utf-8")
        self.assertIn("business A 的私有记忆", content_a)
        self.assertNotIn("business B 的私有记忆", content_a)
        self.assertIn("business B 的私有记忆", content_b)
        self.assertNotIn("business A 的私有记忆", content_b)
        # 未绑定上下文的全局目录没有被企业会话污染
        global_memory = Path(self.tmp) / "memories" / "MEMORY.md"
        if global_memory.exists():
            self.assertNotIn("私有记忆", global_memory.read_text(encoding="utf-8"))


class EnterpriseGateAuthorizationTest(unittest.TestCase):
    """EnterpriseToolGate：未授权工具调用 / 审批绕过防线（保留门控本体，锁定其判定）。"""

    def setUp(self) -> None:
        self.audit_events: list[dict[str, object]] = []
        self.gate = EnterpriseToolGate(audit_sink=self.audit_events.append)

    def test_tool_requiring_permission_denied_without_permission(self) -> None:
        ctx = _context("tenant-a", "business-a", role="staff", permissions=frozenset())
        decision = self.gate.authorize(ctx, "read_sales", {"period": "week"})
        self.assertFalse(decision.allowed)
        self.assertFalse(decision.requires_approval)
        self.assertIn("permission denied", decision.reason)

    def test_refund_requires_owner_approval_and_is_not_executed_directly(self) -> None:
        ctx = _context("tenant-a", "business-a", role="owner",
                       permissions=frozenset({"payments:refund"}))
        decision = self.gate.authorize(
            ctx, "refund_payment", {"payment_id": "p1", "amount_minor": 100},
        )
        self.assertFalse(decision.allowed)
        self.assertTrue(decision.requires_approval)
        self.assertEqual(decision.approval_policy, "owner")
        self.assertIn("approval required", decision.reason)

    def test_missing_context_fails_closed(self) -> None:
        decision = self.gate.authorize(ToolContext(), "read_sales", {})
        self.assertFalse(decision.allowed)
        self.assertIn("missing trusted tool context", decision.reason)

    def test_audit_events_carry_tenant_and_business_scope(self) -> None:
        ctx = _context("tenant-x", "business-x", permissions=frozenset({"orders:read"}))
        self.gate.authorize(ctx, "read_sales", {"period": "week"})
        self.assertEqual(len(self.audit_events), 1)
        self.assertEqual(self.audit_events[0]["tenant_id"], "tenant-x")
        self.assertEqual(self.audit_events[0]["business_id"], "business-x")


if __name__ == "__main__":
    unittest.main()
