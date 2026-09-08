"""Same-tenant, multi-business isolation contracts for durable Agent state."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from roveagent.api.tasks import TaskStore, new_task
from roveagent.enterprise.approval_grants import find_grant, record_grant
from roveagent.state.chat_sessions import ChatSessionStore
from roveagent.state.enterprise_memory import EnterpriseMemory, MemoryLayer


class DurableBusinessIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_memory_never_crosses_businesses_in_the_same_tenant(self) -> None:
        with EnterpriseMemory(self.root / "memory.db") as memory:
            memory.add(
                "store-a-private-fact", MemoryLayer.L2_TENANT,
                tenant_id="tenant-1", business_id="business-a",
            )
            memory.add(
                "store-b-private-fact", MemoryLayer.L2_TENANT,
                tenant_id="tenant-1", business_id="business-b",
            )

            store_a = memory.search(
                "", tenant_id="tenant-1", business_id="business-a",
            )
            store_b = memory.search(
                "", tenant_id="tenant-1", business_id="business-b",
            )

        self.assertEqual([item.content for item in store_a], ["store-a-private-fact"])
        self.assertEqual([item.content for item in store_b], ["store-b-private-fact"])

    def test_conversation_is_scoped_by_business_and_user(self) -> None:
        store = ChatSessionStore(self.root / "chat.db")
        try:
            store.append(
                "tenant-1", "business-a", "user-1", "same-session", "ceo",
                "user", "store-a-message",
            )
            store.append(
                "tenant-1", "business-b", "user-1", "same-session", "ceo",
                "user", "store-b-message",
            )
            store.append(
                "tenant-1", "business-a", "user-2", "same-session", "ceo",
                "user", "other-user-message",
            )

            self.assertEqual(
                store.history("tenant-1", "business-a", "user-1", "same-session"),
                [{"role": "user", "content": "store-a-message"}],
            )
            self.assertEqual(
                store.history("tenant-1", "business-b", "user-1", "same-session"),
                [{"role": "user", "content": "store-b-message"}],
            )
        finally:
            store.close()

    def test_tasks_and_approval_grants_are_business_bound(self) -> None:
        tasks = TaskStore(self.root)
        task = new_task("tenant-1", "business-a", "Private task")
        tasks.create(task)
        self.assertIsNotNone(tasks.get("tenant-1", "business-a", task.id))
        self.assertIsNone(tasks.get("tenant-1", "business-b", task.id))

        record_grant(
            tenant_id="tenant-1", business_id="business-a",
            tool="send_campaign", args={"campaign_id": "campaign-1"},
            approved=True, root=self.root, invocation_id="invocation-a",
            execution_id="execution-a", request_id="request-a",
        )
        self.assertIsNotNone(find_grant(
            "tenant-1", "business-a", "send_campaign",
            {"campaign_id": "campaign-1"}, root=self.root,
        ))
        self.assertIsNone(find_grant(
            "tenant-1", "business-b", "send_campaign",
            {"campaign_id": "campaign-1"}, root=self.root,
        ))


if __name__ == "__main__":
    unittest.main()
