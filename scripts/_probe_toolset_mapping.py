"""只读校验：Step 1.75 的 agent→toolset 映射。

检查三件事：
  1. find_employee() 对每个映射 key 都能解析（含别名 coo/cmo/cto）
  2. resolver 的输出符合预期，未知 agent fail-closed
  3. 映射里出现的每个 toolset 名在 toolsets.py 中真实存在
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from roveagent.api.toolsets import (  # noqa: E402
    _AGENT_RUNTIME,
    describe_runtime,
)
from roveagent.toolsets import TOOLSETS  # noqa: E402
from roveagent.workforce import find_employee  # noqa: E402


def main() -> int:
    print("--- 1. find_employee() resolution ---")
    for key in ("ceo", "operations", "marketing", "developer", "devops",
                "coo", "cmo", "cto", "ceo-insight"):
        emp = find_employee(key)
        print(f"  {key:14s} -> emp.key={emp.key if emp else None!r}")

    print("\n--- 2. resolver output ---")
    for agent in ("ceo", "operations", "marketing", "developer", "devops",
                  "unknown-agent", ""):
        d = describe_runtime(agent)
        label = agent if agent else "(empty)"
        print(f"  {label:16s} known={str(d['known']):5s} "
              f"toolsets={d['toolsets']} iters={d['max_iterations']}")

    print("\n--- 3. toolset names exist in toolsets.py? ---")
    names: set[str] = set()
    for toolsets, _ in _AGENT_RUNTIME.values():
        names.update(toolsets)
    names.update(("safe", "memory", "business"))
    all_ok = True
    for name in sorted(names):
        exists = name in TOOLSETS
        all_ok = all_ok and exists
        print(f"  {name:12s} exists={exists}")

    print(f"\n[verdict] all toolset names valid: {all_ok}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
