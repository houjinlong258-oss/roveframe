"""Phase 5 probe (1b) — why does the keyless Firecrawl vendor return 0 results?

The other three keyless vendors (exa / parallel / keenable) serve live
results with no credentials; firecrawl does not. This probe isolates the
cause: transient rate limit, dead endpoint, or a code defect in the
keyless client / response parser.

Read-only. Network egress only.

Run:  python scripts/_probe_firecrawl_keyless.py
"""
from __future__ import annotations

import os
import sys
import traceback

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")


def hdr(t: str) -> None:
    print()
    print("=" * 74)
    print(t)
    print("=" * 74)


def main() -> int:
    hdr("[1] keyless client endpoint + auth shape")
    from roveagent.plugins.web.firecrawl import provider as fcp

    client_cls = getattr(fcp, "_KeylessFirecrawlClient", None)
    print("  _KeylessFirecrawlClient:", client_cls)
    if client_cls is None:
        print("  MISSING — keyless firecrawl client not present in this tree")
        return 1

    import inspect

    try:
        src = inspect.getsource(client_cls)
        print("  --- class source (first 60 lines) ---")
        for line in src.splitlines()[:60]:
            print("   ", line)
    except Exception as exc:  # noqa: BLE001
        print("  source unavailable:", exc)

    hdr("[2] direct client.search() — raw exception, no wrapper")
    try:
        c = client_cls()
        resp = c.search(query="open source CRM", limit=2)
        print("  response type:", type(resp).__name__)
        print("  response repr (first 800):")
        print("  " + repr(resp)[:800].replace("\n", "\n  "))
    except Exception as exc:  # noqa: BLE001
        print("  RAISED %s: %s" % (type(exc).__name__, exc))
        print("  --- traceback ---")
        traceback.print_exc()

    hdr("[3] wrapper result (what the ring sees)")
    from roveagent.plugins.web.keyless_mcp import firecrawl_search_keyless

    res = firecrawl_search_keyless("open source CRM", 2)
    print("  success:", res.get("success"))
    print("  error  :", str(res.get("error"))[:600])
    web = ((res.get("data") or {}).get("web")) or []
    print("  results:", len(web))

    hdr("[4] compare: raw HTTP response from the public endpoint")
    try:
        import json
        import urllib.error
        import urllib.request

        url = getattr(fcp, "FIRECRAWL_KEYLESS_SEARCH_URL", None) or getattr(
            fcp, "_KEYLESS_SEARCH_URL", None
        )
        print("  discovered search url constant:", url)
        if url:
            body = json.dumps({"query": "open source CRM", "limit": 2}).encode()
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    raw = r.read().decode("utf-8", "replace")
                print("  HTTP status: 200")
                print("  body (first 900):")
                print("  " + raw[:900].replace("\n", "\n  "))
            except urllib.error.HTTPError as he:
                print("  HTTPError %s %s" % (he.code, he.reason))
                try:
                    print("  body:", he.read().decode("utf-8", "replace")[:700])
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        print("  raw probe failed:", type(exc).__name__, exc)

    print()
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
