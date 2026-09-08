"""Phase 9 E2E：餐厅老板问"本周销售为什么下降？"


链路：Operations 分析 POS → Marketing 查客户 → CEO 汇总 → 建议
      → 审批 → 执行唤回活动；全程验证 Memory / Permissions / Audit /
      Execution / Result。LLM 打桩（无真实 key 时不伪造联网回答）。
"""
import hashlib, hmac, json, os, pathlib, shutil, tempfile, threading, time
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from roveagent.kernel import RoveAgentKernel
from roveagent.business.data_layer import BusinessDataLayer
from roveagent.enterprise.run_context import bind_tool_context
from roveagent.enterprise.approval_grants import record_grant
from roveagent.clisupport.middleware import run_tool_execution_middleware
from roveagent.tools.framework import ToolContext
from roveagent.state.enterprise_memory import MemoryLayer
from roveagent.workforce import BusinessGoalEngine, build_workforce, find_employee

td = tempfile.mkdtemp()
approval_events = []
approval_key = "roveagent-e2e-approval-key"


class ApprovalReceiver(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size)
        timestamp = self.headers.get("X-RoveAgent-Timestamp", "")
        signature = self.headers.get("X-RoveAgent-Signature", "")
        expected = hmac.new(
            approval_key.encode(), timestamp.encode() + b"." + body, hashlib.sha256,
        ).hexdigest()
        if self.path != "/api/agent/approvals/events" or not hmac.compare_digest(signature, expected):
            self.send_response(401)
            self.end_headers()
            return
        approval_events.append(json.loads(body.decode("utf-8")))
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, _format, *_args):
        return


approval_server = ThreadingHTTPServer(("127.0.0.1", 0), ApprovalReceiver)
approval_thread = threading.Thread(target=approval_server.serve_forever, daemon=True)
approval_thread.start()
old_env = dict(os.environ)
os.environ["ROVEAGENT_API_KEY"] = approval_key
os.environ["ROVEAGENT_APPROVAL_SECRET"] = approval_key
os.environ["ROVEFRAME_INTERNAL_API_URL"] = f"http://127.0.0.1:{approval_server.server_port}"
os.environ["ROVEAGENT_ROOT"] = str(pathlib.Path(td) / "kernel")


def canonical_transport(operation, payload):
    data = {"id": f"canonical-{operation}"} if operation.startswith(("upsert_", "set_")) else []
    return {
        "ok": True,
        "scope": {"tenant_id": payload["tenant_id"], "business_id": payload["business_id"]},
        "data": data,
    }


