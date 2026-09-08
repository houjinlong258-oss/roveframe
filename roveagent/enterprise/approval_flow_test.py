"""End-to-end contracts for the frozen, signed, single-use approval path."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import roveagent.api.app as app_module
from roveagent.clisupport.middleware import run_tool_execution_middleware
from roveagent.enterprise.gate_hook import install_enterprise_gate, uninstall_enterprise_gate
from roveagent.enterprise.run_context import bind_tool_context
from roveagent.tools.framework import ApprovalPolicy, RiskLevel, ToolContext, ToolPolicy
from roveagent.tools.registry import registry


class ApprovalFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.key = "approval-test-key"
        self.old_environment = dict(os.environ)
        os.environ["ROVEAGENT_ROOT"] = str(self.root)
        os.environ["ROVEAGENT_API_KEY"] = self.key
        os.environ["ROVEAGENT_APPROVAL_SECRET"] = self.key
        uninstall_enterprise_gate()
        install_enterprise_gate(
            policies=[ToolPolicy(
                "send_test", permission="comms:send", risk=RiskLevel.HIGH,
                approval=ApprovalPolicy.MANAGER, schema={"message": "str"},
                description="Send a test message", audit_category="communications",
            )],
            audit_sink=lambda _event: None,
        )
        self.executions: list[dict[str, object]] = []
        self.execution_lock = threading.Lock()

        def handler(args: dict[str, object]) -> str:
            with self.execution_lock:
                self.executions.append(dict(args))
            return json.dumps({"sent": True, "arguments": args}, sort_keys=True)

        registry.register(
            "send_test", "approval-test", {"type": "object"}, handler,
            description="test-only approved side effect", override=True,
        )
        app_module._ctx = SimpleNamespace(
            root=self.root,
            audit=lambda *_args, **_kwargs: None,
        )
        self.client = TestClient(app_module.create_app())

    def tearDown(self) -> None:
        self.client.close()
        registry.deregister("send_test")
        uninstall_enterprise_gate()
        app_module._ctx = None
        os.environ.clear()
        os.environ.update(self.old_environment)
        self.temporary.cleanup()

    def _capture_invocation(self, request_id: str) -> dict[str, object]:
        captured: list[dict[str, object]] = []
        context = ToolContext(
            tenant_id="tenant-a", business_id="business-a", user_id="user-a",
            role="manager", permissions=frozenset({"comms:send"}),
            request_id=request_id, task_id="task-a", agent_id="marketing-agent",
        )
        with patch(
            "roveagent.enterprise.approval_bridge.push_requires_approval",
            side_effect=lambda event: captured.append(dict(event)) or True,
        ):
            with bind_tool_context(context):
                blocked = run_tool_execution_middleware(
                    "send_test", {"message": "frozen"},
                    lambda _args: self.fail("high-risk tool executed before approval"),
                )
        self.assertTrue(json.loads(blocked)["requires_approval"])
        self.assertEqual(len(captured), 1)
        return captured[0]

    def _callback_body(
        self, event: dict[str, object], *, approved: bool = True,
        execution_id: str = "execution-a",
    ) -> str:
        payload = event["payload"]
        assert isinstance(payload, dict)
        args = payload["args"]
        canonical = json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        arguments_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return json.dumps({
            "tenant_id": event["tenant_id"],
            "business_id": event["business_id"],
            "tool": payload["tool"],
            "args": args,
            "approved": approved,
            "approver": "owner-a",
            "audit_event_id": payload["audit_event_id"],
            "invocation_id": payload["invocation_id"],
            "execution_id": execution_id if approved else "",
            "arguments_hash": arguments_hash,
            "user_id": payload["user_id"],
            "agent_id": payload["agent_id"],
            "role": payload["role"],
            "permissions": payload["permissions"],
            "request_id": payload["request_id"],
            "task_id": payload["task_id"],
        }, ensure_ascii=False, separators=(",", ":"))

    def _signed_headers(self, body: str, timestamp: int | None = None) -> dict[str, str]:
        timestamp_text = str(timestamp if timestamp is not None else int(time.time()))
        signature = hmac.new(
            self.key.encode(), f"{timestamp_text}.{body}".encode(), hashlib.sha256,
        ).hexdigest()
        return {
            "Content-Type": "application/json",
            "X-RoveAgent-Key": self.key,
            "X-RoveAgent-Timestamp": timestamp_text,
            "X-RoveAgent-Signature": signature,
        }

    def test_signed_callback_resumes_exact_arguments_once(self) -> None:
        event = self._capture_invocation("request-once")
        body = self._callback_body(event)
        first = self.client.post(
            "/api/agent/tool/resolve", content=body, headers=self._signed_headers(body),
        )
        second = self.client.post(
            "/api/agent/tool/resolve", content=body, headers=self._signed_headers(body),
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(self.executions, [{"message": "frozen"}])
        self.assertEqual(first.json()["execution_id"], "execution-a")
        self.assertEqual(second.json()["status"], "executed")

    def test_concurrent_duplicate_callbacks_execute_once(self) -> None:
        event = self._capture_invocation("request-race")
        body = self._callback_body(event, execution_id="execution-race")
        headers = self._signed_headers(body)
        with ThreadPoolExecutor(max_workers=8) as executor:
            responses = list(executor.map(
                lambda _index: self.client.post(
                    "/api/agent/tool/resolve", content=body, headers=headers,
                ),
                range(8),
            ))
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertEqual(self.executions, [{"message": "frozen"}])

    def test_reject_tamper_expiry_and_business_scope_never_execute(self) -> None:
        rejected_event = self._capture_invocation("request-reject")
        rejected_body = self._callback_body(rejected_event, approved=False)
        rejected = self.client.post(
            "/api/agent/tool/resolve", content=rejected_body,
            headers=self._signed_headers(rejected_body),
        )
        self.assertEqual(rejected.status_code, 200, rejected.text)

        tampered_event = self._capture_invocation("request-tamper")
        tampered_body = self._callback_body(tampered_event).replace("frozen", "mutated")
        tampered = self.client.post(
            "/api/agent/tool/resolve", content=tampered_body,
            headers=self._signed_headers(tampered_body),
        )
        self.assertEqual(tampered.status_code, 409, tampered.text)

        expired_event = self._capture_invocation("request-expired")
        expired_body = self._callback_body(expired_event)
        expired = self.client.post(
            "/api/agent/tool/resolve", content=expired_body,
            headers=self._signed_headers(expired_body, int(time.time()) - 301),
        )
        self.assertEqual(expired.status_code, 401, expired.text)

        scoped_event = self._capture_invocation("request-business")
        original_scoped_body = self._callback_body(scoped_event)
        scoped_body = original_scoped_body.replace("business-a", "business-b")
        scoped = self.client.post(
            "/api/agent/tool/resolve", content=scoped_body,
            headers=self._signed_headers(original_scoped_body),
        )
        self.assertEqual(scoped.status_code, 401, scoped.text)
        self.assertEqual(self.executions, [])

    def test_tool_metadata_and_schema_precede_context_and_permission(self) -> None:
        metadata = install_enterprise_gate(
            policies=[ToolPolicy(
                "send_test", permission="comms:send", risk=RiskLevel.HIGH,
                approval=ApprovalPolicy.MANAGER, schema={"message": "str"},
                description="Send a test message", audit_category="communications",
            )], audit_sink=lambda _event: None,
        ).metadata_for("send_test")
        self.assertEqual(set(metadata), {
            "name", "description", "input_schema", "required_permissions",
            "risk_level", "approval_policy", "audit_category",
        })
        decision = install_enterprise_gate(
            policies=[ToolPolicy(
                "send_test", permission="comms:send", risk=RiskLevel.HIGH,
                approval=ApprovalPolicy.MANAGER, schema={"message": "str"},
            )], audit_sink=lambda _event: None,
        ).authorize(ToolContext(), "send_test", {"message": 7})
        self.assertTrue(decision.reason.startswith("schema:"))


if __name__ == "__main__":
    unittest.main()
