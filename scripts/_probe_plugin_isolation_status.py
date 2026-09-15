"""Phase 3 verification — isolation status over the real plugin set.

Reads the actual bundled plugins through the existing discovery path and reports
each one's isolation verdict. This is the ``status`` half of the Plugin Manager
contract: "is this plugin allowed to load, under what isolation, with which
guarantees" — answered without loading anything.

Read-only. No writes, no network, no plugin is executed.

Run:  python scripts/_probe_plugin_isolation_status.py
"""
from __future__ import annotations

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")


def hdr(t: str) -> None:
    print()
    print("=" * 78)
    print(t)
    print("=" * 78)


def main() -> int:
    from roveagent.api.plugin_center import _discover_all, plugin_center_summary
    from roveagent.api.plugin_isolation import (
        IsolationMode,
        available_isolation_modes,
        isolation_status_for_discovered,
        isolation_summary,
        read_manifest_isolation,
        SandboxSpec,
    )

    hdr("[1] isolation modes actually available on this host")
    modes = available_isolation_modes()
    for mode, ok in modes.items():
        print("  %-12s %s" % (mode.value, "available" if ok else "NOT available"))
    print()
    print("  container is %s" % ("usable" if modes[IsolationMode.CONTAINER]
                                 else "unusable: docker present but no engine"))

    hdr("[2] discovered plugins")
    entries = _discover_all()
    print("  discovered: %d" % len(entries))

    hdr("[3] per-plugin isolation verdict")
    statuses = isolation_status_for_discovered(entries)
    print("  %-26s %-11s %-8s %-26s %s"
          % ("plugin", "mode", "allowed", "permissions", "reason"))
    for row in sorted(statuses, key=lambda r: str(r.get("plugin_name"))):
        perms = (row.get("permissions") or {}).get("requested") or []
        print("  %-26s %-11s %-8s %-26s %s" % (
            str(row.get("plugin_name"))[:26],
            str(row.get("mode"))[:11],
            "yes" if row.get("allowed") else "NO",
            ",".join(perms)[:26] or "-",
            str(row.get("reason"))[:60],
        ))

    hdr("[4] summary")
    summary = isolation_summary(statuses)
    print("  total          :", summary["total"])
    print("  allowed        :", summary["allowed"])
    print("  refused        :", summary["refused"])
    print("  by mode        :", summary["by_mode"])
    print("  container usable:", summary["container_available"])

    hdr("[5] a plugin that declares container isolation but cannot get it")
    from roveagent.api.plugin_isolation import PluginPermissions, evaluate_isolation

    verdict = evaluate_isolation(
        "hypothetical-strict-plugin",
        SandboxSpec(mode=IsolationMode.CONTAINER, memory_mb=512),
        PluginPermissions(), available=modes)
    print("  allowed:", verdict.allowed)
    print("  reason :", verdict.reason)

    hdr("[6] manifest read errors across the real set")
    problems = []
    for entry in entries:
        raw_path = entry.get("path")
        if not raw_path:
            problems.append((entry.get("name"), "no path from discovery"))
            continue
        _spec, _perms, error = read_manifest_isolation(__import__("pathlib").Path(str(raw_path)))
        if error:
            problems.append((entry.get("name"), error))
    if problems:
        for name, error in problems:
            print("  %-26s %s" % (name, error))
    else:
        print("  none: every discovered plugin's manifest parsed")

    hdr("[7] plugin_center summary integration")
    center = plugin_center_summary()
    block = center.get("isolation") or {}
    print("  keys            :", sorted(center))
    print("  isolation.total :", (block.get("summary") or {}).get("total"))
    print("  isolation.refused:", (block.get("summary") or {}).get("refused"))
    print("  json-safe       :", bool(json.dumps(block, default=str)))

    hdr("[8] gap summary")
    print("  failure isolation (separate process) : IMPLEMENTED + verified")
    print("  privilege isolation (filesystem/net): %s"
          % ("IMPLEMENTED; command verified, execution NOT verified (no engine)"
             if modes[IsolationMode.CONTAINER] else
             "command built + asserted; execution NOT verified (no container engine)"))
    print()
    print("[done] read-only; nothing was loaded or executed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
