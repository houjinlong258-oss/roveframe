"""只读校验：Step 2 新增的 /api/agent/chat/stream 是否已注册，且原有端点未受影响。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "probe-key")

from roveagent.api.app import get_app  # noqa: E402


def main() -> int:
    routes = sorted(
        f"{sorted(r.methods)[0]} {r.path}"
        for r in get_app().routes
        if getattr(r, "methods", None)
    )
    print(f"total routes: {len(routes)}")
    for route in routes:
        print(f"  {route}")

    checks = {
        "POST /api/agent/chat": True,
        "POST /api/agent/chat/stream": False,
    }
    for route, required in checks.items():
        present = route in routes
        status = "OK" if (present or not required) else "MISSING"
        print(f"[{status}] {route} present={present}")

    # 非流式端点必须保留
    ok_nonstream = "POST /api/agent/chat" in routes
    ok_stream = "POST /api/agent/chat/stream" in routes
    # 既有签名端点不得受影响
    ok_signed = ("POST /api/agent/execute" in routes
                 and "POST /api/agent/tool/resolve" in routes)

    print(f"\n[verdict] nonstream={ok_nonstream} stream={ok_stream} signed_intact={ok_signed}")
    return 0 if (ok_nonstream and ok_stream and ok_signed) else 1


if __name__ == "__main__":
    raise SystemExit(main())
