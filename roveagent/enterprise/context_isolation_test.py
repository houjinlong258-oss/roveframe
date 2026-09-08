"""Concurrency contracts for the real RoveAgent tool middleware path."""

from __future__ import annotations

import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from roveagent.clisupport.middleware import run_tool_execution_middleware
from roveagent.enterprise.gate_hook import (
    install_enterprise_gate,
    uninstall_enterprise_gate,
)
from roveagent.enterprise.run_context import bind_tool_context, current_tool_context
from roveagent.tools.framework import ToolContext


class ToolContextIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        uninstall_enterprise_gate()
        self.audit_events: list[dict[str, object]] = []
        self.audit_lock = threading.Lock()

        def audit_sink(event: dict[str, object]) -> None:
            with self.audit_lock:
                self.audit_events.append(dict(event))

        install_enterprise_gate(audit_sink=audit_sink)

    def tearDown(self) -> None:
        uninstall_enterprise_gate()

    def test_missing_context_fails_closed_before_execution(self) -> None:
        executed = False

        def execute(_args: dict[str, object]) -> dict[str, bool]:
            nonlocal executed
            executed = True
            return {"executed": True}

        result = run_tool_execution_middleware(
            "read_sales",
            {"period": "week"},
            execute,
        )
        payload = json.loads(result)
        self.assertFalse(executed)
        self.assertFalse(payload["allowed"])
        self.assertIn("missing trusted tool context", payload["reason"])

    def test_two_businesses_remain_isolated_across_100_mixed_rounds(self) -> None:
        memory: dict[tuple[str, str], list[str]] = {}
        memory_lock = threading.Lock()

        def one_call(tenant: str, business: str, round_number: int) -> dict[str, str]:
            request_id = f"request-{tenant}-{round_number}"
            task_id = f"task-{tenant}-{round_number}"
            context = ToolContext(
                tenant_id=tenant,
                business_id=business,
                user_id=f"user-{tenant}",
                role="manager",
                permissions=frozenset({"orders:read"}),
                request_id=request_id,
                task_id=task_id,
                agent_id="operations",
            )

            def execute(_args: dict[str, object]) -> dict[str, str]:
                active = current_tool_context()
                if active is None:
                    raise AssertionError("tool executed without a bound context")
                marker = f"{active.request_id}:{active.task_id}"
                with memory_lock:
                    memory.setdefault((active.tenant_id, active.business_id), []).append(marker)
                return {
                    "tenant_id": active.tenant_id,
                    "business_id": active.business_id,
                    "user_id": active.user_id,
                    "request_id": active.request_id,
                    "task_id": active.task_id,
                }

            with bind_tool_context(context):
                result = run_tool_execution_middleware(
                    "read_sales",
                    {"period": "week"},
                    execute,
                )
            self.assertIsNone(current_tool_context())
            return result

        requests = [
            (tenant, business, round_number)
            for round_number in range(100)
            for tenant, business in (("tenant-a", "business-a"), ("tenant-b", "business-b"))
        ]
        with ThreadPoolExecutor(max_workers=16) as executor:
            results = list(executor.map(lambda item: one_call(*item), requests))

        self.assertEqual(len(results), 200)
        for result, (tenant, business, round_number) in zip(results, requests):
            self.assertEqual(result["tenant_id"], tenant)
            self.assertEqual(result["business_id"], business)
            self.assertEqual(result["user_id"], f"user-{tenant}")
            self.assertEqual(result["request_id"], f"request-{tenant}-{round_number}")
            self.assertEqual(result["task_id"], f"task-{tenant}-{round_number}")

        self.assertEqual(set(memory), {("tenant-a", "business-a"), ("tenant-b", "business-b")})
        self.assertEqual(len(memory[("tenant-a", "business-a")]), 100)
        self.assertEqual(len(memory[("tenant-b", "business-b")]), 100)
        self.assertTrue(all("tenant-a" in item for item in memory[("tenant-a", "business-a")]))
        self.assertTrue(all("tenant-b" in item for item in memory[("tenant-b", "business-b")]))

        allowed_events = [event for event in self.audit_events if event.get("allowed") is True]
        self.assertEqual(len(allowed_events), 200)
        for event in allowed_events:
            tenant = str(event["tenant_id"])
            suffix = tenant.removeprefix("tenant-")
            self.assertEqual(event["business_id"], f"business-{suffix}")
            self.assertEqual(event["user_id"], f"user-{tenant}")
            self.assertTrue(str(event["request_id"]).startswith(f"request-{tenant}-"))
            self.assertTrue(str(event["task_id"]).startswith(f"task-{tenant}-"))
            self.assertEqual(event["tool"], "read_sales")


if __name__ == "__main__":
    unittest.main()
