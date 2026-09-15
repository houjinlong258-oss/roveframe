"""Regression tests for the keyless web ring's failover and vendor health.

Context — two defects confirmed with live evidence on 2026-09-12:

DEFECT A. ``search_with_failover`` advanced to the next ring vendor only when
the error looked rate-limit-shaped. A vendor that withdraws its anonymous tier
answers HTTP 403 to every request (Firecrawl's public endpoint does exactly
this now), which is not rate-limit shaped, so the walk stopped and the whole
``web_search`` call failed. Because the ring cursor is seeded from a random
per-process session id, users saw an intermittent ~1-in-4 hard failure while
three healthy vendors sat behind the dead one.

DEFECT B. ``_vendor_pinned`` read a bare ``_wt`` that was never bound in the
module, so it raised NameError on every call and the surrounding ``except``
swallowed it into ``return False``. An explicit ``web.backend: <vendor>`` pin
was therefore silently ignored.

These tests are hermetic: no network. The vendor callables are replaced with
stubs, and DNS/config reads are patched where the code under test consults
them.

Run:  python -m pytest roveagent/plugins/web/keyless_mcp_test.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from roveagent.plugins.web import keyless_mcp as km  # noqa: E402

FIRECRAWL_403 = (
    "Keyless Firecrawl search failed: Client error '403 Forbidden' for url "
    "'https://api.firecrawl.dev/v2/search'. Set FIRECRAWL_API_KEY "
    "(https://firecrawl.dev) or another web backend."
)
THROTTLE_429 = "Keyless Exa search failed: 429 Too Many Requests — rate limit exceeded."
MALFORMED_400 = "Keyless Parallel search failed: 400 Bad Request — invalid query parameter."


def _ok(vendor: str, n: int = 2) -> dict:
    return {
        "success": True,
        "data": {"web": [{"title": "t%d" % i, "url": "https://e/%d" % i} for i in range(n)]},
    }


def _err(message: str) -> dict:
    return {"success": False, "error": message}


class FailoverClassifierTest(unittest.TestCase):
    """The classifier that decides whether the ring walks past a vendor."""

    def test_rate_limit_fails_over(self) -> None:
        self.assertTrue(km._should_failover(THROTTLE_429))

    def test_auth_403_fails_over(self) -> None:
        """DEFECT A's core assertion: a withdrawn free tier must not stop the walk."""
        self.assertTrue(km._should_failover(FIRECRAWL_403))
        self.assertFalse(km._is_rate_limitish(FIRECRAWL_403), "403 is not rate-limit shaped")

    def test_outage_and_billing_fail_over(self) -> None:
        for msg in (
            "503 Service Unavailable",
            "502 Bad Gateway",
            "connection refused",
            "402 Payment Required",
            "insufficient credit",
            "invalid api key",
            "401 Unauthorized",
        ):
            with self.subTest(msg=msg):
                self.assertTrue(km._should_failover(msg))

    def test_query_shaped_error_stops_the_walk(self) -> None:
        """Every vendor would reject the same request; walking only adds latency."""
        self.assertFalse(km._should_failover(MALFORMED_400))

    def test_query_shape_wins_over_vendor_marker(self) -> None:
        """A message carrying both must be read as query-shaped, not vendor-shaped.

        Walking the ring on a malformed request would multiply latency and then
        report another vendor's error, burying the real "your query is bad"
        signal.
        """
        self.assertFalse(km._should_failover("400 Bad Request: rate limit exceeded"))
        self.assertFalse(km._should_failover("400 Bad Request — 429 Too Many Requests"))
        self.assertFalse(km._should_failover("invalid query: 403 Forbidden"))

    def test_query_shaped_classifier_used_directly(self) -> None:
        self.assertTrue(km._is_query_shaped(MALFORMED_400))
        self.assertFalse(km._is_query_shaped(FIRECRAWL_403))
        self.assertFalse(km._is_query_shaped(""))

    def test_unknown_error_stays_fail_closed(self) -> None:
        """Only the two confirmed vendor-level classes join the failover set."""
        self.assertFalse(km._should_failover("something inexplicable happened"))
        self.assertFalse(km._should_failover(""))


