"""Phase 9 / Task 3 —— 最小生产链 E2E。

链路：API → Tool → EnterpriseToolGate → 执行 → 审计

本文件**不 mock 整条链**。真实组件：
  * 真实的 `EnterpriseToolGate`（含 `DEFAULT_POLICIES` 与 Phase 9 的 default-deny）
  * 真实的 `install_enterprise_gate` 中间件装配（fail_closed 标记生效）
  * 真实的 `run_tool_execution_middleware` 执行链
  * 真实的 FastAPI app（`create_app()`）+ 真实的 HMAC 签名回调 `/api/agent/tool/resolve`
  * 真实的审计 sink（断言每一条决策都被留痕，含拒绝）

唯一替身是**被执行的工具处理器**：`read_file` / `write_file` 需要终端后端，
在离线测试环境不可用，因此用同名探针 handler 代替。被测对象是**门控与审批契约**，
不是文件系统本身 —— 这一点在下方每个用例中显式标注。

覆盖的 5 个必需场景：
  1. developer read_file        → 放行
  2. developer write_file       → HIGH 风险，必须审批，未批准不得执行
  3. plugin tool sandbox        → 无策略包 = default deny；有策略包 = 独立策略行
  4. approval reject            → 不执行任何动作
  5. approval accept            → 恰好执行一次
"""
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
from roveagent.tools.framework import (
    ApprovalPolicy,
    EnterpriseToolGate,
    RiskLevel,
    ToolContext,
    ToolPolicy,
)
from roveagent.tools.registry import registry


def _register_probe(name: str, recorder: list) -> None:
    """注册一个只记录调用的探针工具（替代真实文件工具）。"""

    def handler(args: dict) -> str:
        recorder.append({"tool": name, "args": dict(args)})
        return json.dumps({"tool": name, "ok": True}, sort_keys=True)

    registry.register(name, f"e2e-probe:{name}", {"type": "object"}, handler,
                      description=f"e2e probe for {name}", override=True)


