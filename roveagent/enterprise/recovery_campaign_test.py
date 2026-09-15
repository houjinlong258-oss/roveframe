"""Recovery campaign: real gate freeze -> owner approval -> single execution."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import roveagent.api.app as app_module
from roveagent.clisupport.middleware import run_tool_execution_middleware
from roveagent.enterprise.gate_hook import install_enterprise_gate, uninstall_enterprise_gate
from roveagent.enterprise.run_context import bind_tool_context
from roveagent.tools.framework import RiskLevel, ToolContext
from roveagent.tools.registry import registry

# 注册真实业务工具（含 analyze_churn_customers / send_customer_recovery_campaign）
import roveagent.tools.business_data_tool  # noqa: F401


class RecoveryCampaignTest(unittest.TestCase):
    """Owner-approval chain for the first real high-value action."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.key = "recovery-test-key"
        # 与 approval_flow_test 同理：签名密钥必须独立于调用密钥，
        # 否则测试与被测代码会一起掩盖「持有 API key 即可签发审批」这一缺口。
        self.approval_secret = "recovery-test-approval-secret"
        self.old_environment = dict(os.environ)
        os.environ["ROVEAGENT_ROOT"] = str(self.root)
        os.environ["ROVEAGENT_API_KEY"] = self.key
        os.environ["ROVEAGENT_APPROVAL_SECRET"] = self.approval_secret
        os.environ["ROVEFRAME_INTERNAL_API_URL"] = "http://127.0.0.1:5000"
        uninstall_enterprise_gate()
        install_enterprise_gate(audit_sink=lambda _event: None)
        self.sent_calls: list[dict[str, object]] = []
        self.executions: list[str] = []
        app_module._ctx = SimpleNamespace(root=self.root, audit=lambda *_a, **_k: None)
        self.client = TestClient(app_module.create_app())

    def tearDown(self) -> None:
        self.client.close()
        uninstall_enterprise_gate()
        app_module._ctx = None
        os.environ.clear()
        os.environ.update(self.old_environment)
        self.temporary.cleanup()

    def _frozen_args(self) -> dict[str, object]:
        return {
            "campaign_title": "We miss you",
            "subject": "Welcome back",
            "body": "Hi {name}, come back!",
            "customer_ids": ["cust-1", "cust-2"],
            "language": "en",
        }

    def _adapter_patch(self, captured: list[dict[str, object]]):
        def fake_send(self, campaign_title: str, subject: str, body: str,
                      customer_ids: list[str], language: str = "en"):
            captured.append({
                "campaign_title": campaign_title, "subject": subject,
                "body": body, "customer_ids": list(customer_ids),
                "language": language,
            })
            return {"campaign_id": "camp-a", "queued": len(customer_ids), "status": "queued"}
        return patch.object(
            __import__("roveagent.business.data_layer", fromlist=["BusinessDataLayer"]).BusinessDataLayer,
            "send_recovery_campaign", fake_send,
        )

    def _capture_invocation(self, role: str, permissions: frozenset[str]):
        captured: list[dict[str, object]] = []
        context = ToolContext(
            tenant_id="tenant-a", business_id="business-a", user_id="user-a",
            role=role, permissions=permissions, request_id="req-a",
            task_id="task-a", agent_id="marketing-agent",
        )
        with patch(
            "roveagent.enterprise.approval_bridge.push_requires_approval",
            side_effect=lambda event: captured.append(dict(event)) or True,
        ):
            with bind_tool_context(context):
                blocked = run_tool_execution_middleware(
                    "send_customer_recovery_campaign", self._frozen_args(),
                    lambda _args: self.fail("campaign executed before approval"),
                )
        return blocked, captured

    def _signed_callback(self, event: dict[str, object], approved: bool = True) -> dict[str, str]:
        payload = event["payload"]
        assert isinstance(payload, dict)
        args = payload["args"]
        canonical = json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        arguments_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        body = json.dumps({
            "tenant_id": event["tenant_id"], "business_id": event["business_id"],
            "tool": payload["tool"], "args": args, "approved": approved,
            "approver": "owner-a", "audit_event_id": payload["audit_event_id"],
            "invocation_id": payload["invocation_id"],
            "execution_id": "exec-a" if approved else "",
            "arguments_hash": arguments_hash, "user_id": payload["user_id"],
            "agent_id": payload["agent_id"], "role": payload["role"],
            "permissions": payload["permissions"], "request_id": payload["request_id"],
            "task_id": payload["task_id"],
        }, ensure_ascii=False, separators=(",", ":"))
        timestamp = str(int(time.time()))
        signature = hmac.new(
            self.approval_secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256,
        ).hexdigest()
        return {
            "Content-Type": "application/json", "X-RoveAgent-Key": self.key,
            "X-RoveAgent-Timestamp": timestamp, "X-RoveAgent-Signature": signature,
        }

    def test_gate_policy_is_owner_approval(self) -> None:
        from roveagent.tools.framework import EnterpriseToolGate
        gate = EnterpriseToolGate(audit_sink=lambda _e: None)
        policy = gate.policy_for("send_customer_recovery_campaign")
        self.assertEqual(policy.approval, "owner")
        self.assertEqual(policy.risk, RiskLevel.HIGH)
        read_policy = gate.policy_for("analyze_churn_customers")
        self.assertEqual(read_policy.approval, "none")
        self.assertEqual(read_policy.risk, RiskLevel.LOW)

    def test_owner_role_requires_approval(self) -> None:
        blocked, captured = self._capture_invocation("owner", frozenset({"comms:send"}))
        payload = json.loads(blocked)
        self.assertTrue(payload.get("requires_approval"))
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["payload"]["tool"], "send_customer_recovery_campaign")

    def test_manager_without_permission_is_denied(self) -> None:
        blocked, captured = self._capture_invocation("manager", frozenset())
        self.assertIn("permission denied", json.loads(blocked).get("reason", ""))
        self.assertEqual(len(captured), 0)

    def test_approval_executes_exactly_once(self) -> None:
        blocked, captured = self._capture_invocation("owner", frozenset({"comms:send"}))
        self.assertTrue(json.loads(blocked)["requires_approval"])
        event = captured[0]
        adapter_calls: list[dict[str, object]] = []
        with self._adapter_patch(adapter_calls):
            headers = self._signed_callback(event, approved=True)
            body_text = json.dumps({
                "tenant_id": event["tenant_id"], "business_id": event["business_id"],
                "tool": event["payload"]["tool"], "args": event["payload"]["args"],
                "approved": True, "approver": "owner-a",
                "audit_event_id": event["payload"]["audit_event_id"],
                "invocation_id": event["payload"]["invocation_id"],
                "execution_id": "exec-a",
                "arguments_hash": hashlib.sha256(json.dumps(
                    event["payload"]["args"], sort_keys=True, ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")).hexdigest(),
                "user_id": event["payload"]["user_id"],
                "agent_id": event["payload"]["agent_id"],
                "role": event["payload"]["role"],
                "permissions": event["payload"]["permissions"],
                "request_id": event["payload"]["request_id"],
                "task_id": event["payload"]["task_id"],
            }, ensure_ascii=False, separators=(",", ":"))
            timestamp = str(int(time.time()))
            signature = hmac.new(
                self.approval_secret.encode(), f"{timestamp}.{body_text}".encode(), hashlib.sha256,
            ).hexdigest()
            headers = {
                "Content-Type": "application/json", "X-RoveAgent-Key": self.key,
                "X-RoveAgent-Timestamp": timestamp, "X-RoveAgent-Signature": signature,
            }
            first = self.client.post("/api/agent/tool/resolve", data=body_text, headers=headers)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(len(adapter_calls), 1)
            self.assertEqual(adapter_calls[0]["customer_ids"], ["cust-1", "cust-2"])
            # 重复回调不再执行（exactly-once）
            second = self.client.post("/api/agent/tool/resolve", data=body_text, headers=headers)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(len(adapter_calls), 1)
            self.assertIn("queued", second.json()["result"])

    def test_rejection_executes_nothing(self) -> None:
        _blocked, captured = self._capture_invocation("owner", frozenset({"comms:send"}))
        event = captured[0]
        adapter_calls: list[dict[str, object]] = []
        with self._adapter_patch(adapter_calls):
            payload = event["payload"]
            assert isinstance(payload, dict)
            args = payload["args"]
            canonical = json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            arguments_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            body_text = json.dumps({
                "tenant_id": event["tenant_id"], "business_id": event["business_id"],
                "tool": payload["tool"], "args": args, "approved": False,
                "approver": "owner-a", "audit_event_id": payload["audit_event_id"],
                "invocation_id": payload["invocation_id"], "execution_id": "",
                "arguments_hash": arguments_hash, "user_id": payload["user_id"],
                "agent_id": payload["agent_id"], "role": payload["role"],
                "permissions": payload["permissions"], "request_id": payload["request_id"],
                "task_id": payload["task_id"],
            }, ensure_ascii=False, separators=(",", ":"))
            timestamp = str(int(time.time()))
            signature = hmac.new(
                self.approval_secret.encode(), f"{timestamp}.{body_text}".encode(), hashlib.sha256,
            ).hexdigest()
            headers = {
                "Content-Type": "application/json", "X-RoveAgent-Key": self.key,
                "X-RoveAgent-Timestamp": timestamp, "X-RoveAgent-Signature": signature,
            }
            resp = self.client.post("/api/agent/tool/resolve", data=body_text, headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertFalse(resp.json()["approved"])
            self.assertEqual(len(adapter_calls), 0)

    def test_tampered_arguments_rejected(self) -> None:
        _blocked, captured = self._capture_invocation("owner", frozenset({"comms:send"}))
        event = captured[0]
        payload = event["payload"]
        assert isinstance(payload, dict)
        original_args = payload["args"]
        original_canonical = json.dumps(original_args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        arguments_hash = hashlib.sha256(original_canonical.encode("utf-8")).hexdigest()
        tampered = dict(original_args)
        tampered["customer_ids"] = ["evil-cust"]
        body_text = json.dumps({
            "tenant_id": event["tenant_id"], "business_id": event["business_id"],
            "tool": payload["tool"], "args": tampered, "approved": True,
            "approver": "owner-a", "audit_event_id": payload["audit_event_id"],
            "invocation_id": payload["invocation_id"], "execution_id": "exec-b",
            "arguments_hash": arguments_hash, "user_id": payload["user_id"],
            "agent_id": payload["agent_id"], "role": payload["role"],
            "permissions": payload["permissions"], "request_id": payload["request_id"],
            "task_id": payload["task_id"],
        }, ensure_ascii=False, separators=(",", ":"))
        timestamp = str(int(time.time()))
        signature = hmac.new(
            self.approval_secret.encode(), f"{timestamp}.{body_text}".encode(), hashlib.sha256,
        ).hexdigest()
        headers = {
            "Content-Type": "application/json", "X-RoveAgent-Key": self.key,
            "X-RoveAgent-Timestamp": timestamp, "X-RoveAgent-Signature": signature,
        }
        resp = self.client.post("/api/agent/tool/resolve", data=body_text, headers=headers)
        # 冻结参数哈希与原 invocation 记录不符 → 409
        self.assertEqual(resp.status_code, 409)


if __name__ == "__main__":
    unittest.main()
