"""Phase 8 UI 验收：重拍 05/06（修正演示库行尾后的同状态补拍）
用法: python scripts/phase8-ui-reshoot.py 05|06"""
import base64, hashlib, hmac, json, time, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5000"
SECRET = b"demo-p8-secret"
SHOTS = "phase8-demo/shots"
MODE = sys.argv[1] if len(sys.argv) > 1 else "05"
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
    page.set_default_timeout(90000)

    page.goto(f"{BASE}/en/enterprise/approvals", wait_until="domcontentloaded")
    page.wait_for_selector("text=Document approval pipeline guarantee")
    page.click("text=Document approval pipeline guarantee")

    if MODE == "05":
        page.wait_for_selector("button:has-text('Rollback')", timeout=60000)
        # 滚动到 Files changed 区域，让 diff 统计行入镜
        page.click("text=Files changed")
        page.wait_for_timeout(1000)
        page.screenshot(path=f"{SHOTS}/05-applied.png", full_page=True)
        print("reshot 05 applied", flush=True)
    else:
        page.wait_for_selector("text=/status is .rolled_back./", timeout=60000)
        page.click("text=Files changed")
        page.wait_for_timeout(1000)
        page.screenshot(path=f"{SHOTS}/06-rolled-back.png", full_page=True)
        print("reshot 06 rolled_back", flush=True)

    browser.close()
print(f"RESHOOT {MODE} OK")