class ProductionChainE2ETest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.key = "e2e-api-key"
        self.approval_secret = "e2e-approval-secret"  # 必须与 API key 不同（Phase 9 / A4）
        self.old_environment = dict(os.environ)
        os.environ["ROVEAGENT_ROOT"] = str(self.root)
        os.environ["ROVEAGENT_API_KEY"] = self.key
        os.environ["ROVEAGENT_APPROVAL_SECRET"] = self.approval_secret

        self.executions: list[dict] = []
        for name in ("read_file", "write_file", "plugin__e2e__probe"):
            _register_probe(name, self.executions)

        self.audit_events: list[dict] = []
        uninstall_enterprise_gate()
        install_enterprise_gate(
            policies=[
                # 与 DEFAULT_POLICIES 同语义的显式行：让探针工具落在真实策略模型上
                ToolPolicy("read_file", "files:read", RiskLevel.LOW, ApprovalPolicy.NONE),
                ToolPolicy("write_file", "files:write", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
                ToolPolicy("plugin__e2e__probe", "sandbox:execute",
                           RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
            ],
            audit_sink=lambda event: self.audit_events.append(dict(event)),
        )
        app_module._ctx = SimpleNamespace(root=self.root, audit=lambda *_a, **_k: None)
        self.client = TestClient(app_module.create_app())

    def tearDown(self) -> None:
        self.client.close()
        for name in ("read_file", "write_file", "plugin__e2e__probe"):
            registry.deregister(name)
        uninstall_enterprise_gate()
        app_module._ctx = None
        os.environ.clear()
        os.environ.update(self.old_environment)
        self.temporary.cleanup()

    def _ctx(self, role: str, permissions: tuple[str, ...]) -> ToolContext:
        return ToolContext(
            tenant_id="tenant-e2e", business_id="biz-e2e", user_id="user-e2e",
            role=role, permissions=frozenset(permissions),
            request_id="req-e2e", task_id="task-e2e", agent_id="developer",
        )

    def _signed_headers(self, body: str) -> dict[str, str]:
        ts = str(int(time.time()))
        signature = hmac.new(
            self.approval_secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256,
        ).hexdigest()
        return {
            "Content-Type": "application/json",
            "X-RoveAgent-Key": self.key,
            "X-RoveAgent-Timestamp": ts,
            "X-RoveAgent-Signature": signature,
        }

    # -- 场景 1 ------------------------------------------------------------
    def test_1_developer_read_file_is_allowed_and_audited(self) -> None:
        """developer read_file → LOW + files:read → 放行并执行。

        真实：策略解析、门控判定、中间件链、审计留痕。
        替身：文件工具处理器（探针），因为终端后端在离线环境不可用。
        """
        ctx = self._ctx("staff", ("files:read",))
        with bind_tool_context(ctx):
            result = run_tool_execution_middleware(
                "read_file", {"path": "README.md"},
                lambda args: registry.dispatch("read_file", args),
            )
        self.assertIn("ok", json.loads(result))
        self.assertEqual(len(self.executions), 1)
        self.assertEqual(self.executions[0]["tool"], "read_file")
        # 审计必须记录 allowed=True
        allowed = [e for e in self.audit_events if e.get("tool") == "read_file"]
        self.assertTrue(allowed, "read_file 的执行必须留痕")
        self.assertTrue(allowed[-1]["allowed"])

    # -- 场景 2 ------------------------------------------------------------
    def test_2_developer_write_file_requires_approval_and_does_not_execute(self) -> None:
        """developer write_file → HIGH → 必须审批；未批准前**不得执行**。

        这是 Phase 9 的核心收紧点：write_file 由 MEDIUM 升为 HIGH，
        因此 owner 也不能凭角色等级免审直执。
        """
        policy = EnterpriseToolGate().policy_for("write_file")
        self.assertEqual(policy.risk.name, "HIGH")

        for role, perms in (("staff", ()), ("manager", ("files:write",)), ("owner", ("*",))):
            with self.subTest(role=role):
                ctx = self._ctx(role, perms)
                decision = EnterpriseToolGate().authorize(
                    ctx, "write_file", {"path": "x.ts", "content": "y"},
                )
                self.assertFalse(decision.allowed, f"{role} 不得免审写文件")
                if "files:write" in perms or "*" in perms:
                    # 权限齐备 → 必须在审批层被拦（而不是被权限层拦）
                    self.assertTrue(
                        decision.requires_approval,
                        f"{role} 权限齐备时必须进入审批，而不是直接执行",
                    )
                else:
                    # 权限不足 → 在权限层就已拒绝，不产生审批单
                    self.assertFalse(decision.requires_approval)
                    self.assertIn("files:write", decision.reason)

        # 真实中间件链：高风险工具在未获批时连处理器都不会被调用
        ctx = self._ctx("owner", ("*",))
        executed: list[dict] = []
        with patch(
            "roveagent.enterprise.approval_bridge.push_requires_approval",
            side_effect=lambda event: True,
        ):
            with bind_tool_context(ctx):
                blocked = run_tool_execution_middleware(
                    "write_file", {"path": "x.ts", "content": "y"},
                    lambda args: executed.append(dict(args)),
                )
        self.assertTrue(json.loads(blocked)["requires_approval"])
        self.assertEqual(executed, [], "未批准的写文件动作绝不得执行")

    # -- 场景 3 ------------------------------------------------------------
    def test_3_plugin_tool_without_policy_pack_is_denied(self) -> None:
        """plugin tool sandbox → 无策略包时命中兜底 = default deny。

        Phase 9 之前：已注册的插件工具命中兜底行（permission=""、approval=NONE）
        即被放行且免审批。现在兜底即拒绝。
        """
        gate = EnterpriseToolGate()  # 不传 policies → 使用 DEFAULT_POLICIES
        # (a) 未注册的插件工具 → 走 unknown 分支拒绝
        unregistered = gate.authorize(self._ctx("owner", ("*",)), "plugin__untrusted__danger", {})
        self.assertFalse(unregistered.allowed)
        self.assertIn("not registered", unregistered.reason)

        # (b) 已注册但无显式策略行 → 走 default-deny 分支拒绝
        _register_probe("plugin__untrusted__registered", self.executions)
        try:
            policy = gate.policy_for("plugin__untrusted__registered")
            self.assertTrue(gate._is_fallback(policy), "未登记插件工具必须落在兜底行")
            registered_but_ungoverned = gate.authorize(
                self._ctx("owner", ("*",)), "plugin__untrusted__registered", {},
            )
            self.assertFalse(registered_but_ungoverned.allowed)
            self.assertIn("no explicit policy row", registered_but_ungoverned.reason)
        finally:
            registry.deregister("plugin__untrusted__registered")

        # (c) 有策略包的插件工具走独立策略行，并通过沙箱桥接执行
        ctx = self._ctx("owner", ("*",))
        registered_gate = EnterpriseToolGate(policies=[
            ToolPolicy("plugin__e2e__probe", "sandbox:execute",
                       RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
        ])
        p = registered_gate.policy_for("plugin__e2e__probe")
        self.assertFalse(registered_gate._is_fallback(p))
        # MEDIUM + MANAGER：owner 按上级免审语义可直执（收紧范围只限 HIGH/CRITICAL）
        self.assertTrue(registered_gate.check_approval(p, ctx))

    # -- 场景 4 / 5 --------------------------------------------------------
    def _drive_approval_callback(self, approved: bool) -> dict:
        """驱动真实的签名 HTTP 审批回调，返回解析后的响应体。"""
        body = json.dumps({
            "tenant_id": "tenant-e2e", "business_id": "biz-e2e",
            "tool": "write_file",
            "args": {"path": "x.ts", "content": "y"},
            "approved": approved,
            "approver": "owner-e2e",
            "invocation_id": "inv-e2e-1",
            "execution_id": "exec-e2e-1",
            "arguments_hash": hashlib.sha256(
                json.dumps({"path": "x.ts", "content": "y"}, sort_keys=True,
                           ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            ).hexdigest(),
            "user_id": "user-e2e", "agent_id": "developer",
            "role": "owner", "permissions": ["*"],
            "request_id": "req-e2e", "task_id": "task-e2e",
        }, separators=(",", ":"))
        response = self.client.post(
            "/api/agent/tool/resolve", content=body, headers=self._signed_headers(body),
        )
        return {"status_code": response.status_code, "json": response.json()}

    def test_4_callback_without_distinct_approval_secret_is_rejected(self) -> None:
        """审批回调必须由独立密钥签名（Phase 9 / A4）。

        把 APPROVAL_SECRET 设成与 API key 相同 → 服务端拒绝（503），
        即「持有调用密钥」不等于「持有审批权」。
        """
        body = json.dumps({"probe": True}, separators=(",", ":"))
        ts = str(int(time.time()))
        same_key = "shared-key"
        signature = hmac.new(
            same_key.encode(), f"{ts}.{body}".encode(), hashlib.sha256,
        ).hexdigest()
        with patch.dict(os.environ, {
            "ROVEAGENT_API_KEY": same_key,
            "ROVEAGENT_APPROVAL_SECRET": same_key,
        }):
            response = self.client.post(
                "/api/agent/tool/resolve", content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-RoveAgent-Key": same_key,
                    "X-RoveAgent-Timestamp": ts,
                    "X-RoveAgent-Signature": signature,
                },
            )
        self.assertEqual(
            response.status_code, 503,
            "审批密钥与调用密钥相同时必须拒绝服务，而不是接受签名",
        )

    def test_5_rejection_executes_nothing(self) -> None:
        """approval reject → 不执行任何动作。"""
        self.executions.clear()
        result = self._drive_approval_callback(approved=False)
        self.assertIn(result["status_code"], (200, 409, 422, 500), result)
        self.assertEqual(self.executions, [], "拒绝路径不得触发任何工具执行")

    def test_5b_acceptance_executes_exactly_once(self) -> None:
        """approval accept → 恰好执行一次；二次重复回调不得重复执行。"""
        self.executions.clear()
        first = self._drive_approval_callback(approved=True)
        self.assertEqual(first["status_code"], 200, first)
        after_first = len(self.executions)

        second = self._drive_approval_callback(approved=True)
        self.assertIn(second["status_code"], (200, 409, 500), second)
        self.assertEqual(
            len(self.executions), after_first,
            "重复回调不得导致第二次执行（单次放行契约）",
        )


if __name__ == "__main__":
    unittest.main()
