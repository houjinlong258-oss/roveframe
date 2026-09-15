"""Phase 3 探针：Plugin Center 服务面（只读操作）。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "probe-key")

from roveagent.api.plugin_center import (  # noqa: E402
    get_plugin_detail,
    list_plugins_with_envelopes,
    plugin_center_summary,
)


def main() -> int:
    plugins = list_plugins_with_envelopes(include_audit=True)
    print(f"discovered plugins: {len(plugins)}")
    print()
    print(f"{'name':30s} {'state':10s} {'severity':9s} {'src':9s} removable")
    print("-" * 90)
    for record in plugins[:18]:
        security = record.get("security") or {}
        print(
            f"{record['name'][:30]:30s} {record['state']:10s} "
            f"{str(security.get('severity','?')):9s} {str(record['source'])[:9]:9s} "
            f"{record['removable']}"
        )
    print(f"... ({len(plugins)} total)")
    print()
    print("=== summary ===")
    print(json.dumps(plugin_center_summary(), ensure_ascii=False, indent=1))
    print()
    sample = plugins[0]["name"] if plugins else None
    if sample:
        detail = get_plugin_detail(sample)
        print(f"=== detail: {sample} ===")
        print(json.dumps(detail, ensure_ascii=False, indent=1, default=str)[:900])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
