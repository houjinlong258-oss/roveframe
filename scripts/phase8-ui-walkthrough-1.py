"""Phase 8 UI 验收走查：列表 → diff → Request changes → Approve（截图留证）"""
import base64, hashlib, hmac, json, time, os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5000"
SECRET = b"demo-p8-secret"
SHOTS = "phase8-demo/shots"
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

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
    ctx.add_cookies([{
        "name": "rf_session", "value": make_jwt(),
        "domain": "localhost", "path": "/",
    }])
    page = ctx.new_page()
    page.set_default_timeout(120000)

    # 1. 列表页
    page.goto(f"{BASE}/en/enterprise/approvals", wait_until="domcontentloaded")
    page.wait_for_selector("text=Add loyalty banner widget")
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{SHOTS}/01-list.png")
    print("shot 01 list")

    # 2. 选中 modify 提案 → diff 视图（红/绿/上下文）
    page.click("text=Document approval pipeline guarantee")
    page.wait_for_selector("text=@@", state="attached", timeout=60000)
    page.wait_for_timeout(1000)
    page.screenshot(path=f"{SHOTS}/02-diff.png", full_page=True)
    print("shot 02 diff")

    # 3. 填写备注 → Request changes
    page.fill("textarea", "Please also mention the rollback SLA in rule 3.")
    page.click("button:has-text('Request changes')")
    page.wait_for_selector("span:has-text('Changes requested')", timeout=60000)
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{SHOTS}/03-changes-requested.png")
    print("shot 03 changes_requested")

    # 4. Approve
    page.click("button:has-text('Approve')")
    page.wait_for_selector("span:has-text('Approved')", timeout=60000)
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{SHOTS}/04-approved.png")
    print("shot 04 approved")

    browser.close()
print("WALKTHROUGH PART 1 OK")
