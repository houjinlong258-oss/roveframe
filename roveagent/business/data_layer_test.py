"""Contracts for the canonical RoveFrame business-data adapter."""

from __future__ import annotations

import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from roveagent.business.data_layer import BusinessDataError, BusinessDataLayer
from roveagent.clisupport.middleware import run_tool_execution_middleware
from roveagent.enterprise.gate_hook import install_enterprise_gate, uninstall_enterprise_gate
from roveagent.enterprise.run_context import bind_tool_context
from roveagent.tools.framework import ToolContext
from roveagent.tools.registry import registry
import roveagent.tools.business_data_tool  # noqa: F401  (register tools)


class _BusinessHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, object]] = []
    expected_key = "test-service-key"

    #: 必须显式声明 HTTP/1.1。
    #:
    #: `BaseHTTPRequestHandler` 默认是 HTTP/1.0，即**每个响应后关闭连接**。
    #: 而并发用例（16 线程 × 100 请求）里客户端会复用连接池中的连接：
    #: 服务端已经关了、客户端还在复用时就会抛
    #: `ConnectionResetError: [Errno 104] Connection reset by peer`。
    #: 实测：本地通过、CI（ubuntu runner）上稳定复现为 ERROR。
    #: 下面已经正确发送 Content-Length，因此 HTTP/1.1 的分帧是合法的，
    #: 开启后连接可以正常保活，竞态消失 —— 这是修测试的固有问题，
    #: 不是放宽断言。
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 (stdlib callback name)
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        self.__class__.requests.append({
            "path": self.path,
            "key": self.headers.get("x-roveagent-key", ""),
            "body": body,
        })
        operation = body["operation"]
        rows = [{"resource": operation, "tenant": body["tenant_id"],
                 "business": body["business_id"]}]
        if operation in {"read_sales", "read_business_profile", "read_snapshot"}:
            data: object = {
                "resource": operation,
                "revenue": 321.45,
                "tenant": body["tenant_id"],
                "business": body["business_id"],
            }
        else:
            data = rows
        encoded = json.dumps({
            "ok": True,
            "scope": {
                "tenant_id": body["tenant_id"],
                "business_id": body["business_id"],
            },
            "data": data,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class BusinessDataAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _BusinessHandler.requests = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _BusinessHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        _BusinessHandler.requests.clear()

    def test_all_business_fact_reads_carry_and_verify_scope(self) -> None:
        adapter = BusinessDataLayer(
            "tenant-a", "business-a",
            base_url=self.base_url,
            api_key=_BusinessHandler.expected_key,
        )
        results = [
            adapter.read_sales(), adapter.read_orders(), adapter.read_customers(),
            adapter.read_products(), adapter.read_inventory(), adapter.read_reviews(),
            adapter.read_payments(), adapter.read_business_profile(),
        ]
        self.assertEqual(len(results), 8)
        self.assertEqual(len(_BusinessHandler.requests), 8)
        self.assertEqual(
            {request["body"]["operation"] for request in _BusinessHandler.requests},
            {
                "read_sales", "read_orders", "read_customers", "read_products",
                "read_inventory", "read_reviews", "read_payments",
                "read_business_profile",
            },
        )
        for request in _BusinessHandler.requests:
            self.assertEqual(request["path"], "/api/internal/agent/business-data")
            self.assertEqual(request["key"], _BusinessHandler.expected_key)
            self.assertEqual(request["body"]["tenant_id"], "tenant-a")
            self.assertEqual(request["body"]["business_id"], "business-a")

    def test_adapter_rejects_a_mismatched_response_scope(self) -> None:
        def wrong_scope(_operation: str, _payload: object) -> dict[str, object]:
            return {
                "ok": True,
                "scope": {"tenant_id": "tenant-b", "business_id": "business-b"},
                "data": [],
            }

        adapter = BusinessDataLayer("tenant-a", "business-a", transport=wrong_scope)
        with self.assertRaisesRegex(BusinessDataError, "scope mismatch"):
            adapter.read_orders()

    def test_same_tenant_businesses_remain_isolated_over_real_http(self) -> None:
        adapters = {
            business: BusinessDataLayer(
                "tenant-shared", business, base_url=self.base_url,
                api_key=_BusinessHandler.expected_key,
            )
            for business in ("business-a", "business-b")
        }
        expected = ["business-a" if i % 2 == 0 else "business-b" for i in range(100)]

        with ThreadPoolExecutor(max_workers=16) as executor:
            results = list(executor.map(
                lambda business: adapters[business].read_sales(), expected,
            ))

        for business, result in zip(expected, results):
            self.assertEqual(result["tenant"], "tenant-shared")
            self.assertEqual(result["business"], business)
        self.assertEqual(len(_BusinessHandler.requests), 100)
        self.assertEqual(
            {request["body"]["business_id"] for request in _BusinessHandler.requests},
            {"business-a", "business-b"},
        )

    def test_real_tool_middleware_gates_then_dispatches_scoped_adapter(self) -> None:
        uninstall_enterprise_gate()
        audit_events: list[dict[str, object]] = []
        install_enterprise_gate(audit_sink=lambda event: audit_events.append(dict(event)))
        context = ToolContext(
            tenant_id="tenant-a", business_id="business-a", user_id="user-a",
            role="manager", permissions=frozenset({"orders:read"}),
            request_id="request-a", task_id="task-a", agent_id="operations",
        )
        with patch.dict(os.environ, {
            "ROVEFRAME_INTERNAL_API_URL": self.base_url,
            "ROVEAGENT_API_KEY": _BusinessHandler.expected_key,
        }, clear=False):
            with bind_tool_context(context):
                result = run_tool_execution_middleware(
                    "read_sales",
                    {"period": "week"},
                    lambda args: registry.dispatch("read_sales", args),
                )
        uninstall_enterprise_gate()
        self.assertEqual(json.loads(result)["revenue"], 321.45)
        self.assertEqual(_BusinessHandler.requests[0]["body"]["tenant_id"], "tenant-a")
        self.assertEqual(_BusinessHandler.requests[0]["body"]["business_id"], "business-a")
        self.assertEqual(audit_events[-1]["tool"], "read_sales")
        self.assertTrue(audit_events[-1]["allowed"])


if __name__ == "__main__":
    unittest.main()
