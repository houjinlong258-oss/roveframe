"""Phase 8 UI 验收走查 part 3：05-applied 截图 → Rollback（真实门禁）→ 06-rolled-back
承接：apply 已真实合入（merge 9366b6f），提案存储已恢复为 applied。
Rollback 同样过测试门禁（tsx --test + tsc），轮询预算 245s。"""
import base64, hashlib, hmac, json, time, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5000"
SECRET = b"demo-p8-secret"
SHOTS = "phase8-demo/shots"
PROPOSAL_ID = "cprop_demo_readme"
os.makedirs(SHOTS, exist_ok=True)

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def make_jwt() -> str:
    h = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    p = b64url(json.dumps({
        "sub": "demo-owner", "email": "demo@roveframe.dev",
        "app_metadata": {"tenant_id": "tenant_demo"},
        "exp": int(time.time()) + 3600,
    }).encode())
    s = b64url(hmac.new(SECRET, f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{s}"

def api_status() -> str:
    req = urllib.request.Request(
        f"{BASE}/api/coding-agent?id={PROPOSAL_ID}",
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["proposal"]["status"]

def wait_status(want: str, budget: int) -> bool:
    deadline = time.time() + budget
    while time.time() < deadline:
        try:
            s = api_status()
            print(f"  poll: {s}", flush=True)
            if s == want:
                return True
        except Exception as e:
            print(f"  poll error: {e}", flush=True)
        time.sleep(6)
    return False

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
    ctx.add_cookies([{
        "name": "rf_session", "value": make_jwt(),
        "domain": "localhost", "path": "/",
    }])
    page = ctx.new_page()
    page.set_default_timeout(90000)

    page.goto(f"{BASE}/en/enterprise/approvals", wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")

    # 5：applied 状态（Rollback 按钮出现）
    page.wait_for_selector("button:has-text('Rollback')", timeout=60000)
    page.wait_for_timeout(1000)
    page.screenshot(path=f"{SHOTS}/05-applied.png", full_page=True)
    print("shot 05 applied", flush=True)

    # 6：Rollback（git revert + 测试门禁，分钟级；轮询 API）
    page.click("button:has-text('Rollback')")
    print("rollback clicked, polling status...", flush=True)
    if not wait_status("rolled_back", 245):
        print("ROLLBACK_DID_NOT_COMPLETE_IN_BUDGET", flush=True)
        browser.close()
        sys.exit(3)
    page.wait_for_timeout(1200)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")
    page.wait_for_selector("text=/status is .rolled_back./", timeout=60000)
    page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/06-rolled-back.png", full_page=True)
    print("shot 06 rolled_back", flush=True)

    browser.close()
print("WALKTHROUGH PART 3 OK")
