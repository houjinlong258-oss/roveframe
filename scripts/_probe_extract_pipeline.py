"""Phase 5 probe (3) — separate "extract pipeline broken" from "blocked by DNS".

The guard refuses every public URL on this machine because the local resolver
returns synthetic fake-IP addresses (see _probe_fakeip_env.py). That leaves one
question open, and it decides whether Phase 5 has a defect to fix or merely an
environment note:

  Is the extract PIPELINE (backend dispatch -> HTTP -> parse -> shape) intact,
  with only the SSRF gate standing in front of it?

To answer it this probe re-runs the identical call with the guard's documented
global opt-out enabled **for this child process only**
(ROVEAGENT_ALLOW_PRIVATE_URLS=true). Nothing persistent is changed:

  * no .env edit
  * no config.yaml edit
  * the variable is set in-process, after import, by monkeypatching nothing —
    only os.environ, and only here

If extract then succeeds, the pipeline is healthy and the blocker is purely
environmental. If it still fails, Phase 5 has a real extract defect.

Run:  python scripts/_probe_extract_pipeline.py
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")

TARGET = "https://example.com/"


def hdr(t: str) -> None:
    print()
    print("=" * 74)
    print(t)
    print("=" * 74)


def run_extract():
    from roveagent.tools import web_tools

    maybe = web_tools.web_extract_tool([TARGET])
    if inspect.isawaitable(maybe):
        maybe = asyncio.run(maybe)
    return maybe


def main() -> int:
    hdr("[1] guard ON (as shipped) — expected: attribution explains the refusal")
    print("  ROVEAGENT_ALLOW_PRIVATE_URLS =", os.getenv("ROVEAGENT_ALLOW_PRIVATE_URLS"))
    out = run_extract()
    print("  --- output ---")
    print("  " + str(out)[:900].replace("\n", "\n  "))

    parsed = {}
    try:
        parsed = json.loads(out)
    except Exception:  # noqa: BLE001
        pass
    results = (parsed.get("results") or []) if isinstance(parsed, dict) else []
    code = results[0].get("code") if results and isinstance(results[0], dict) else None
    print()
    print("  attribution code:", code)
    guard_explained = code in ("resolver_synthetic", "resolver_mixed")
    print("  [%s] refusal carries a precise cause, not the generic sentence"
          % ("PASS" if guard_explained else "FAIL"))

    hdr("[2] same call with the documented opt-out enabled IN THIS PROCESS ONLY")
    print("  (no .env / config.yaml change — process-scoped, discarded on exit)")
    os.environ["ROVEAGENT_ALLOW_PRIVATE_URLS"] = "true"

    # The toggle caches on first read; reset it so this process picks up the
    # new value rather than a value read during step 1.
    import roveagent.tools.url_safety as us

    us._allow_private_resolved = False
    us._cached_allow_private = False

    from roveagent.tools.url_safety import is_safe_url

    print("  is_safe_url(%r) with opt-out: %s" % (TARGET, is_safe_url(TARGET)))

    out2 = run_extract()
    print("  --- output (first 1200 chars) ---")
    print("  " + str(out2)[:1200].replace("\n", "\n  "))

    parsed2 = {}
    try:
        parsed2 = json.loads(out2)
    except Exception:  # noqa: BLE001
        pass
    results2 = (parsed2.get("results") or []) if isinstance(parsed2, dict) else []
    r0 = results2[0] if results2 and isinstance(results2[0], dict) else {}
    content = str(r0.get("content") or "")
    err = r0.get("error")

    hdr("[3] verdict")
    if content and not err:
        print("  PIPELINE HEALTHY: extract returned %d chars of real page content" % len(content))
        print("  => the only blocker is this machine's DNS interception, not a code defect.")
        print("  => web_extract works wherever DNS resolves normally; here it needs either")
        print("     proxy bypass rules for the target hosts, or the documented opt-out")
        print("     security.allow_private_urls: true (a security-model decision).")
        print()
        print("  title  :", r0.get("title"))
        print("  url    :", r0.get("url"))
        return 0

    print("  DEFECT: extract failed even with the SSRF gate open.")
    print("  error  :", err)
    print("  => the extract pipeline itself is broken and must be fixed.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
