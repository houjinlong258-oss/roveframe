"""Phase 8 UI 验收走查 part 2：重拍 approved → Apply（真实门禁）→ Rollback
Apply/Rollback 等待改为轮询 API 状态（页面按钮出现滞后于状态落库）"""
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
            print(f"  poll: {s}")
            if s == want:
                return True
            if s in ("apply_failed",):
                print(f"  FAILED with status {s}")
                return False
        except Exception as e:
            print(f"  poll error: {e}")
        time.sleep(8)
    return False

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
    ctx.add_cookies([{
        "name": "rf_session", "value": make_jwt(),
        "domain": "localhost", "path": "/",
    }])
    page = ctx.new_page()
    page.set_default_timeout(120000)

    page.goto(f"{BASE}/en/enterprise/approvals", wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")

    # 4（重拍）：等 Apply 按钮出现 = 详情区已确认 approved
    page.wait_for_selector("button:has-text('Apply (write code + run tests)')", timeout=60000)
    page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/04-approved.png")
    print("shot 04 approved (retaken)")

    # 2b：diff 近景（含红/绿/上下文）
    page.click("text=Files changed")
    page.wait_for_timeout(600)
    page.screenshot(path=f"{SHOTS}/02b-diff-closeup.png", full_page=True)
    print("shot 02b diff closeup")

    # 5：Apply（真实 git merge + 测试门禁，分钟级；轮询 API 而非页面）
    page.click("button:has-text('Apply (write code + run tests)')")
    print("apply clicked, polling status...")
    if not wait_status("applied", 230):
        print("APPLY_DID_NOT_COMPLETE_IN_BUDGET")
        browser.close()
        sys.exit(2)
    page.wait_for_timeout(1200)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")
    page.wait_for_selector("button:has-text('Rollback')", timeout=60000)
    page.wait_for_timeout(1000)
    page.screenshot(path=f"{SHOTS}/05-applied.png", full_page=True)
    print("shot 05 applied")

    # 6：Rollback
    page.click("button:has-text('Rollback')")
    print("rollback clicked, polling status...")
    if not wait_status("rolled_back", 200):
        print("ROLLBACK_DID_NOT_COMPLETE_IN_BUDGET")
        browser.close()
        sys.exit(3)
    page.wait_for_timeout(1200)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")
    page.wait_for_selector("text=/status is .rolled_back./", timeout=60000)
    page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/06-rolled-back.png", full_page=True)
    print("shot 06 rolled_back")

    browser.close()
print("WALKTHROUGH PART 2 OK")