class SearchFailoverBehaviourTest(unittest.TestCase):
    """End-to-end ring behaviour with stubbed vendors."""

    def setUp(self) -> None:
        # Isolate from real config and from cooldowns left by other tests.
        self._tier = mock.patch.object(km, "provider_tier", return_value="auto")
        self._tier.start()
        self.addCleanup(self._tier.stop)
        self._pin = mock.patch.object(km, "_vendor_pinned", return_value=False)
        self._pin.start()
        self.addCleanup(self._pin.stop)
        km._vendor_until.clear()
        self.addCleanup(km._vendor_until.clear)

    def _stub(self, mapping: dict) -> mock._patch:
        patcher = mock.patch.dict(km._KEYLESS_SEARCHERS, mapping, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        return patcher

    def test_dead_first_vendor_yields_a_serving_vendor(self) -> None:
        """The exact DEFECT A scenario, now asserted as required behaviour."""
        self._stub({
            "firecrawl": lambda q, l: _err(FIRECRAWL_403),
            "keenable": lambda q, l: _ok("keenable"),
        })
        with mock.patch.object(km, "_ring_order", return_value=["firecrawl", "keenable"]):
            res = km.search_with_failover("firecrawl", "q", 2)

        self.assertTrue(res.get("success"), res)
        self.assertEqual(res["data"].get("served_by"), "keenable")
        self.assertEqual(len(res["data"]["web"]), 2)

    def test_throttled_vendor_still_fails_over(self) -> None:
        self._stub({
            "exa": lambda q, l: _err(THROTTLE_429),
            "parallel": lambda q, l: _ok("parallel"),
        })
        with mock.patch.object(km, "_ring_order", return_value=["exa", "parallel"]):
            res = km.search_with_failover("exa", "q", 2)

        self.assertTrue(res.get("success"), res)
        self.assertEqual(res["data"].get("served_by"), "parallel")

    def test_query_shaped_error_does_not_walk(self) -> None:
        calls: list[str] = []

        def _record(vendor: str):
            def _fn(q, l):
                calls.append(vendor)
                return _err(MALFORMED_400)
            return _fn

        self._stub({v: _record(v) for v in ("exa", "parallel", "keenable")})
        with mock.patch.object(km, "_ring_order", return_value=["exa", "parallel", "keenable"]):
            res = km.search_with_failover("exa", "q", 2)

        self.assertFalse(res.get("success"))
        self.assertEqual(calls, ["exa"], "a malformed query must not be retried per vendor")

    def test_all_vendors_dead_reports_every_vendor(self) -> None:
        self._stub({v: (lambda q, l: _err(FIRECRAWL_403)) for v in ("exa", "parallel", "firecrawl", "keenable")})
        with mock.patch.object(km, "_ring_order", return_value=["exa", "parallel", "firecrawl", "keenable"]):
            res = km.search_with_failover("exa", "q", 2)

        self.assertFalse(res.get("success"))
        self.assertIn("all keyless vendors unavailable", res["error"])
        for v in ("exa", "parallel", "firecrawl", "keenable"):
            self.assertIn(v, res["error"])


class VendorCooldownTest(unittest.TestCase):
    """A vendor that cannot serve should not be retried on every rotation."""

    def setUp(self) -> None:
        km._vendor_until.clear()
        self.addCleanup(km._vendor_until.clear)

    def test_auth_failure_parks_the_vendor(self) -> None:
        km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        self.assertTrue(km._vendor_cooling_down("firecrawl"))
        self.assertFalse(km._vendor_cooling_down("keenable"))

    def test_throttle_parks_briefly(self) -> None:
        km._mark_vendor_failure("exa", THROTTLE_429)
        remaining = km._vendor_health_snapshot().get("exa", 0)
        self.assertTrue(km._vendor_cooling_down("exa"))
        self.assertLessEqual(remaining, km._RATE_LIMIT_COOLDOWN_SECONDS + 1)

    def test_auth_park_is_longer_than_throttle_park(self) -> None:
        km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        km._mark_vendor_failure("exa", THROTTLE_429)
        snap = km._vendor_health_snapshot()
        self.assertGreater(snap["firecrawl"], snap["exa"])

    def test_unknown_error_does_not_park(self) -> None:
        km._mark_vendor_failure("exa", "something inexplicable")
        self.assertFalse(km._vendor_cooling_down("exa"))

    def test_success_clears_a_park(self) -> None:
        km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        self.assertTrue(km._vendor_cooling_down("firecrawl"))
        km._mark_vendor_healthy("firecrawl")
        self.assertFalse(km._vendor_cooling_down("firecrawl"))

    def test_expired_park_lifts(self) -> None:
        with mock.patch.object(km, "_VENDOR_COOLDOWN_SECONDS", -1.0):
            km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        self.assertFalse(km._vendor_cooling_down("firecrawl"))

    def test_cooldown_can_be_disabled_by_env(self) -> None:
        km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        with mock.patch.dict(os.environ, {"ROVEAGENT_KEYLESS_VENDOR_COOLDOWN": "0"}):
            self.assertFalse(km._vendor_cooling_down("firecrawl"))

    def test_parked_vendors_are_demoted_not_dropped(self) -> None:
        """The ring must never be emptied by cooldown bookkeeping."""
        km._mark_vendor_failure("firecrawl", FIRECRAWL_403)
        with mock.patch.object(km, "provider_tier", return_value="auto"), \
             mock.patch.object(km, "_vendor_pinned", return_value=False):
            order = km._ring_order("exa")
        self.assertIn("firecrawl", order, "a parked vendor must remain reachable")
        self.assertEqual(order[-1], "firecrawl", "a parked vendor is demoted to the back")

    def test_every_vendor_parked_falls_back_to_full_order(self) -> None:
        for v in km._KEYLESS_RING:
            km._mark_vendor_failure(v, FIRECRAWL_403)
        with mock.patch.object(km, "provider_tier", return_value="auto"), \
             mock.patch.object(km, "_vendor_pinned", return_value=False):
            order = km._ring_order("exa")
        self.assertEqual(len(order), len(km._KEYLESS_RING))
        self.assertEqual(set(order), set(km._KEYLESS_RING))


class VendorPinnedTest(unittest.TestCase):
    """DEFECT B: the pin lookup must actually execute.

    These patch the real submodule's attribute rather than ``sys.modules``.
    Patching ``sys.modules["roveagent.tools.web_tools"]`` is not reliable: the
    code under test uses ``from roveagent.tools import web_tools as _wt``,
    which resolves through ``getattr(roveagent.tools, "web_tools")`` whenever
    the submodule is already an attribute of its package — the case in a full
    test run, though not in an isolated one. ``mock.patch.object`` on the
    resolved module is deterministic in both.
    """

    def setUp(self) -> None:
        from roveagent.tools import web_tools as real_web_tools

        self._real = real_web_tools
        self.addCleanup(setattr, self._real, "_load_web_config",
                        self._real._load_web_config)
        self._tier = mock.patch.object(km, "provider_tier", return_value="auto")
        self._tier.start()
        self.addCleanup(self._tier.stop)

    def _patch_config(self, cfg: dict) -> mock.Mock:
        m = mock.Mock(return_value=cfg)
        self._real._load_web_config = m
        return m

    def test_pin_lookup_actually_executes(self) -> None:
        """DEFECT B regression guard.

        With the bare ``_wt`` reference, the body raised NameError before ever
        reaching ``_load_web_config`` and the surrounding ``except`` swallowed
        it into ``return False``. Asserting the call HAPPENS is what actually
        distinguishes a working binding from a silently-swallowed NameError —
        a source-text check cannot tell a bound ``_wt.`` from an unbound one.
        """
        m = self._patch_config({"backend": "firecrawl"})
        km._vendor_pinned("firecrawl")
        m.assert_called_once_with()

    def test_free_tier_pin_is_honoured(self) -> None:
        with mock.patch.object(km, "provider_tier", return_value="free"):
            self.assertTrue(km._vendor_pinned("firecrawl"))

    def test_config_backend_pin_is_honoured(self) -> None:
        """A web.backend naming the vendor must pin it (this raised NameError before)."""
        self._patch_config({"backend": "firecrawl"})
        self.assertTrue(km._vendor_pinned("firecrawl"))

    def test_search_backend_pin_is_honoured(self) -> None:
        self._patch_config({"search_backend": "parallel"})
        self.assertTrue(km._vendor_pinned("parallel"))

    def test_unpinned_vendor_returns_false(self) -> None:
        self._patch_config({"backend": "searxng"})
        self.assertFalse(km._vendor_pinned("firecrawl"))

    def test_empty_config_returns_false(self) -> None:
        self._patch_config({})
        self.assertFalse(km._vendor_pinned("firecrawl"))


if __name__ == "__main__":
    unittest.main()
