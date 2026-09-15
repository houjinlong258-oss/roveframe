"""Phase 3 (2.0) scan — plugin / MCP / environments / sandbox surface.

The user's Phase 3 spec requires plugins to NOT run in the main process, via
    Plugin -> MCP Boundary -> Sandbox Process -> Tool Gateway -> Agent
so this scan establishes what already exists before anything is built.

Answers four questions:
  1. plugin dirs        where plugins live, and what the manifest already declares
  2. MCP capability     is there a client/transport that could BE the boundary
  3. tools/environments which isolation backends exist and whether they are usable
  4. sandbox code       what isolation machinery the tree already has

Read-only. No writes, no network.

Run:  python scripts/_scan_plugin_isolation.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

RROOT = os.path.join(ROOT, "roveagent")


def hdr(title: str) -> None:
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


def find_dirs(*names: str) -> list[str]:
    out = []
    for dirpath, dirnames, _f in os.walk(RROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in names:
            if os.path.basename(dirpath) == name:
                out.append(os.path.relpath(dirpath, RROOT))
    return out


def main() -> int:
    hdr("[1] plugin directories")
    for rel in sorted(find_dirs("plugins")):
        entries = sorted(
            d for d in os.listdir(os.path.join(RROOT, rel))
            if os.path.isdir(os.path.join(RROOT, rel, d)) and d != "__pycache__"
        )
        print("  %s  (%d subdirs)" % (rel, len(entries)))
        for name in entries[:40]:
            print("      %s" % name)
        if len(entries) > 40:
            print("      ... and %d more" % (len(entries) - 40))

    hdr("[2] PluginManifest field surface (what a manifest can already declare)")
    for rel in ("plugins/manifest.py", "plugins/base.py", "core/plugin_manifest.py",
                "clisupport/plugins.py"):
        path = os.path.join(RROOT, *rel.split("/"))
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8", errors="replace").read()
        print("  --- %s (%d bytes) ---" % (rel, len(src)))
        for match in re.finditer(r"^class\s+(\w+)", src, re.M):
            print("      class", match.group(1))
        for field in ("name", "version", "author", "tools", "permissions",
                      "runtime", "sandbox", "provides_tools", "capabilities",
                      "risk", "granted_capabilities"):
            present = re.search(r"\b%s\b" % field, src) is not None
            print("      field %-22s %s" % (field, "present" if present else "-"))

    hdr("[3] MCP capability in the tree")
    mcp_files = []
    for dirpath, dirnames, filenames in os.walk(RROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if "mcp" in fn.lower():
                p = os.path.join(dirpath, fn)
                mcp_files.append((os.path.relpath(p, RROOT), os.path.getsize(p)))
    for rel, size in sorted(mcp_files)[:40]:
        print("  %-62s %7d" % (rel, size))
    print("  total MCP-ish files: %d" % len(mcp_files))

    hdr("[4] tools/environments backends")
    env_dir = os.path.join(RROOT, "tools", "environments")
    if os.path.isdir(env_dir):
        for fn in sorted(os.listdir(env_dir)):
            if fn.endswith(".py") and fn != "__init__.py":
                p = os.path.join(env_dir, fn)
                src = open(p, encoding="utf-8", errors="replace").read()
                classes = re.findall(r"^class\s+(\w+)", src, re.M)
                print("  %-22s %7d  %s" % (fn, os.path.getsize(p), ", ".join(classes[:3])))
    else:
        print("  MISSING", env_dir)

    hdr("[5] which isolation backends could actually run here")
    probes = {
        "docker": shutil.which("docker"),
        "podman": shutil.which("podman"),
        "firejail": shutil.which("firejail"),
        "bwrap": shutil.which("bwrap"),
        "singularity": shutil.which("singularity"),
        "apptainer": shutil.which("apptainer"),
        "nsjail": shutil.which("nsjail"),
        "systemd-run": shutil.which("systemd-run"),
        "ssh": shutil.which("ssh"),
    }
    for name, path in probes.items():
        print("  %-14s %s" % (name, path or "NOT FOUND"))

    hdr("[6] existing sandbox / isolation machinery")
    patterns = ("sandbox", "isolat", "subprocess", "spawn", "namespace", "jail")
    hits: dict[str, list[str]] = {}
    for dirpath, dirnames, filenames in os.walk(RROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), RROOT)
            low = rel.lower()
            if any(p in low for p in patterns):
                hits.setdefault("path", []).append(rel)
    for rel in sorted(hits.get("path", []))[:30]:
        print("  %s" % rel)

    hdr("[7] plugin_center.py — what Phase 3 already delivered")
    pc = os.path.join(RROOT, "api", "plugin_center.py")
    ps = os.path.join(RROOT, "api", "plugin_security.py")
    for path in (pc, ps):
        if os.path.exists(path):
            src = open(path, encoding="utf-8", errors="replace").read()
            rel = os.path.relpath(path, RROOT)
            print("  --- %s (%d bytes) ---" % (rel, len(src)))
            for m in re.finditer(r"^(?:def|class)\s+(\w+)", src, re.M):
                print("      ", m.group(1))
            if "enforce" in src:
                for m in re.finditer(r"enforce[^\n]{0,80}", src):
                    print("      enforce:", m.group(0)[:80])
                    break

    hdr("[8] plugin entry-point contract (how a plugin is loaded today)")
    cli = os.path.join(RROOT, "clisupport", "plugins.py")
    if os.path.exists(cli):
        src = open(cli, encoding="utf-8", errors="replace").read()
        print("  clisupport/plugins.py (%d bytes)" % len(src))
        for m in re.finditer(r"^\s*def\s+(\w+)", src, re.M):
            name = m.group(1)
            if any(k in name for k in ("discover", "load", "install", "enable",
                                       "disable", "remove", "reload", "register")):
                print("      def %s" % name)

    hdr("[9] gap summary")
    print("  plugin dirs           : %s" % (", ".join(find_dirs("plugins")) or "none"))
    print("  MCP-ish files         : %d" % len(mcp_files))
    print("  environment backends  : %d" % (
        len([f for f in os.listdir(env_dir) if f.endswith(".py") and f != "__init__.py"])
        if os.path.isdir(env_dir) else 0))
    usable = [k for k, v in probes.items() if v]
    print("  isolation binaries    : %s" % (", ".join(usable) or "NONE AVAILABLE"))
    print()
    print("[done] read-only; no files written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
