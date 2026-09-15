"""Phase 5 verification — the knowledge-search bridge is wired and gated.

Checks the four links of the new internal-document path, each independently:

  1. REGISTRATION  the tool exists in the registry under toolset "knowledge"
  2. TOOLSET       the "knowledge" toolset resolves and is discoverable
  3. GATE POLICY   `search_knowledge` matches an EXPLICIT policy row, not the
                   catch-all `*` (which grants registered tools approval-free
                   execution — landing there would mean the tool has no policy)
  4. ADAPTER       BusinessDataLayer.search_knowledge() speaks the documented
                   request shape and enforces scope on the response envelope

Uses an injected in-memory transport, so no network and no credentials.
This proves WIRING and CONTRACT; it does not prove the upstream vector search
returns good passages (that needs a live Supabase + embeddings).

Run:  python scripts/_probe_knowledge_bridge.py
"""
from __future__ import annotations

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")

RESULTS: list[tuple[str, bool, str]] = []
TENANT = "00000000-0000-0000-0000-000000000000"
BUSINESS = "00000000-0000-0000-0000-000000000001"


def check(label: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((label, bool(ok), detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, (" — " + detail) if detail else ""))


def hdr(t: str) -> None:
    print()
    print("=" * 76)
    print(t)
    print("=" * 76)


def main() -> int:
    hdr("[1] registration + toolset membership")
    from roveagent.tools.registry import registry
    import roveagent.tools.business_data_tool  # noqa: F401  (import = register)

    entry = registry.get_entry("search_knowledge")
    check("search_knowledge is registered", entry is not None, repr(type(entry).__name__))
    if entry is not None:
        ts = getattr(entry, "toolset", None)
        check("registered under toolset 'knowledge'", ts == "knowledge", "toolset=%r" % ts)
        schema = getattr(entry, "schema", {}) or {}
        props = ((schema.get("parameters") or {}).get("properties")) or {}
        check("schema requires 'query'", "query" in props, ",".join(sorted(props)))
        check(
            "schema bounds limit to <=20",
            (props.get("limit") or {}).get("maximum") == 20,
            str((props.get("limit") or {}).get("maximum")),
        )

    hdr("[2] toolset resolution")
    from roveagent.toolsets import TOOLSETS, resolve_toolset

    check("'knowledge' toolset defined", "knowledge" in TOOLSETS, "%d toolsets total" % len(TOOLSETS))
    try:
        resolved = resolve_toolset("knowledge")
        check("resolve_toolset('knowledge') yields search_knowledge",
              "search_knowledge" in set(resolved), ",".join(sorted(resolved)))
    except Exception as exc:  # noqa: BLE001
        check("resolve_toolset('knowledge') yields search_knowledge", False,
              "%s: %s" % (type(exc).__name__, exc))

    hdr("[3] gate policy — must be an explicit row, not the catch-all")
    from roveagent.tools.framework import DEFAULT_POLICIES, EnterpriseToolGate

    gate = EnterpriseToolGate()
    policy = gate.policy_for("search_knowledge")
    print("  matched pattern   :", policy.pattern)
    print("  required permission:", policy.permission)
    print("  risk / approval   :", policy.risk, "/", policy.approval)
    check("matches an explicit row (not '*')", policy.pattern != "*", "pattern=%r" % policy.pattern)
    check("permission is knowledge:read", policy.permission == "knowledge:read",
          "permission=%r" % policy.permission)
    check("approval policy is NONE", policy.approval == "none",
          "approval=%r" % policy.approval)
    check("risk is low", str(policy.risk) == "RiskLevel.LOW" or int(policy.risk) == 0,
          "risk=%r" % policy.risk)
    check("audit forced on", bool(policy.audit) is True, "audit=%r" % policy.audit)

    # The catch-all is what a tool WITHOUT a policy row lands on.
    fallback = gate.policy_for("__no_such_tool_row__")
    check("catch-all is distinguishable", fallback.pattern == "*", "pattern=%r" % fallback.pattern)

    hdr("[4] the row is not shadowed by an earlier pattern")
    import fnmatch

    shadow = None
    for p in DEFAULT_POLICIES:
        if p.pattern == "search_knowledge":
            break
        if fnmatch.fnmatchcase("search_knowledge", p.pattern):
            shadow = p.pattern
            break
    check("no earlier pattern shadows it", shadow is None, "shadowed by %r" % shadow if shadow else "")

    hdr("[5] adapter request shape + scope enforcement (injected transport)")
    from roveagent.business.data_layer import BusinessDataLayer, BusinessDataError

    captured: dict[str, object] = {}

    def transport(operation: str, payload: dict) -> dict:
        captured["operation"] = operation
        captured["payload"] = payload
        return {
            "ok": True,
            "scope": {"tenant_id": TENANT, "business_id": BUSINESS},
            "data": {
                "query": payload["params"]["query"],
                "retrieval": "vector",
                "chunks": [
                    {"doc_id": "d1", "title": "Staff Handbook", "content": "Opening hours are 09:00-21:00.", "similarity": 0.83},
                    {"doc_id": "d2", "title": "Refund Policy", "content": "Refunds within 7 days.", "similarity": 0.71},
                ],
            },
        }

    layer = BusinessDataLayer(TENANT, BUSINESS, transport=transport)
    out = layer.search_knowledge("what are the opening hours?", 5)
    print("  operation sent :", captured.get("operation"))
    print("  params sent    :", json.dumps(captured.get("payload", {}).get("params"), ensure_ascii=False))
    print("  chunks returned:", len(out.get("chunks", [])))
    check("operation name is search_knowledge", captured.get("operation") == "search_knowledge",
          str(captured.get("operation")))
    check("query forwarded verbatim",
          (captured.get("payload") or {}).get("params", {}).get("query") == "what are the opening hours?")
    check("scope ids taken from the adapter, not the request",
          (captured.get("payload") or {}).get("tenant_id") == TENANT
          and (captured.get("payload") or {}).get("business_id") == BUSINESS)
    check("chunks parsed", len(out.get("chunks", [])) == 2, "n=%d" % len(out.get("chunks", [])))
    check("titles preserved", out["chunks"][0].get("title") == "Staff Handbook",
          str(out["chunks"][0].get("title")))

    hdr("[6] adapter refuses misuse")
    try:
        layer.search_knowledge("   ", 5)
        check("empty query rejected", False, "no error raised")
    except ValueError as exc:
        check("empty query rejected", True, str(exc)[:60])

    captured.clear()
    layer.search_knowledge("q", 999)
    sent_limit = (captured.get("payload") or {}).get("params", {}).get("limit")
    check("limit clamped to 20", sent_limit == 20, "limit=%r" % sent_limit)

    captured.clear()
    layer.search_knowledge("q", 0)
    sent_limit = (captured.get("payload") or {}).get("params", {}).get("limit")
    check("explicit limit=0 clamped up to 1 (not silently defaulted)", sent_limit == 1,
          "limit=%r" % sent_limit)

    captured.clear()
    layer.search_knowledge("q", None)  # type: ignore[arg-type]
    sent_limit = (captured.get("payload") or {}).get("params", {}).get("limit")
    check("omitted limit defaults to 5", sent_limit == 5, "limit=%r" % sent_limit)

    captured.clear()
    layer.search_knowledge("q", -3)
    sent_limit = (captured.get("payload") or {}).get("params", {}).get("limit")
    check("negative limit clamped up to 1", sent_limit == 1, "limit=%r" % sent_limit)

    def bad_scope_transport(operation: str, payload: dict) -> dict:
        return {"ok": True, "scope": {"tenant_id": "other", "business_id": BUSINESS}, "data": {}}

    try:
        BusinessDataLayer(TENANT, BUSINESS, transport=bad_scope_transport).search_knowledge("q", 3)
        check("cross-tenant response envelope rejected", False, "no error raised")
    except BusinessDataError as exc:
        check("cross-tenant response envelope rejected", True, str(exc)[:60])

    hdr("[7] tool handler shape (no live backend -> structured failure, not a crash)")
    from roveagent.tools.business_data_tool import _knowledge_handler

    # No run context in this probe, so the adapter cannot be built. The handler
    # must return a structured tool_error, never raise into the agent loop.
    raw = _knowledge_handler({"query": "opening hours", "limit": 5})
    print("  handler output (first 220):", str(raw)[:220].replace("\n", " "))
    check("handler returns a string", isinstance(raw, str))
    parsed_ok = False
    try:
        parsed = json.loads(raw)
        parsed_ok = isinstance(parsed, dict) and (
            parsed.get("error") is not None or parsed.get("chunks") is not None
        )
    except Exception:  # noqa: BLE001
        parsed_ok = False
    check("handler output is structured JSON", parsed_ok, str(raw)[:90])

    hdr("[summary]")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    for label, ok, detail in RESULTS:
        if not ok:
            print("  FAIL %-52s %s" % (label, detail))
    print()
    print("  %d/%d checks passed" % (passed, len(RESULTS)))
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