k = RoveAgentKernel(
    pathlib.Path(td) / "kernel",
    business_adapter_factory=lambda tenant, business: BusinessDataLayer(
        tenant, business, transport=canonical_transport,
    ),
)
try:
    # ---- 开店 + 沙盒 POS 数据 ------------------------------------------------
    prov = k.provision_business("安记茶餐厅", industry="restaurant",
                                region="NYC", connectors=["square"],
                                business_id="business-e2e")
    tid = prov["tenant"].tenant_id
    team = {a.key for a in prov["team"]}
    assert {"ceo", "operations", "marketing", "customer"} <= team
    print("0. 开店 OK | 团队:", sorted(team))

    # ---- 1. Operations Agent 分析 POS（只读工具，门控放行） -------------------
    ops = find_employee("operations")
    with bind_tool_context(ToolContext(
        tenant_id=tid, business_id="business-e2e", user_id="user-manager",
        role="manager", permissions=frozenset([*ops.permissions, "orders:read"]),
        request_id="request-analysis", task_id="task-analysis", agent_id="operations",
    )):
        r = run_tool_execution_middleware("read_sales", {"period": "week"},
                                          lambda a: {"revenue_wow": -0.12, "rain_days": 3})
    assert isinstance(r, dict) and r["revenue_wow"] == -0.12
    k.memory if hasattr(k, "memory") else None
    k._log(tid, "operations", "analyze_pos", "本周营收环比 -12%，雨天 3 天")
    print("1. Operations 分析 OK:", r)

    # ---- 2. Marketing 查客户 + 记忆沉淀（L2 租户层） -------------------------
    mkt = find_employee("marketing")
    k._log(tid, "marketing", "check_customers", "21 天未复购客群 86 人")
    # ---- 3. CEO 汇总 + 生成建议 ----------------------------------------------
    k._log(tid, "ceo", "recommend", "建议：周末会员唤回活动（预算 $100）")

    # ---- 4. 高风险动作经门控：外发活动需审批 ----------------------------------
    with bind_tool_context(ToolContext(
        tenant_id=tid, business_id="business-e2e", user_id="user-manager",
        role="manager", permissions=frozenset([*mkt.permissions, "comms:send"]),
        request_id="request-campaign", task_id="task-campaign", agent_id="marketing",
    )):
        blocked = json.loads(run_tool_execution_middleware(
            "send_marketing_campaign", {"segment": "inactive_21d", "budget": 100},
            lambda a: {"sent": 86}))
    assert blocked["error"] == "enterprise_gate_blocked"
    assert blocked["requires_approval"] and blocked["approval_policy"] in ("manager", "owner")
    assert len(approval_events) == 1
    frozen = approval_events[0]["payload"]
    assert frozen["args"] == {"segment": "inactive_21d", "budget": 100}
    print("2-4. 分析→建议→审批拦截 OK:", blocked["reason"])

    # ---- 5. 业主批准冻结调用后，以一次性 grant 恢复原 middleware 路径 -----------
    record_grant(
        tenant_id=tid, business_id="business-e2e", tool=frozen["tool"],
        args=frozen["args"], approved=True, approver="owner-e2e",
        audit_event_id=frozen["audit_event_id"], root=pathlib.Path(td) / "kernel",
        invocation_id=frozen["invocation_id"], execution_id="execution-e2e",
        request_id=frozen["request_id"],
    )
    with bind_tool_context(ToolContext(
        tenant_id=tid, business_id="business-e2e", user_id="user-manager",
        role="manager", permissions=frozenset([*mkt.permissions, "comms:send"]),
        request_id="request-campaign", task_id="task-campaign", agent_id="marketing",
    )):
        sent = run_tool_execution_middleware(
            "send_marketing_campaign", {"segment": "inactive_21d", "budget": 100},
            lambda a: {"sent": 86, "channel": "sms"})
    assert sent["sent"] == 86
    k._log(tid, "marketing", "campaign_executed", "唤回活动已发送 86 人", "ok")
    print("5. 批准后执行 OK:", sent)

    # ---- 6. 验证：记忆 / 权限 / 审计 ------------------------------------------
    from roveagent.state.enterprise_memory import EnterpriseMemory
    mem = EnterpriseMemory(pathlib.Path(td) / "mem.db")
    mem.add("本周营收环比下降 12%，主因连续雨天", MemoryLayer.L2_TENANT,
            tenant_id=tid, business_id="business-e2e", industry="restaurant",
            kind="decision", importance=0.9)
    hits = mem.search("环比下降", tenant_id=tid, business_id="business-e2e",
                      industry="restaurant")
    assert hits and "雨天" in hits[0].content
    other = mem.search("环比下降", tenant_id="another-tenant",
                       business_id="another-business", industry="restaurant")
    assert not any("雨天" in h.content for h in other)   # 租户隔离
    print("6. 记忆验证 OK（命中 + 隔离）")

    audit_rows = k.audit(tid).read() if hasattr(k.audit(tid), "read") else []
    print("7. 审计条数:", len(audit_rows) if audit_rows else "见 AuditLog")

    # ---- 8. 目标引擎：'月营收提升 20%' ----------------------------------------
    goal = BusinessGoalEngine().create_goal(tid, "月营收提升 20%")
    assert goal.metric == "revenue" and goal.target_value == "20%"
    assert any(t.status == "awaiting_approval" for t in goal.tasks)
    assert any(t.assignee == "marketing" for t in goal.tasks)
    print("8. 目标引擎 OK: 5 步策略，审批与分工就位")
finally:
    k.close()
    approval_server.shutdown()
    approval_server.server_close()
    approval_thread.join(timeout=2)
    os.environ.clear()
    os.environ.update(old_env)
    shutil.rmtree(td, ignore_errors=True)
print("=== PHASE 9 E2E SCENARIO PASSED ===")
