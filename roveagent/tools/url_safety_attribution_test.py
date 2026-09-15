"""Regression tests for URL block attribution (tools/url_safety).

Context — the defect this covers:

``web_extract`` refused a URL a live search had just returned, reporting
"Blocked: URL targets a private or internal network address". The URL was a
public blog. The real cause was that the machine's resolver is a fake-IP style
proxy: it answers public hostnames with synthetic addresses from 198.18.0.0/15
(RFC 2544 benchmarking) and a made-up IPv6 prefix, then tunnels the traffic.
The SSRF guard refusing those addresses is CORRECT — allowing them would be an
SSRF hole — but the message named the wrong cause, sending the operator after a
bug that did not exist.

``classify_url_block`` supplies the missing attribution. These tests pin two
properties that matter:

  1. It never disagrees with ``is_safe_url``. Attribution must not become a
     second, softer authority.
  2. It distinguishes resolver artifacts (fake-IP / DNS interception) from
     genuine private targets and cloud metadata, because those need opposite
     remedies.

Hermetic: ``socket.getaddrinfo`` is patched, so no DNS and no network.

Run:  python -m pytest roveagent/tools/url_safety_attribution_test.py -q
"""
from __future__ import annotations

import os
import socket
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.tools import url_safety as us  # noqa: E402


def _addrinfo(*ips: str):
    """Build a getaddrinfo-shaped result for the given address strings."""
    out = []
    for ip in ips:
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        out.append((family, socket.SOCK_STREAM, 6, "", (ip, 0)))
    return out


def _resolves_to(*ips: str):
    return mock.patch.object(us.socket, "getaddrinfo", return_value=_addrinfo(*ips))


class AttributionAgreesWithEnforcementTest(unittest.TestCase):
    """Property 1: attribution is never softer than the guard."""

    CASES = (
        ("https://example.com/", ("104.20.23.154",)),
        ("https://github.com/", ("198.18.1.43", "fdfe:dcba:9876::12")),
        ("https://example.com/", ("104.20.23.154", "fdfe:dcba:9876::15")),
        ("http://127.0.0.1:8788/", ("127.0.0.1",)),
        ("http://10.0.0.1/", ("10.0.0.1",)),
        ("http://192.168.1.5/", ("192.168.1.5",)),
        ("http://169.254.169.254/latest/meta-data/", ("169.254.169.254",)),
        ("http://100.64.0.7/", ("100.64.0.7",)),
        ("ftp://example.com/", ("104.20.23.154",)),
    )

    def test_blocked_flag_matches_is_safe_url(self) -> None:
        for url, ips in self.CASES:
            with self.subTest(url=url, ips=ips), _resolves_to(*ips):
                enforced = us.is_safe_url(url)
                attributed = us.classify_url_block(url)
                self.assertEqual(
                    attributed.blocked, not enforced,
                    "attribution and enforcement disagree for %s -> %s" % (url, ips),
                )

    def test_async_wrapper_matches_sync(self) -> None:
        import asyncio

        for url, ips in self.CASES:
            with self.subTest(url=url, ips=ips), _resolves_to(*ips):
                sync = us.classify_url_block(url)
                asyn = asyncio.run(us.async_classify_url_block(url))
                self.assertEqual(sync.blocked, asyn.blocked)
                self.assertEqual(sync.code, asyn.code)


