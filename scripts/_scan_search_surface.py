"""Phase 5 Step 0 — read-only scan of the search surface.

No writes. Prints a compact inventory of:
  1. search/extract-like registered tools (by toolset)
  2. web_search_registry providers + their availability probe
  3. keyless MCP endpoints
  4. document RAG search path
  5. enterprise/business search path
"""
from __future__ import annotations

import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "roveagent")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NAME_PAT = re.compile(
    r"""registry\.register\(\s*(?:[^)]*?)name\s*=\s*["']([A-Za-z_0-9]+)["']""",
    re.S,
)
KEYWORDS = ("search", "extract", "crawl", "fetch", "scrape", "browse", "research", "lookup")


def section(title: str) -> None:
    print()
    print("=" * 74)
    print(title)
    print("=" * 74)


def scan_registered() -> None:
    section("[1] registered tools whose name looks search/extract-like")
    hits = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
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
                nm = m.group(1)
                if any(k in nm for k in KEYWORDS):
                    hits.append((nm, os.path.relpath(path, ROOT)))
    if not hits:
        print("  (none found via regex)")
    for nm, rel in sorted(set(hits)):
        print("  %-26s %s" % (nm, rel))


def scan_registry_api() -> None:
    section("[2] core/web_search_registry.py — public API")
    path = os.path.join(ROOT, "core", "web_search_registry.py")
    src = open(path, encoding="utf-8", errors="replace").read()
    print("  file: core/web_search_registry.py  (%d bytes)" % len(src))
    for m in re.finditer(r"^(?:class|def)\s+([A-Za-z_0-9]+)", src, re.M):
        print("    ", m.group(1))
    print()
    print("  --- register() call sites across repo ---")
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dirpath, fn)
            s = open(p, encoding="utf-8", errors="replace").read()
            if "web_search_registry" in s and "register" in s:
                rel = os.path.relpath(p, ROOT)
                if rel.replace("\\", "/") == "core/web_search_registry.py":
                    continue
                n = len(re.findall(r"register_provider|register\(", s))
                print("    %-58s hits=%d" % (rel, n))


def scan_provider_contract() -> None:
    section("[3] core/web_search_provider.py — provider contract")
    path = os.path.join(ROOT, "core", "web_search_provider.py")
    src = open(path, encoding="utf-8", errors="replace").read()
    for m in re.finditer(r"^(?:class|    def|def)\s+([A-Za-z_0-9]+)", src, re.M):
        print("    ", m.group(1))


def scan_web_plugins() -> None:
    section("[4] plugins/web/* — declared names, keyless flags, tool names")
    wdir = os.path.join(ROOT, "plugins", "web")
    for name in sorted(os.listdir(wdir)):
        p = os.path.join(wdir, name)
        if not os.path.isdir(p) or name == "__pycache__":
            continue
        prov = os.path.join(p, "provider.py")
        if not os.path.exists(prov):
            continue
        s = open(prov, encoding="utf-8", errors="replace").read()
        names = sorted(set(re.findall(r"""name\s*=\s*["']([A-Za-z_0-9]+)["']""", s)))
        tools = sorted(set(re.findall(r"""["']([a-z_0-9]*(?:search|extract|crawl|scrape|map|research)[a-z_0-9]*)["']""", s)))
        keyless = "keyless" in s.lower() or "no key" in s.lower() or "free" in s.lower()
        needs = "api_key" in s or "API_KEY" in s or "getenv" in s
        print("  %-14s names=%-38s keyless_hint=%-5s needs_key_hint=%s" % (name, ",".join(names[:4]), keyless, needs))
        print("  %-14s search-ish strings=%s" % ("", ",".join(tools[:12]) or "-"))


def scan_document_rag() -> None:
    section("[5] document / RAG search path")
    for rel in ("core/rag.py", "core/retrieval.py", "core/document_search.py", "api/app.py"):
        p = os.path.join(ROOT, *rel.split("/"))
        if os.path.exists(p):
            s = open(p, encoding="utf-8", errors="replace").read()
            found = sorted(set(re.findall(r"match_doc_chunks|query_embedding|rag_search|search_documents|similarity_search", s)))
            print("  %-34s %s" % (rel, found or "-"))
    print()
    print("  --- files mentioning match_doc_chunks ---")
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dirpath, fn)
            s = open(p, encoding="utf-8", errors="replace").read()
            if "match_doc_chunks" in s:
                print("    ", os.path.relpath(p, ROOT))


def scan_toolsets() -> None:
    section("[6] toolsets that look search-related")
    p = os.path.join(ROOT, "toolsets.py")
    if not os.path.exists(p):
        print("  MISSING toolsets.py")
        return
    s = open(p, encoding="utf-8", errors="replace").read()
    try:
        import importlib

        mod = importlib.import_module("roveagent.toolsets")
        items = getattr(mod, "TOOLSETS", None) or getattr(mod, "TOOLSET_DEFINITIONS", None)
        if isinstance(items, dict):
            for k in sorted(items):
                if any(x in k for x in ("search", "web", "research", "media", "social", "business", "knowledge")):
                    v = items[k]
                    desc = v.get("description", "") if isinstance(v, dict) else str(v)[:70]
                    print("  %-16s %s" % (k, desc[:88]))
            print("  total toolsets:", len(items))
        else:
            print("  could not introspect:", type(items))
    except Exception as exc:  # noqa: BLE001
        print("  introspect failed:", type(exc).__name__, exc)


if __name__ == "__main__":
    print("ROOT =", ROOT)
    scan_registered()
    scan_registry_api()
    scan_provider_contract()
    scan_web_plugins()
    scan_document_rag()
    scan_toolsets()
    print()
    print("[done] read-only scan complete; no files written")
