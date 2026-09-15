"""Phase 5 probe (2b) — confirm the local resolver is a fake-IP proxy.

Hypothesis: this machine sits behind a fake-IP style proxy/tunnel (the
Clash / Surge / mihomo family). Those resolvers answer EVERY hostname with a
synthetic address from a reserved range — classically 198.18.0.0/15
(RFC 2544 benchmarking) plus a made-up IPv6 prefix — and then route the real
connection through their own tunnel, recovering the true destination from the
hostname. Consequences:

  * Outbound HTTPS works normally (the tunnel handles it).
  * tools/url_safety.is_safe_url() blocks those synthetic addresses, which is
    CORRECT — 198.18.0.0/15 must never be reachable in an SSRF-safe client.
  * Therefore web_extract fails closed for essentially every public URL, with
    a message ("targets a private or internal network address") that names the
    wrong cause: the URL is public; the LOCAL RESOLVER is synthetic.

Discriminators used here:
  1. Do unrelated public hosts collapse onto the same reserved ranges?
  2. Does an HTTPS request to such an address actually SUCCEED? If yes, a
     transparent tunnel is carrying the traffic and explanation (2) holds.
  3. What ranges do the answers fall into, per ipaddress classification?

Read-only. Network egress only.

Run:  python scripts/_probe_fakeip_env.py
"""
from __future__ import annotations

import ipaddress
import os
import socket
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

HOSTS = [
    "example.com",
    "github.com",
    "forgeworkflows.com",
    "mcp.exa.ai",
    "api.firecrawl.dev",
    "search.parallel.ai",
    "api.keenable.ai",
    "www.wikipedia.org",
]

# Ranges that a *transparent fake-IP resolver* typically hands out. None of
# these are routable destinations; seeing several unrelated hosts collapse
# into one of them is the signature we are looking for.
FAKEIP_RANGES = {
    "198.18.0.0/15": "RFC 2544 benchmarking (Clash/mihomo default fake-ip pool)",
    "198.19.0.0/16": "RFC 2544 benchmarking (upper half)",
    "fdfe:dcba:9876::/48": "synthetic IPv6 prefix used by fake-ip resolvers",
    "2001::/32": "Teredo — commonly injected by DNS interception",
}

ALWAYS_BLOCKED_HINT = {
    "127.0.0.0/8": "loopback",
    "10.0.0.0/8": "private",
    "172.16.0.0/12": "private",
    "192.168.0.0/16": "private",
    "169.254.0.0/16": "link-local / cloud metadata",
    "100.64.0.0/10": "CGNAT",
    "0.0.0.0/8": "this-network",
    "::1/128": "loopback v6",
    "fc00::/7": "unique-local v6",
}


def classify(ip_str: str) -> str:
    raw = ip_str.split("%")[0]
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return "unparseable"
    for cidr, label in FAKEIP_RANGES.items():
        if ip in ipaddress.ip_network(cidr):
            return "FAKE-IP(%s)" % label
    for cidr, label in ALWAYS_BLOCKED_HINT.items():
        if ip in ipaddress.ip_network(cidr):
            return "blocked(%s)" % label
    if ip.is_global:
        return "global"
    return "non-global"


def resolve(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        return sorted({i[4][0] for i in infos})
    except Exception as exc:  # noqa: BLE001
        return ["ERR:%s" % type(exc).__name__]


def main() -> int:
    print()
    print("=" * 78)
    print("[1] resolution of unrelated public hosts — do they collapse?")
    print("=" * 78)
    fake_hits = 0
    global_hits = 0
    for h in HOSTS:
        ips = resolve(h)
        labels = [classify(i) for i in ips]
        if any(l.startswith("FAKE-IP") for l in labels):
            fake_hits += 1
        if any(l == "global" for l in labels):
            global_hits += 1
        print("  %-24s %s" % (h, ", ".join("%s=%s" % (i, l) for i, l in zip(ips, labels))))

    print()
    print("=" * 78)
    print("[2] does HTTPS to a synthetic address actually reach the internet?")
    print("=" * 78)
    # If traffic were really going to 198.18.1.43 there would be no server to
    # answer. A 200 from the *hostname* proves a tunnel is recovering the true
    # destination from SNI/Host and carrying the request.
    for url in ("https://example.com/", "https://api.github.com/"):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "roveframe-probe"})
            with urllib.request.urlopen(req, timeout=20) as r:
                print("  %-28s HTTP %s (%d bytes)" % (url, r.status, len(r.read(2048))))
        except Exception as exc:  # noqa: BLE001
            print("  %-28s FAILED %s: %s" % (url, type(exc).__name__, str(exc)[:110]))

    print()
    print("=" * 78)
    print("[3] environment proxy hints")
    print("=" * 78)
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        v = os.getenv(var)
        if v:
            print("  %-12s = %s" % (var, v))
    print("  (empty means no proxy env var — consistent with a TRANSPARENT"
          " tunnel that intercepts DNS and connects on the host's behalf)")

    print()
    print("=" * 78)
    print("[4] verdict")
    print("=" * 78)
    if fake_hits and global_hits == 0:
        print("  FAKE-IP RESOLVER CONFIRMED: %d/%d hosts answered inside a reserved"
              % (fake_hits, len(HOSTS)))
        print("  range and none answered with a routable global address.")
        print()
        print("  => tools/url_safety.is_safe_url() is behaving CORRECTLY. Blocking")
        print("     198.18.0.0/15 is required: adding it to an allowlist would be an")
        print("     SSRF hole. The defect is the ERROR MESSAGE, which blames the URL")
        print("     ('private or internal network address') when the true cause is the")
        print("     local resolver fabricating addresses.")
    elif fake_hits:
        print("  MIXED: %d/%d hosts synthetic, %d/%d resolved globally."
              % (fake_hits, len(HOSTS), global_hits, len(HOSTS)))
        print("  => guard blocks only the synthetic subset; behaviour depends on which")
        print("     upstream DNS answer wins the race, so web_extract is FLAKY.")
    else:
        print("  NOT a fake-IP environment: no synthetic-range answers observed.")
        print("  => investigate is_safe_url() directly for an over-blocking defect.")
    print()
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