class AttributionTaxonomyTest(unittest.TestCase):
    """Property 2: the codes name the right cause."""

    def test_public_host_is_ok(self) -> None:
        with _resolves_to("104.20.23.154"):
            r = us.classify_url_block("https://example.com/")
        self.assertFalse(r.blocked)
        self.assertEqual(r.code, "ok")

    def test_fakeip_only_is_resolver_synthetic(self) -> None:
        """The confirmed case: a public blog answered with a benchmark-range address."""
        with _resolves_to("198.18.0.5", "fdfe:dcba:9876::11"):
            r = us.classify_url_block("https://forgeworkflows.com/blog/post")
        self.assertTrue(r.blocked)
        self.assertEqual(r.code, "resolver_synthetic")
        self.assertIn("fake-IP", r.hint)
        self.assertIn("198.18.0.5", r.detail)

    def test_mixed_global_and_reserved_is_resolver_mixed(self) -> None:
        with _resolves_to("104.20.23.154", "172.66.147.243", "fdfe:dcba:9876::15"):
            r = us.classify_url_block("https://example.com/")
        self.assertTrue(r.blocked)
        self.assertEqual(r.code, "resolver_mixed")
        self.assertIn("DNS-rebinding", r.detail)

    def test_genuine_private_is_not_labelled_an_artifact(self) -> None:
        with _resolves_to("10.1.2.3"):
            r = us.classify_url_block("https://internal.corp/")
        self.assertTrue(r.blocked)
        self.assertEqual(r.code, "resolver_private")
        self.assertNotIn("fake-IP", r.detail)

    def test_metadata_wins_over_everything(self) -> None:
        with _resolves_to("169.254.169.254"):
            r = us.classify_url_block("http://metadata/")
        self.assertEqual(r.code, "metadata_ip")

    def test_metadata_hostname_blocked_without_dns(self) -> None:
        with mock.patch.object(us.socket, "getaddrinfo") as gai:
            r = us.classify_url_block("http://metadata.google.internal/")
        self.assertEqual(r.code, "blocked_hostname")
        gai.assert_not_called()

    def test_non_http_scheme(self) -> None:
        with mock.patch.object(us.socket, "getaddrinfo") as gai:
            r = us.classify_url_block("ftp://example.com/")
        self.assertEqual(r.code, "scheme")
        gai.assert_not_called()

    def test_dns_failure_is_reported_as_such(self) -> None:
        with mock.patch.object(us.socket, "getaddrinfo", side_effect=socket.gaierror("nope")), \
             mock.patch.object(us, "_proxy_is_configured", return_value=False):
            r = us.classify_url_block("https://does-not-exist.invalid/")
        self.assertTrue(r.blocked)
        self.assertEqual(r.code, "dns_failure")

    def test_dns_failure_with_proxy_is_delegated(self) -> None:
        with mock.patch.object(us.socket, "getaddrinfo", side_effect=socket.gaierror("nope")), \
             mock.patch.object(us, "_proxy_is_configured", return_value=True):
            r = us.classify_url_block("https://example.com/")
        self.assertFalse(r.blocked)
        self.assertEqual(r.code, "dns_delegated")

    def test_unexpected_error_fails_closed(self) -> None:
        with mock.patch.object(us, "urlparse", side_effect=RuntimeError("boom")):
            r = us.classify_url_block("https://example.com/")
        self.assertTrue(r.blocked)
        self.assertEqual(r.code, "error")


class SafeByDefaultTest(unittest.TestCase):
    """The artifact ranges must stay blocked — attribution is not a bypass."""

    def test_synthetic_ranges_are_refused(self) -> None:
        for ip in ("198.18.0.1", "198.19.255.255", "fdfe:dcba:9876::1", "2001::1"):
            with self.subTest(ip=ip), _resolves_to(ip):
                self.assertFalse(
                    us.is_safe_url("https://public.example/"),
                    "%s must stay blocked; adding it to a bypass list is an SSRF hole" % ip,
                )

    def test_classifier_never_reports_an_artifact_range_as_global(self) -> None:
        for ip in ("198.18.0.1", "198.19.255.255", "fdfe:dcba:9876::1", "2001::1"):
            with self.subTest(ip=ip):
                bucket = us._classify_resolved_ip(__import__("ipaddress").ip_address(ip))
                self.assertEqual(bucket, "artifact", "%s classified as %s" % (ip, bucket))

    def test_error_dict_shape_is_json_safe(self) -> None:
        import json

        with _resolves_to("198.18.0.5"):
            d = us.classify_url_block("https://example.com/").as_error_dict()
        self.assertIn("error", d)
        self.assertIn("code", d)
        json.dumps(d)  # must not raise


if __name__ == "__main__":
    unittest.main()
