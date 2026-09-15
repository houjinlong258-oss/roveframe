"""Phase 3 探针：对真实插件跑安全信封审计（只读）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))

from roveagent.api.plugin_security import audit_plugin  # noqa: E402


def main() -> int:
    base = REPO / "roveagent" / "plugins"
    targets = [
        "image_gen/openai", "image_gen/fal", "image_gen/xai",
        "web/exa", "web/firecrawl", "web/ddgs",
        "video_gen/xai", "platforms/telegram", "platforms/discord",
        "memory", "kanban", "observability",
    ]
    print(f"{'plugin':26s} {'severity':9s} {'net':4s} {'fs':10s} {'sandbox':9s} undeclared")
    print("-" * 100)
    counts: dict[str, int] = {}
    for target in targets:
        path = base / target
        manifest = SimpleNamespace(key=target, name=target.split("/")[-1])
        audit = audit_plugin(manifest, path)
        d = audit.as_dict()
        counts[d["severity"]] = counts.get(d["severity"], 0) + 1
        derived = d["derived"]
        print(
            f"{target:26s} {d['severity']:9s} {derived['network']:4s} "
            f"{derived['filesystem']:10s} {derived['sandbox']:9s} {d['undeclared']}"
        )
    print()
    print("severity counts:", counts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
