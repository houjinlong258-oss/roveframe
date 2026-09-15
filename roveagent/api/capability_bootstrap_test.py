"""Phase 8.1.7 tests — Capability Runtime Bootstrap.

Covers the four tasks and the six required verifications:

  1. startup builds automatically
  2. the registry exists before the first request
  3. an optional provider failing does not stop startup
  4. a critical provider failing does stop startup
  5. the health endpoint reports correctly
  6. bundled plugins are unaffected

Run:  python -m pytest roveagent/api/capability_bootstrap_test.py -q
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.api import capability_providers as cp  # noqa: E402
from roveagent.api import capability_registry as creg  # noqa: E402
from roveagent.api import capability_router as cr  # noqa: E402
from roveagent.api.capability_registry import Capability, CapabilityKind  # noqa: E402
from roveagent.api.capability_providers import (  # noqa: E402
    CapabilityProvider,
    ProviderRegistry,
    ProviderTier,
    ProviderUnavailable,
)


class _Stub(CapabilityProvider):
    """A provider that publishes one capability and can be made to fail.

    The provider id's prefix must match ``kind`` (the Capability model enforces
    it), so stubs that need a non-plugin prefix pass the kind explicitly.
    """

    def __init__(self, provider_id: str, name: str, *, tier: ProviderTier,
                 list_error: str = "", preflight_error: str = "",
                 kind: CapabilityKind = CapabilityKind.PLUGIN) -> None:
        super().__init__(allowed_agents=("*",))
        self.provider_id = provider_id
        self.kind = kind
        self.tier = tier
        self._name = name
        self._list_error = list_error
        self._preflight_error = preflight_error

    def preflight(self) -> None:
        if self._preflight_error:
            raise ProviderUnavailable(self._preflight_error)

    def list_capabilities(self):
        if self._list_error:
            raise RuntimeError(self._list_error)
        return [Capability(name=self._name, provider=self.provider_id,
                           kind=self.kind, toolset="plugin",
                           allowed_agents=self.allowed_agents)]


class _CleanRegistry(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_caps = list(creg.CAPABILITIES.all())
        creg.CAPABILITIES.clear()
        cp.reset_capability_bootstrap()
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        creg.CAPABILITIES.clear()
        for cap in self._saved_caps:
            try:
                creg.CAPABILITIES.register(cap, replace=True)
            except Exception:  # noqa: BLE001
                pass
        cp.reset_capability_bootstrap()


# ---------------------------------------------------------------------------
# Task 2 — tiered failure isolation (verifications 3 and 4)
# ---------------------------------------------------------------------------


class TieredFailureTest(_CleanRegistry):
    def _bootstrap(self, providers):
        registry = ProviderRegistry(providers)
        return cp.bootstrap_capabilities(providers=registry, registry=creg.CAPABILITIES)

    def test_an_optional_preflight_failure_does_not_block_startup(self) -> None:
        """Verification 3: an unconfigured backend must not stop the OS booting."""
        result = self._bootstrap([
            _Stub("plugin:ok", "plugin__ok__a", tier=ProviderTier.CRITICAL),
            _Stub("media:broken", "media__x", tier=ProviderTier.OPTIONAL,
                  kind=CapabilityKind.MEDIA, preflight_error="no API key"),
        ])
        self.assertEqual(result["status"], "degraded")
        self.assertFalse(result["ready"])
        self.assertEqual(len(result["degraded"]), 1,
                         "a provider that fails only preflight should degrade once: %s"
                         % result["degraded"])
        self.assertIn("media:broken", result["degraded"][0]["provider_id"])
        # The healthy provider still published.
        self.assertIsNotNone(creg.CAPABILITIES.get("plugin__ok__a"))

    def test_a_critical_preflight_failure_stops_startup(self) -> None:
        """Verification 4."""
        with self.assertRaises(ProviderUnavailable) as ctx:
            self._bootstrap([
                _Stub("plugin:broken", "plugin__b__a", tier=ProviderTier.CRITICAL,
                      preflight_error="sandbox unavailable"),
                _Stub("media:ok", "media__y", tier=ProviderTier.OPTIONAL),
            ])
        self.assertIn("plugin:broken", str(ctx.exception))
        self.assertIn("critical", str(ctx.exception))

    def test_a_critical_listing_failure_also_stops_startup(self) -> None:
        """A critical provider that cannot list is equally unusable."""
        with self.assertRaises(ProviderUnavailable):
            self._bootstrap([
                _Stub("plugin:boom", "plugin__c__a", tier=ProviderTier.CRITICAL,
                      list_error="exploded"),
            ])

    def test_an_optional_listing_failure_degrades_without_raising(self) -> None:
        result = self._bootstrap([
            _Stub("plugin:ok2", "plugin__ok2__a", tier=ProviderTier.CRITICAL),
            _Stub("social:down", "social__x", tier=ProviderTier.OPTIONAL,
                  list_error="gateway offline"),
        ])
        self.assertEqual(result["status"], "degraded")
        degraded_ids = [d["provider_id"] for d in result["degraded"]]
        self.assertIn("social:down", degraded_ids)

    def test_critical_failure_leaves_no_half_built_registry(self) -> None:
        """Preflight runs for every provider BEFORE anything is published."""
        with self.assertRaises(ProviderUnavailable):
            self._bootstrap([
                _Stub("plugin:first", "plugin__f__a", tier=ProviderTier.CRITICAL),
                _Stub("plugin:second", "plugin__s__a", tier=ProviderTier.CRITICAL,
                      preflight_error="nope"),
            ])
        self.assertEqual(creg.CAPABILITIES.all(), (),
                         "a failed bootstrap left capabilities behind")

    def test_all_healthy_is_ready(self) -> None:
        result = self._bootstrap([
            _Stub("plugin:ok3", "plugin__ok3__a", tier=ProviderTier.CRITICAL),
        ])
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["ready"])
        self.assertEqual(result["degraded"], [])

    def test_an_optional_is_the_default_tier(self) -> None:
        """A new provider must not become a startup blocker by omission."""

        class _New(CapabilityProvider):
            provider_id = "plugin:new"
            kind = CapabilityKind.PLUGIN

            def list_capabilities(self):
                return []

        self.assertIs(_New().tier, ProviderTier.OPTIONAL)

    def test_the_bootstrap_result_is_json_safe(self) -> None:
        json.dumps(self._bootstrap([
            _Stub("plugin:j", "plugin__j__a", tier=ProviderTier.CRITICAL)]))


# ---------------------------------------------------------------------------
# The real core provider (critical tier)
# ---------------------------------------------------------------------------


class CoreToolsProviderTest(unittest.TestCase):
    def test_it_publishes_nothing_by_design(self) -> None:
        """Core tools are base-reachable; publishing them would be shadowing."""
        self.assertEqual(cp.CoreToolsProvider().list_capabilities(), ())

    def test_it_is_critical(self) -> None:
        self.assertIs(cp.CoreToolsProvider().tier, ProviderTier.CRITICAL)

    def test_preflight_passes_on_this_tree(self) -> None:
        cp.CoreToolsProvider().preflight()

    def test_preflight_fails_when_the_agent_table_is_empty(self) -> None:
        with mock.patch.object(cr, "AGENT_CAPABILITIES", {}):
            with self.assertRaises(ProviderUnavailable) as ctx:
                cp.CoreToolsProvider().preflight()
        self.assertIn("empty", str(ctx.exception))

    def test_preflight_fails_when_the_base_toolsets_declare_almost_nothing(self) -> None:
        with mock.patch.object(cp.CoreToolsProvider, "MINIMUM_TOTAL_BASE_TOOLS", 9999):
            with self.assertRaises(ProviderUnavailable) as ctx:
                cp.CoreToolsProvider().preflight()
        self.assertIn("declare only", str(ctx.exception))

    def test_preflight_fails_when_an_agent_resolves_no_tools(self) -> None:
        from roveagent.api.capability_router import AgentCapabilitySet

        empty = AgentCapabilitySet(
            agent="ghost", known=True, base_toolsets=(), dynamic_toolsets=(),
            toolsets=(), available_tools=(), unavailable_tools=(),
            max_iterations=1, summary="")
        with mock.patch.object(cr, "resolve_agent_capabilities", return_value=empty):
            with self.assertRaises(ProviderUnavailable) as ctx:
                cp.CoreToolsProvider().preflight()
        self.assertIn("no tools at all", str(ctx.exception))

    def test_the_threshold_does_not_fire_on_a_healthy_tree(self) -> None:
        """A check that trips on a healthy system trains people to ignore it.

        `devops` resolves to 3 tools because its `docker_read` and `monitoring`
        toolsets are pure composites; an earlier floor of 5 fired on it.
        """
        resolved = cr.resolve_agent_capabilities("devops")
        self.assertGreaterEqual(len(resolved.available_tools),
                                cp.CoreToolsProvider.MINIMUM_TOOLS_PER_AGENT)
        cp.CoreToolsProvider().preflight()


# ---------------------------------------------------------------------------
# Task 1 — startup bootstrap (verifications 1 and 2)
# ---------------------------------------------------------------------------


class StartupBootstrapTest(_CleanRegistry):
    def test_the_app_builds_the_registry_at_create_app(self) -> None:
        """Verification 1 and 2, together: built at startup, before any request."""
        from roveagent.api.app import create_app
        from roveagent.api.capability_registry import CAPABILITIES

        self.assertEqual(CAPABILITIES.all(), ())
        create_app()
        self.assertGreater(len(CAPABILITIES.all()), 0,
                           "create_app() did not build the capability registry")

    def test_the_health_routes_are_registered(self) -> None:
        from roveagent.api.app import create_app

        app = create_app()
        paths = {r.path for r in app.routes if getattr(r, "path", "")}
        self.assertIn("/api/capabilities/health", paths)
        self.assertIn("/api/capabilities/rebuild", paths)

    def test_the_bootstrap_is_not_lazy(self) -> None:
        """No request is made here; the registry must already be populated."""
        cp.reset_capability_bootstrap()
        creg.CAPABILITIES.clear()
        cp.ensure_capability_bootstrap()
        self.assertGreater(len(creg.CAPABILITIES.all()), 0)

    def test_repeated_calls_are_free_without_force(self) -> None:
        first = cp.ensure_capability_bootstrap()
        second = cp.ensure_capability_bootstrap()
        self.assertIs(first, second)

    def test_force_rebuilds(self) -> None:
        cp.ensure_capability_bootstrap()
        creg.CAPABILITIES.clear()
        rebuilt = cp.ensure_capability_bootstrap(force=True)
        self.assertGreater(rebuilt["capabilities"], 0)

    def test_the_real_bootstrap_is_ready(self) -> None:
        result = cp.bootstrap_capabilities()
        self.assertEqual(result["status"], "ready", result.get("degraded"))
        self.assertTrue(result["ready"])

    def test_the_real_default_providers_include_a_critical_one(self) -> None:
        tiers = {p.provider_id: p.tier for p in cp.default_providers()}
        self.assertIn("builtin:core", tiers)
        self.assertIs(tiers["builtin:core"], ProviderTier.CRITICAL)


# ---------------------------------------------------------------------------
# Task 3 — health endpoint
# ---------------------------------------------------------------------------


class HealthPayloadTest(_CleanRegistry):
    def test_unbuilt_is_reported_as_unbuilt_not_healthy(self) -> None:
        """A caller deciding whether to send work needs the truth."""
        payload = cp.capability_health()
        self.assertEqual(payload["status"], "unbuilt")
        self.assertFalse(payload["ready"])

    def test_reports_every_provider_with_its_tier(self) -> None:
        cp.ensure_capability_bootstrap()
        payload = cp.capability_health()
        ids = {p["provider_id"] for p in payload["providers"]}
        self.assertIn("builtin:core", ids)
        core = [p for p in payload["providers"] if p["provider_id"] == "builtin:core"][0]
        self.assertEqual(core["tier"], "critical",
                         "the health payload misreports a critical provider")

    def test_counts_match_the_registry(self) -> None:
        cp.ensure_capability_bootstrap()
        payload = cp.capability_health()
        self.assertEqual(payload["capabilities"], len(creg.CAPABILITIES.all()))

    def test_degraded_is_surfaced(self) -> None:
        registry = ProviderRegistry([
            _Stub("media:down", "media__z", tier=ProviderTier.OPTIONAL,
                  preflight_error="no key")])
        cp.bootstrap_capabilities(providers=registry, registry=creg.CAPABILITIES)
        payload = cp.capability_health()
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["degraded"])

    def test_the_payload_is_json_safe(self) -> None:
        cp.ensure_capability_bootstrap()
        json.dumps(cp.capability_health())

    def test_the_note_explains_what_unbuilt_means(self) -> None:
        self.assertIn("unbuilt", cp.capability_health()["note"])


# ---------------------------------------------------------------------------
# Task 4 — snapshot interface
# ---------------------------------------------------------------------------


class SnapshotInterfaceTest(_CleanRegistry):
    def test_the_abstract_shape_is_fixed(self) -> None:
        for name in ("publish", "read_all"):
            self.assertTrue(hasattr(cp.CapabilitySnapshot, name))

    def test_the_default_implementation_is_honest_about_being_local(self) -> None:
        snapshot = cp.InMemoryCapabilitySnapshot(worker_id="w1")
        self.assertTrue(snapshot.publish({"status": "ready"}))
        rows = snapshot.read_all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["worker_id"], "w1")

    def test_publishing_twice_replaces_rather_than_appends(self) -> None:
        snapshot = cp.InMemoryCapabilitySnapshot(worker_id="w2")
        snapshot.publish({"status": "degraded"})
        snapshot.publish({"status": "ready"})
        rows = snapshot.read_all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "ready")

    def test_the_bootstrap_publishes_a_snapshot(self) -> None:
        self.assertIsNotNone(cp.ensure_capability_bootstrap())
        rows = cp.CAPABILITY_SNAPSHOT.read_all()
        self.assertTrue(rows)
        self.assertEqual(rows[-1]["status"], "ready")

    def test_a_failing_snapshot_does_not_block_startup(self) -> None:
        """Synchronisation problems must never stop the runtime."""

        class _Broken(cp.CapabilitySnapshot):
            def publish(self, snapshot):
                raise RuntimeError("store unreachable")

            def read_all(self):
                return []

        with mock.patch.object(cp, "CAPABILITY_SNAPSHOT", _Broken()):
            result = cp.ensure_capability_bootstrap(force=True)
        self.assertEqual(result["status"], "ready")

    def test_describe_is_json_safe(self) -> None:
        json.dumps(cp.InMemoryCapabilitySnapshot().describe())

    def test_no_redis_dependency_is_introduced(self) -> None:
        """Explicitly required: interface only, no new backend."""
        source = open(cp.__file__, encoding="utf-8").read().lower()
        for forbidden in ("import redis", "from redis", "redisclient"):
            self.assertNotIn(forbidden, source)


# ---------------------------------------------------------------------------
# Verification 6 — bundled regression
# ---------------------------------------------------------------------------


class BundledRegressionTest(unittest.TestCase):
    def test_bundled_plugins_still_load(self) -> None:
        from roveagent.clisupport.plugins import (
            _ensure_plugins_discovered, get_plugin_manager,
        )

        manager = _ensure_plugins_discovered()
        self.assertGreater(len(manager._plugins), 40)
        self.assertGreater(sum(1 for p in manager._plugins.values() if p.enabled), 10)

    def test_bootstrap_does_not_disturb_bundled_plugins(self) -> None:
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        cp.ensure_capability_bootstrap(force=True)
        manager = _ensure_plugins_discovered()
        self.assertGreater(sum(1 for p in manager._plugins.values() if p.enabled), 10)

    def test_bootstrap_does_not_starve_the_base_agents(self) -> None:
        cp.ensure_capability_bootstrap(force=True)
        for agent in ("ceo", "developer", "devops", "marketing", "operations"):
            with self.subTest(agent=agent):
                resolved = cr.resolve_agent_capabilities(agent)
                self.assertGreaterEqual(len(resolved.available_tools), 1)

    def test_the_base_table_is_untouched_by_the_bootstrap(self) -> None:
        before = {k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()}
        cp.ensure_capability_bootstrap(force=True)
        self.assertEqual({k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()},
                         before)


if __name__ == "__main__":
    unittest.main()
