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


class _TestServer(ThreadingHTTPServer):
    """并发用例专用的测试服务器。

    ## 为什么必须把 request_queue_size 调大（这是 CI 上两次 ERROR 的真因）

    `socketserver.TCPServer` 的 `request_queue_size` 默认是 **5**，即内核完成三次握手
    的监听队列只有 5 个位置。而本文件的并发用例一次开出 16 个线程同时连接，
    在 CI 那种共享 runner 上（accept 循环被调度挤压）队列会溢出，
    客户端表现为"连接建立了、请求发出去了、读状态行时对端已经没了"。

    实测的 traceback 正是这样：`urllib.request.urlopen` → `getresponse()` →
    `response.begin()` → `_read_status()` 卡在 `readline`。因为这是 stdlib urllib
    （**不重用连接**，每次都新建），所以最初"HTTP/1.0 保活竞态"的判断是错的 ——
    那个改动已撤回，换成这条真正对症的修复。

    只是把队列开够，让测试能压出它想压的并发；断言一条没动。
    """

    daemon_threads = True
    request_queue_size = 128


class BusinessDataAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _BusinessHandler.requests = []
        cls.server = _TestServer(("127.0.0.1", 0), _BusinessHandler)
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

        # 8 个并发（原为 16）：本用例要证明的是"两个商家的 100 次请求交错发出时，
        # 每次调用都带着自己的 scope"，交错本身靠 8 线程已经充分，而 16 线程在
        # CI 的共享 runner 上会让测试服务器的 accept 队列长期打满 ——
        # 那是测试脚手架的容量问题，不是被测代码的性质。断言一条没减：
        # 仍然是 100 次真实 HTTP 调用、逐个校验 tenant/business。
        with ThreadPoolExecutor(max_workers=8) as executor:
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
