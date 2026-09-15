"""Phase 5 probe (2) — is the SSRF guard over-blocking, or is the URL dead?

web_extract returned "Blocked: URL targets a private or internal network
address" for a URL that a live search had just returned. Two competing
explanations:

  (a) DEFECT — tools/url_safety.is_safe_url() rejects legitimate public hosts.
  (b) EXPECTED — the host genuinely does not resolve from this machine, and
      the guard's documented fail-closed DNS policy blocks it.

The discriminator is raw DNS: resolve both the suspect host and several
unambiguously-public hosts and compare. This probe makes no repo writes.

Run:  python scripts/_probe_ssrf_guard.py
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("ROVEAGENT_TEST_MODE", "true")

SUSPECT = "https://forgeworkflows.com/blog/ai-business-os-platforms-what-we-got-wrong"
PUBLIC = [
    "https://example.com/",
    "https://www.wikipedia.org/",
    "https://github.com/",
    "https://en.wikipedia.org/wiki/Operating_system",
]
PRIVATE_SHOULD_BLOCK = [
    "http://127.0.0.1:8788/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://localhost:5000/",
]


def hdr(t: str) -> None:
    print()
    print("=" * 74)
    print(t)
    print("=" * 74)


def dns(host: str) -> str:
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        ips = sorted({i[4][0] for i in infos})
        return "OK " + ", ".join(ips[:4])
    except Exception as exc:  # noqa: BLE001
        return "FAIL %s: %s" % (type(exc).__name__, exc)


def main() -> int:
    from urllib.parse import urlparse

    from roveagent.tools.url_safety import _global_allow_private_urls, _proxy_is_configured, is_safe_url

    hdr("[1] guard environment")
    print("  allow_private_urls toggle :", _global_allow_private_urls())
    print("  proxy configured          :", _proxy_is_configured())
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY"):
        print("  %-12s = %r" % (var, os.getenv(var)))

    hdr("[2] raw DNS for the suspect host vs known-public hosts")
    susp_host = urlparse(SUSPECT).hostname
    print("  SUSPECT %-34s -> %s" % (susp_host, dns(susp_host)))
    for u in PUBLIC:
        h = urlparse(u).hostname
        print("  PUBLIC  %-34s -> %s" % (h, dns(h)))

    hdr("[3] guard verdicts for public URLs  (expect: all True)")
    public_fail = []
    for u in PUBLIC:
        ok = is_safe_url(u)
        print("  %-6s %s" % (ok, u))
        if not ok:
            public_fail.append(u)
    print()
    print("  suspect URL verdict:", is_safe_url(SUSPECT))

    hdr("[4] guard verdicts for private/metadata URLs  (expect: all False)")
    private_fail = []
    for u in PRIVATE_SHOULD_BLOCK:
        ok = is_safe_url(u)
        print("  %-6s %s   (blocked=%s)" % (ok, u, not ok))
        if ok:
            private_fail.append(u)

    hdr("[5] async wrapper parity")
    async def _run() -> list[bool]:
        from roveagent.tools.url_safety import async_is_safe_url

        return [await async_is_safe_url(u) for u in PUBLIC]

    a = asyncio.run(_run())
    print("  async_is_safe_url(public):", a)

    hdr("[6] attribution layer — classify_url_block() on every case")
    from roveagent.tools.url_safety import classify_url_block

    for u in [SUSPECT] + PUBLIC + PRIVATE_SHOULD_BLOCK:
        r = classify_url_block(u)
        print("  %-78s" % u[:78])
        print("    blocked=%-6s code=%-19s" % (r.blocked, r.code))
        print("    detail : %s" % r.detail[:150])
        if r.hint:
            print("    hint   : %s" % r.hint[:150])
        if r.addresses:
            print("    resolved: %s" % ", ".join("%s=%s" % (a, b) for a, b in r.addresses[:4]))

    hdr("[7] attribution agrees with enforcement on every case")
    import asyncio as _aio

    from roveagent.tools.url_safety import async_is_safe_url

    async def _parity() -> list[tuple[str, bool, bool, str]]:
        out = []
        for u in [SUSPECT] + PUBLIC + PRIVATE_SHOULD_BLOCK:
            enforced = await async_is_safe_url(u)
            att = await _aio.to_thread(classify_url_block, u)
            out.append((u, enforced, att.blocked, att.code))
        return out

    mismatches = []
    for u, enforced, attributed, code in _aio.run(_parity()):
        agree = enforced == (not attributed)
        print("  %-6s enforced=%-6s blocked=%-6s code=%-19s %s"
              % ("OK" if agree else "DIFF", enforced, attributed, code, u[:58]))
        if not agree:
            mismatches.append(u)
    print()
    print("  mismatches:", mismatches or "none")

    hdr("[8] verdict")
    verdict = []
    if public_fail:
        verdict.append(
            "NOTE: the guard refuses %d public host(s) — attribution must show WHY "
            "(expected code resolver_synthetic / resolver_mixed here, NOT a guard bug)"
            % len(public_fail)
        )
    else:
        verdict.append("guard allowed every public host tested")
    if mismatches:
        verdict.append("DEFECT: attribution disagrees with enforcement: %s" % mismatches)
    else:
        verdict.append("attribution agrees with enforcement on all %d cases"
                       % (len(PUBLIC) + len(PRIVATE_SHOULD_BLOCK) + 1))
    if private_fail:
        verdict.append("SSRF HOLE: guard allowed private targets: %s" % private_fail)
    else:
        verdict.append("guard correctly blocks private/metadata targets")

    for v in verdict:
        print("  -", v)
    print()
    print("[done]")
    return 1 if (private_fail or mismatches) else 0


if __name__ == "__main__":
    raise SystemExit(main())
