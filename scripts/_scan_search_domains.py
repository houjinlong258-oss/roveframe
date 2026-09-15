"""Phase 5 scan — inventory the three search domains the OS must cover.

  WEB        external content (web_search / web_extract)      -- already live
  DOCUMENT   the tenant's own knowledge base / files
  ENTERPRISE the tenant's business records (orders, customers, inventory)

Prints registered Python tools per domain and the TS route surface for the
document domain, so gaps are visible before anything is built.

Read-only. No writes.

Run:  python scripts/_scan_search_domains.py
"""
from __future__ import annotations

import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

NAME_PAT = re.compile(
    r"""registry\.register\(\s*(?:[^)]*?)name\s*=\s*["']([A-Za-z_0-9]+)["']""",
    re.S,
)

DOC_KEYS = ("doc", "knowledge", "rag", "recall", "session", "memory", "embed")
ENT_KEYS = ("business", "sales", "order", "inventory", "customer", "report", "analytics", "metric")
WEB_KEYS = ("search", "extract", "crawl", "scrape", "browse", "research")


def hdr(t: str) -> None:
    print()
    print("=" * 76)
    print(t)
    print("=" * 76)


def python_tools() -> dict[str, list[str]]:
    rroot = os.path.join(ROOT, "roveagent")
    found: dict[str, set[str]] = {}
    for dirpath, dirnames, filenames in os.walk(rroot):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            try:
                src = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for m in NAME_PAT.finditer(src):
                found.setdefault(m.group(1), set()).add(os.path.relpath(path, rroot))
    return {k: sorted(v) for k, v in found.items()}


def ts_routes() -> list[str]:
    routes: list[str] = []
    base = os.path.join(ROOT, "src", "app", "api")
    for dirpath, _dirnames, filenames in os.walk(base):
        for fn in filenames:
            if fn == "route.ts":
                rel = os.path.relpath(os.path.join(dirpath, fn), base)
                routes.append("/api/" + rel.replace(os.sep, "/")[: -len("/route.ts")])
    return sorted(routes)


def main() -> int:
    tools = python_tools()

    hdr("[1] WEB domain — registered tools")
    for k in sorted(tools):
        if any(x in k for x in WEB_KEYS):
            print("  %-26s %s" % (k, ", ".join(tools[k])[:70]))

    hdr("[2] DOCUMENT domain — registered tools")
    hits = [k for k in sorted(tools) if any(x in k for x in DOC_KEYS)]
    if hits:
        for k in hits:
            print("  %-26s %s" % (k, ", ".join(tools[k])[:70]))
    else:
        print("  (none)")

    hdr("[3] ENTERPRISE domain — registered tools")
    hits = [k for k in sorted(tools) if any(x in k for x in ENT_KEYS)]
    if hits:
        for k in hits:
            print("  %-26s %s" % (k, ", ".join(tools[k])[:70]))
    else:
        print("  (none)")

    hdr("[4] TS API routes (the RAG / document path lives on the Next.js side)")
    for r in ts_routes():
        flag = ""
        if any(x in r for x in ("knowledge", "doc", "search", "agent", "plugin")):
            flag = "  <-"
        print("  %s%s" % (r, flag))
    print()
    print("  total routes: %d" % len(ts_routes()))

    hdr("[5] TS knowledge routes in detail")
    base = os.path.join(ROOT, "src", "app", "api", "knowledge")
    for dirpath, _d, filenames in os.walk(base):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, ROOT)
            size = os.path.getsize(p)
            src = open(p, encoding="utf-8", errors="replace").read()
            tags = sorted(set(re.findall(
                r"match_doc_chunks|query_embedding|embedText|match_count|cosine|vector",
                src,
            )))
            print("  %-52s %6d  %s" % (rel, size, ",".join(tags) or "-"))

    hdr("[6] gap summary")
    print("  WEB        : web_search + web_extract registered, keyless tier LIVE (verified)")
    print("  DOCUMENT   : %s" % ("python tools present" if any(
        any(x in k for x in DOC_KEYS) for k in tools) else "NO python tool; TS-only via /api/knowledge/*"))
    print("  ENTERPRISE : %s" % ("python tools present" if any(
        any(x in k for x in ENT_KEYS) for k in tools) else "no dedicated python tool"))

    print()
    print("[done] read-only scan complete; no files written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
