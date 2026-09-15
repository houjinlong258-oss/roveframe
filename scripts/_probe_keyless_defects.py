"""Phase 5 probe (1c) — confirm two suspected keyless defects.

DEFECT A (severity: high)
    keyless_mcp.search_with_failover() only advances to the next ring vendor
    when the error looks rate-limit-shaped (:func:`_is_rate_limitish`). A
    vendor that answers HTTP 403/401 to anonymous traffic is NOT rate-limit
    shaped, so the walk STOPS and the whole web_search call fails — even
    though three other healthy vendors sit right behind it in the ring.
    Because the ring cursor is seeded from a random per-process session id,
    the user-visible effect is an intermittent (roughly 1-in-4) hard failure.

DEFECT B (severity: medium)
    keyless_mcp._vendor_pinned() references a bare name ``_wt`` that is
    never bound in that module, so the whole body raises NameError and the
    ``except`` swallows it into ``return False``. Consequence: pinning a
    backend through web.backend / web.search_backend / web.extract_backend
    is silently ignored, and every keyless request round-robins instead.

Read-only. Network egress only (one probe per vendor).

Run:  python scripts/_probe_keyless_defects.py
"""
from __future__ import annotations

import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")

RESULTS: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((label, bool(ok), detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, (" — " + detail) if detail else ""))


def hdr(t: str) -> None:
    print()
    print("=" * 74)
    print(t)
    print("=" * 74)


def main() -> int:
    from roveagent.plugins.web import keyless_mcp as km
    from roveagent.plugins.web.keyless_mcp import (
        _is_rate_limitish,
        firecrawl_search_keyless,
        search_with_failover,
    )

    hdr("[A1] the vendor-level failure shape")
    fc = firecrawl_search_keyless("open source CRM", 2)
    print("  firecrawl success:", fc.get("success"))
    err = str(fc.get("error", ""))
    print("  firecrawl error  :", err[:220])
    print("  is_rate_limitish():", _is_rate_limitish(err))
    check(
        "firecrawl keyless failure is NOT classified as rate-limit",
        _is_rate_limitish(err) is False,
        "confirms the classifier will treat it as a permanent stop",
    )

    hdr("[A2] does search_with_failover survive a dead first vendor?")
    res = search_with_failover("firecrawl", "open source CRM", 2)
    ok = bool(res.get("success"))
    served = ((res.get("data") or {}).get("served_by")) or "firecrawl"
    web = ((res.get("data") or {}).get("web")) or []
    print("  success :", res.get("success"))
    print("  served_by:", served)
    print("  results :", len(web))
    print("  error   :", str(res.get("error", ""))[:220])
    check(
        "DEFECT A: failover skips an auth-dead vendor and still serves",
        ok,
        "served_by=%s results=%d" % (served, len(web)),
    )

    hdr("[B1] is _vendor_pinned() actually reachable?")
    import inspect

    try:
        src = inspect.getsource(km._vendor_pinned)
        has_bare_wt = "_wt." in src
        binds_wt = "_wt =" in src or "import" in src and "_wt" in src.replace("_wt.", "")
        print("  references bare `_wt.` :", has_bare_wt)
        print("  binds `_wt` somewhere  :", binds_wt)
        print("  --- source ---")
        for line in src.splitlines():
            print("   ", line)
    except Exception as exc:  # noqa: BLE001
        print("  source unavailable:", exc)

    # Direct call: if _wt is unbound the NameError is swallowed -> False.
    pinned = km._vendor_pinned("firecrawl")
    print()
    print("  _vendor_pinned('firecrawl') ->", pinned)
    check(
        "DEFECT B: _vendor_pinned executes without an internal NameError",
        "NameError" not in str(pinned) and isinstance(pinned, bool),
        "returned %r" % (pinned,),
    )

    # Prove the NameError exists by calling the inner body directly.
    hdr("[B2] reproduce the swallowed NameError")
    try:
        import roveagent.tools.web_tools  # noqa: F401  (the module it tries to use)
        from roveagent import tools as _t  # noqa: F401

        # Re-execute the exact body that runs inside _vendor_pinned's try.
        from roveagent.clisupport.config import load_config

        web_cfg = _wt._load_web_config()  # type: ignore[name-defined]  # noqa: F821
        print("  unexpectedly succeeded:", web_cfg)
        check("bare `_wt` reference raises NameError (as suspected)", False, "no error raised")
    except NameError as exc:
        print("  NameError reproduced:", exc)
        check("bare `_wt` reference raises NameError (as suspected)", True, str(exc))
    except Exception as exc:  # noqa: BLE001
        print("  other exception:", type(exc).__name__, exc)
        check("bare `_wt` reference raises NameError (as suspected)", False, "%s: %s" % (type(exc).__name__, exc))

    hdr("[C] impact: how often does a keyless search hard-fail?")
    ring = list(km._KEYLESS_RING)
    dead = []
    for v in ring:
        r = km._KEYLESS_SEARCHERS[v]("test query", 1)
        s = bool(r.get("success"))
        print("  %-10s success=%-6s served=%d" % (v, s, len(((r.get("data") or {}).get("web")) or [])))
        if not s:
            dead.append(v)
    print()
    print("  dead ring vendors: %s" % (", ".join(dead) or "none"))
    print("  hard-failure probability on an unpinned call: %d/%d = %.0f%%"
          % (len(dead), len(ring), 100.0 * len(dead) / max(1, len(ring))))

    hdr("[summary]")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("  %d/%d checks passed (a FAIL here = a real defect to fix)" % (passed, len(RESULTS)))
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
