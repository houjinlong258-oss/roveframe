"""只读启动探针 —— 验证 RoveAgent Service 能否在本机自举。

不修改仓库、不写业务数据；ROVEAGENT_ROOT 指向临时目录。
用法: python scripts/_probe_roveagent_boot.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import traceback

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

tmp = tempfile.mkdtemp(prefix="roveagent-probe-")
os.environ["ROVEAGENT_ROOT"] = tmp
os.environ["ROVEAGENT_API_KEY"] = "probe-key-not-secret"
os.environ["ROVEAGENT_APPROVAL_SECRET"] = "probe-approval-not-secret"

print(f"[probe] repo={REPO}")
print(f"[probe] root={tmp}")

results: list[tuple[str, bool, str]] = []


def step(name: str, fn):
    try:
        value = fn()
        results.append((name, True, str(value)))
        print(f"[ OK ] {name}: {value}")
        return value
    except Exception as exc:  # noqa: BLE001 - 探针需要看到全部失败形态
        detail = f"{type(exc).__name__}: {exc}"
        results.append((name, False, detail))
        print(f"[FAIL] {name}: {detail}")
        traceback.print_exc(limit=3)
        return None


# 1. 顶层包导入
step("import roveagent", lambda: __import__("roveagent").__name__)

# 2. API 模块与工厂
def _make_app():
    from roveagent.api.app import get_app
    return type(get_app()).__name__

app_obj = step("get_app()", _make_app)

# 3. 路由清单（确认 TS 客户端依赖的端点都在）
if app_obj is not None:
    from roveagent.api.app import get_app
    routes = sorted(
        f"{sorted(r.methods)[0]} {r.path}"
        for r in get_app().routes
        if getattr(r, "methods", None)
    )
    print(f"[probe] routes ({len(routes)}):")
    for route in routes:
        print(f"         {route}")

# 4. ServiceContext 自举（kernel + memory + tasks + chat_sessions + 行业包同步）
def _ctx():
    from roveagent.api.app import get_context
    ctx = get_context()
    return f"kernel={type(ctx.kernel).__name__} gate={type(ctx.gate).__name__}"

step("ServiceContext boot", _ctx)

# 5. Workforce：确认 agent key 与声明的 tools/permissions
def _workforce():
    from roveagent.workforce import find_employee
    out = []
    for key in ("ceo", "operations", "marketing", "developer", "devops"):
        emp = find_employee(key)
        out.append(
            f"{key}={'MISSING' if emp is None else emp.name}"
            + ("" if emp is None else f" tools={emp.tools} forbidden={emp.forbidden}")
        )
    return " | ".join(out)

step("workforce registry", _workforce)

# 6. Toolset 是否可解析（这是「权限→工具」链路的核心）
def _toolsets():
    from roveagent.model_tools import get_available_toolsets
    avail = get_available_toolsets()
    wanted = ("safe", "coding", "file", "terminal", "business", "image_gen", "video_gen", "web", "search")
    return " ".join(f"{w}={'yes' if w in avail else 'NO'}" for w in wanted)

step("get_available_toolsets", _toolsets)

# 7. LLM 配置是否存在（缺失时 /api/agent/chat 返回 503）
has_llm = bool(os.environ.get("ROVEAGENT_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY"))
print(f"[probe] LLM configured: {has_llm}  (ROVEAGENT_LLM_API_KEY/OPENAI_API_KEY)")

# 8. 媒体 provider 可用性（出厂态预期：均不可用）
def _media():
    from roveagent.plugins.video_gen import list_providers as vlist
    vids = [f"{p.name}={p.is_available()}" for p in vlist()]
    try:
        from roveagent.plugins.image_gen import list_providers as ilist
        imgs = [f"{p.name}={p.is_available()}" for p in ilist()]
    except Exception as exc:  # noqa: BLE001
        imgs = [f"image_gen registry unavailable: {type(exc).__name__}"]
    return "video[" + ", ".join(vids) + "] image[" + ", ".join(imgs) + "]"

step("media providers", _media)

# 9. 沙箱后端可用性
def _sandbox():
    import roveagent.sandbox as sb
    names = [n for n in dir(sb) if not n.startswith("_")]
    backends = [n for n in ("local", "docker", "daytona", "modal", "ssh", "singularity", "vercel_sandbox") if n in names]
    docker_ok = None
    try:
        import shutil
        docker_ok = shutil.which("docker") is not None
    except Exception:  # noqa: BLE001
        pass
    return f"modules={backends} docker_cli={docker_ok}"

step("sandbox backends", _sandbox)

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n[probe] {passed}/{len(results)} steps passed")
sys.exit(0 if passed == len(results) else 1)
