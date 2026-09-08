"""roveagent/api 六个端点的真实 HTTP 冒烟测试（uvicorn + requests）。"""
import os, tempfile, threading, time, json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

os.environ["ROVEAGENT_API_KEY"] = "test-key"
os.environ["ROVEAGENT_ROOT"] = tempfile.mkdtemp()

import requests
import uvicorn

from roveagent.api.app import create_app, get_context

app = create_app()
config = uvicorn.Config(app, host="127.0.0.1", port=8799, log_level="error")
server = uvicorn.Server(config)
t = threading.Thread(target=server.run, daemon=True)
t.start()
for _ in range(50):
    try:
        requests.get("http://127.0.0.1:8799/api/health", timeout=1)
        break
    except Exception:
        time.sleep(0.2)

B = "http://127.0.0.1:8799"
H = {"X-RoveAgent-Key": "test-key"}

r = requests.get(f"{B}/api/health")
assert r.status_code == 200, r.text
r = requests.post(f"{B}/api/agent/task", json={"tenant_id": "t1", "objective": "x"})
assert r.status_code in (401, 403)
print("health+auth OK")

ctx = get_context()
prov = ctx.kernel.provision_business(
    "测试餐厅", industry="restaurant", business_id="business-smoke",
)
tid = prov["tenant"].tenant_id

chat_payload = {
    "tenant_id": tid,
    "business_id": "business-smoke",
    "user_id": "user-smoke",
    "message": "为什么销售下降？",
    "agent": "operations",
    "role": "manager",
    "permissions": ["orders:read"],
    "request_id": "request-smoke",
    "task_id": "task-smoke",
    "session_id": "session-smoke",
    "industry": "restaurant",
    "business_context": "本周真实营收 $880，订单 42 单。",
}
r = requests.post(f"{B}/api/agent/chat", json=chat_payload, headers=H)
assert r.status_code == 503, r.text
ctx.agent_chat = lambda system, user, **kw: "本周营收环比下降 12%，主因雨天客流减少。建议：周末促销。"
r = requests.post(f"{B}/api/agent/chat", json=chat_payload, headers=H)
assert r.status_code == 200 and "营收" in r.json()["reply"], r.text
print("chat OK:", r.json()["reply"][:30])

r = requests.post(f"{B}/api/agent/task", json={"tenant_id": tid, "objective": "月营收提升 20%"}, headers=H)
assert r.status_code == 200, r.text
task = r.json()["task"]
assert r.json()["metric"] == "revenue" and r.json()["target"] == "20%"
assert any(s["needs_approval"] for s in task["steps"])
print("task OK:", task["status"], "| steps:", len(task["steps"]), "| target:", r.json()["target"])

r = requests.post(f"{B}/api/agent/execute", json={"tenant_id": tid, "task_id": task["id"], "approved": False}, headers=H)
assert r.json()["awaiting_approval"], r.text
r = requests.post(f"{B}/api/agent/execute", json={"tenant_id": tid, "task_id": task["id"], "approved": True, "approver": "owner"}, headers=H)
assert r.json()["status"] == "done", r.text
print("execute OK: ->", r.json()["status"])

r = requests.get(f"{B}/api/agent/status/{task['id']}", params={"tenant_id": tid}, headers=H)
assert r.json()["task"]["status"] == "done"
print("status OK")

r = requests.get(f"{B}/api/agent/memory", params={"tenant_id": tid, "query": "销售"}, headers=H)
assert r.status_code == 200 and r.json()["count"] >= 1, r.text
print("memory OK:", r.json()["count"], "hits")

r = requests.post(f"{B}/api/agent/skill/create", json={"tenant_id": tid, "name": "周末促销流程", "description": "周末促销 SOP", "workflow": "1.选品 2.定价 3.推送", "industry": "restaurant"}, headers=H)
assert r.status_code == 200, r.text
print("skill OK:", r.json()["path"])

server.should_exit = True
time.sleep(0.3)
print("=== ALL 6 ENDPOINTS PASSED (real HTTP) ===")
