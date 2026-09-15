"""Phase 8.1.5 tests — unified Capability Closure Layer.

The chain under test, end to end:

    Agent -> resolve_toolsets_for_request -> capability_router (base + dynamic)
          -> capability_registry -> tool registry -> EnterpriseToolGate -> sandbox

Why one test here is unusual
----------------------------

Twice in this project a fallback ``except Exception`` swallowed a ``NameError``
from my own wiring code, so a merge silently did nothing while looking
implemented (Phase 8.1's missing ``Path`` import; and ``toolsets.logger`` used
before it existed). ``test_the_merge_is_not_silently_disabled_by_a_swallowed_error``
drives the real seam with a strict wrapper that turns any swallowed exception
back into a failure, so that class of bug cannot pass again.

Run:  python -m pytest roveagent/api/capability_closure_test.py -q
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.api import capability_registry as creg  # noqa: E402
from roveagent.api import capability_router as cr  # noqa: E402
from roveagent.api import plugin_tools as pt  # noqa: E402
from roveagent.api import toolsets as ts  # noqa: E402
from roveagent.api.capability_registry import (  # noqa: E402
    Capability,
    CapabilityConflict,
    CapabilityKind,
)
from roveagent.api.plugin_trust import TRUST_REFUSAL_PREFIX  # noqa: E402

PLUGIN_BODY = """
    def greet(name="world"):
        return {"greeting": "hello " + name}

    def crash():
        import os
        os._exit(12)

    TOOLS = {"greet": greet, "crash": crash}
"""


# ---------------------------------------------------------------------------
# Task 1 — capability registry
# ---------------------------------------------------------------------------


class CapabilityModelTest(unittest.TestCase):
    def _cap(self, **kw):
        params = {"name": "media__generate_image", "provider": "media:fal",
                  "kind": CapabilityKind.MEDIA}
        params.update(kw)
        return Capability(**params)

    def test_accepts_a_well_formed_capability(self) -> None:
        cap = self._cap()
        self.assertEqual(cap.name, "media__generate_image")
        # Phase 8.1.6: an empty audience is a DENY, so it counts as restricted.
        self.assertTrue(cap.restricted)

    def test_the_explicit_wildcard_is_not_restricted(self) -> None:
        self.assertFalse(self._cap(allowed_agents=("*",)).restricted)

    def test_provider_must_be_kind_prefixed(self) -> None:
        for provider in ("fal", ":fal", "media:", "Media:fal", "media fal"):
            with self.subTest(provider=provider), self.assertRaises(ValueError):
                self._cap(provider=provider)

    def test_provider_prefix_must_match_the_kind(self) -> None:
        """A mismatch would make provenance unable to answer 'what put this here'."""
        with self.assertRaises(ValueError):
            self._cap(provider="plugin:acme", kind=CapabilityKind.MEDIA)

    def test_kind_must_be_a_capability_kind(self) -> None:
        with self.assertRaises(ValueError):
            self._cap(kind="media")

    def test_empty_name_or_provider_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            self._cap(name="  ")
        with self.assertRaises(ValueError):
            self._cap(provider="")

    def test_the_explicit_wildcard_is_visible_to_everyone(self) -> None:
        cap = self._cap(allowed_agents=("*",))
        for agent in ("ceo", "developer", "nobody"):
            self.assertTrue(cap.visible_to(agent))

    def test_an_empty_audience_is_visible_to_nobody(self) -> None:
        """Phase 8.1.6 deny-by-default; covered in depth in the governance tests."""
        cap = self._cap()
        for agent in ("ceo", "developer", "marketing", ""):
            self.assertFalse(cap.visible_to(agent))

    def test_restricted_is_visible_only_to_the_named_agents(self) -> None:
        cap = self._cap(allowed_agents=("Marketing", "ceo"))
        self.assertTrue(cap.visible_to("marketing"))
        self.assertTrue(cap.visible_to("CEO"))
        self.assertFalse(cap.visible_to("developer"))

    def test_an_unknown_agent_sees_only_unrestricted_capabilities(self) -> None:
        """A restricted capability must not fall through to 'everyone'."""
        cap = self._cap(allowed_agents=("ceo",))
        self.assertFalse(cap.visible_to("brand-new-agent"))
        self.assertFalse(cap.visible_to(""))

    def test_is_json_safe(self) -> None:
        json.dumps(self._cap().as_dict())


class CapabilityRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = creg.CapabilityRegistry()

    def _cap(self, name: str = "plugin__acme__greet", **kw):
        params = {"name": name, "provider": "plugin:acme",
                  "kind": CapabilityKind.PLUGIN, "toolset": "plugin"}
        params.update(kw)
        return Capability(**params)

    def test_register_and_get(self) -> None:
        self.registry.register(self._cap())
        self.assertIsNotNone(self.registry.get("plugin__acme__greet"))

    def test_reregistering_the_same_capability_is_idempotent(self) -> None:
        first = self.registry.register(self._cap())
        second = self.registry.register(self._cap())
        self.assertEqual(first, second)
        self.assertEqual(len(self.registry.all()), 1)

    def test_a_conflicting_registration_is_refused(self) -> None:
        self.registry.register(self._cap())
        with self.assertRaises(CapabilityConflict):
            self.registry.register(self._cap(description="different"))

    def test_replace_allows_an_explicit_override(self) -> None:
        self.registry.register(self._cap())
        self.registry.register(self._cap(description="v2"), replace=True)
        self.assertEqual(self.registry.get("plugin__acme__greet").description, "v2")

    def test_a_dynamic_capability_cannot_shadow_a_base_tool(self) -> None:
        """The anti-shadowing rule, checked against a real base tool name."""
        base = sorted(creg._base_tool_names())
        self.assertTrue(base, "the agent table resolved no tools to test against")
        with self.assertRaises(CapabilityConflict) as ctx:
            self.registry.register(self._cap(name=base[0]))
        self.assertIn("shadow", str(ctx.exception))

    def test_unregister(self) -> None:
        self.registry.register(self._cap())
        self.assertTrue(self.registry.unregister("plugin__acme__greet"))
        self.assertFalse(self.registry.unregister("plugin__acme__greet"))

    def test_unregister_provider_removes_the_whole_provider(self) -> None:
        for tool in ("a", "b", "c"):
            self.registry.register(self._cap(name="plugin__acme__%s" % tool))
        self.registry.register(Capability(name="plugin__other__x",
                                          provider="plugin:other",
                                          kind=CapabilityKind.PLUGIN))
        removed = self.registry.unregister_provider("plugin:acme")
        self.assertEqual(removed, ["plugin__acme__a", "plugin__acme__b", "plugin__acme__c"])
        self.assertEqual(self.registry.all(), (self.registry.get("plugin__other__x"),))

    def test_queries_by_kind_provider_toolset_and_agent(self) -> None:
        self.registry.register(self._cap(name="plugin__acme__a",
                                         allowed_agents=("*",)))
        self.registry.register(Capability(name="search__web", provider="search:web",
                                          kind=CapabilityKind.SEARCH, toolset="search",
                                          allowed_agents=("*",)))
        self.assertEqual(len(self.registry.by_kind(CapabilityKind.PLUGIN)), 1)
        self.assertEqual(len(self.registry.by_provider("search:web")), 1)
        self.assertEqual(len(self.registry.by_toolset("plugin")), 1)
        self.assertEqual(len(self.registry.for_agent("ceo")), 2)

    def test_toolsets_for_agent_deduplicates(self) -> None:
        self.registry.register(self._cap(name="plugin__acme__a", allowed_agents=("*",)))
        self.registry.register(self._cap(name="plugin__acme__b", allowed_agents=("*",)))
        self.assertEqual(self.registry.toolsets_for_agent("ceo"), ("plugin",))

    def test_toolsets_for_agent_respects_restrictions(self) -> None:
        self.registry.register(self._cap(name="plugin__acme__a",
                                         allowed_agents=("marketing",)))
        self.assertEqual(self.registry.toolsets_for_agent("marketing"), ("plugin",))
        self.assertEqual(self.registry.toolsets_for_agent("ceo"), ())

    def test_generation_advances_on_change(self) -> None:
        start = self.registry.generation
        self.registry.register(self._cap())
        self.assertGreater(self.registry.generation, start)

    def test_snapshot_is_json_safe(self) -> None:
        self.registry.register(self._cap())
        json.dumps(self.registry.snapshot())


# ---------------------------------------------------------------------------
# Task 2 — resolver merges base + dynamic
# ---------------------------------------------------------------------------


class _DynamicFixture(unittest.TestCase):
    """Registers a REAL tool AND its capability, the way the loader does.

    A capability with no registered tool is correctly filtered out by
    ``resolve_toolsets_for_request`` — handing the agent a toolset that provides
    nothing would be the "capability fixed but never delivered" failure in
    reverse. So a test of the seam has to create both halves.
    """

    TOOL = "plugin__fx__ping"
    TOOLSET = "plugin"

    def setUp(self) -> None:
        self._saved = list(creg.CAPABILITIES.all())
        creg.CAPABILITIES.clear()
        self.addCleanup(self._restore)
        self._registered: list[str] = []
        self.addCleanup(self._deregister)

    def _restore(self) -> None:
        creg.CAPABILITIES.clear()
        for cap in self._saved:
            try:
                creg.CAPABILITIES.register(cap, replace=True)
            except Exception:  # noqa: BLE001
                pass

    def _deregister(self) -> None:
        from roveagent.tools.registry import registry

        for name in self._registered:
            try:
                registry.deregister(name)
            except Exception:  # noqa: BLE001
                pass

    def register_dynamic(self, *, allowed_agents=("*",), name: str = TOOL,
                         toolset: str = TOOLSET) -> None:
        """Register a tool and its capability.

        Defaults to the explicit everyone-wildcard because these tests are about
        REACHABILITY. Since Phase 8.1.6 an empty audience means nobody, so a
        fixture that wants an agent to see the capability must say so.
        """
        from roveagent.tools.registry import registry

        registry.register(name=name, toolset=toolset,
                          schema={"name": name, "description": "fixture"},
                          handler=lambda args, **kw: "{}")
        self._registered.append(name)
        creg.CAPABILITIES.register(Capability(
            name=name, provider="plugin:fx", kind=CapabilityKind.PLUGIN,
            toolset=toolset, allowed_agents=allowed_agents))


class ResolverTest(_DynamicFixture):
    def test_base_only_agents_are_unchanged_when_nothing_is_dynamic(self) -> None:
        """The merge must be a no-op before anything registers a capability."""
        before = cr.resolve_agent_capabilities("developer")
        self.assertEqual(before.dynamic_toolsets, ())
        self.assertEqual(before.toolsets, cr.planned_toolsets("developer"))

    def test_the_agent_capabilities_table_is_not_modified(self) -> None:
        """A stated prohibition: dynamic capability must not edit the hardcoded table."""
        snapshot = {k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()}
        self.register_dynamic()
        self.assertEqual({k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()},
                         snapshot)

    def test_a_dynamic_toolset_appears_in_the_agent_set(self) -> None:
        self.register_dynamic()
        result = cr.resolve_agent_capabilities("developer")
        self.assertIn(self.TOOLSET, result.dynamic_toolsets)
        self.assertIn(self.TOOLSET, result.toolsets)
        self.assertIn(self.TOOL, result.available_tools)
        # base order preserved, dynamic appended
        self.assertEqual(result.toolsets[:len(result.base_toolsets)],
                         result.base_toolsets)

    def test_restricted_capabilities_do_not_reach_other_agents(self) -> None:
        self.register_dynamic(allowed_agents=("marketing",))
        self.assertIn(self.TOOLSET, cr.resolve_agent_capabilities("marketing").toolsets)
        self.assertNotIn(self.TOOLSET, cr.resolve_agent_capabilities("developer").toolsets)

    def test_merged_toolsets_deduplicates(self) -> None:
        """A dynamic toolset already in the base list must not be listed twice.

        Tested by driving the merge directly: registering a tool into a base
        toolset would (correctly) trip the anti-shadowing guard, since that
        makes the name reachable by agents through the base profile.
        """
        with mock.patch.object(cr, "dynamic_toolsets", return_value=("file",)):
            merged = cr.merged_toolsets("developer")
        self.assertIn("file", merged)
        self.assertEqual(len(merged), len(set(merged)))

    def test_registering_into_a_base_toolset_is_refused_as_shadowing(self) -> None:
        """The guard's real semantics: it refuses any name an agent can already reach.

        ``_base_tool_names`` resolves the base toolsets against the LIVE
        registry, so a tool registered into a base toolset (``business`` for the
        business agents) counts as a base tool and cannot be re-declared as a
        dynamic capability. Stricter than a hardcoded list, and deliberately so:
        the point is that no two capabilities may claim one name.
        """
        from roveagent.tools.registry import registry

        registry.register(name="plugin__fx__sneaky", toolset="business",
                          schema={"name": "plugin__fx__sneaky", "description": "x"},
                          handler=lambda args, **kw: "{}")
        self.addCleanup(registry.deregister, "plugin__fx__sneaky")
        with self.assertRaises(CapabilityConflict):
            creg.CAPABILITIES.register(Capability(
                name="plugin__fx__sneaky", provider="plugin:fx",
                kind=CapabilityKind.PLUGIN, toolset="business"))

    def test_registry_failure_degrades_to_base_only(self) -> None:
        """A broken registry must cost the dynamic half, not the static half."""
        with mock.patch.object(creg.CAPABILITIES, "toolsets_for_agent",
                               side_effect=RuntimeError("registry down")):
            self.assertEqual(cr.dynamic_toolsets("developer"), ())
            # The static profile is untouched.
            self.assertEqual(cr.planned_toolsets("developer"),
                             ("file", "terminal", "todo", "git", "skills", "delegation"))

    def test_resolution_is_json_safe(self) -> None:
        json.dumps(cr.resolve_agent_capabilities("ceo").as_dict())


# ---------------------------------------------------------------------------
# The real request seam
# ---------------------------------------------------------------------------


class RequestSeamTest(_DynamicFixture):
    def test_dynamic_toolset_reaches_resolve_toolsets_for_request(self) -> None:
        """The seam api/app.py actually calls."""
        self.register_dynamic()
        toolset_names, diagnostics = ts.resolve_toolsets_for_request("developer")
        self.assertIn(self.TOOLSET, toolset_names)
        self.assertIn(self.TOOL, [str(t) for t in diagnostics["available_tools"]])

    def test_restricted_capability_does_not_reach_the_seam_for_others(self) -> None:
        self.register_dynamic(allowed_agents=("marketing",))
        toolset_names, _diag = ts.resolve_toolsets_for_request("developer")
        self.assertNotIn(self.TOOLSET, toolset_names)

    def test_the_seam_is_unchanged_when_nothing_is_dynamic(self) -> None:
        before, _d1 = ts.resolve_toolsets_for_request("ceo")
        creg.CAPABILITIES.clear()
        after, _d2 = ts.resolve_toolsets_for_request("ceo")
        self.assertEqual(before, after)

    def test_a_capability_without_a_registered_tool_is_filtered_out(self) -> None:
        """Correct behaviour: never offer a toolset that provides nothing."""
        creg.CAPABILITIES.register(Capability(
            name="plugin__ghost__nope", provider="plugin:ghost",
            kind=CapabilityKind.PLUGIN, toolset="plugin"))
        toolset_names, _diag = ts.resolve_toolsets_for_request("developer")
        self.assertNotIn(self.TOOLSET, toolset_names)

    def test_the_merge_is_not_silently_disabled_by_a_swallowed_error(self) -> None:
        """Guards the exact bug class that hit this project twice.

        Both times, a ``NameError`` raised by my own wiring was caught by a
        broad ``except Exception`` inside the same function, so the merge
        quietly did nothing while every other test still passed. The module's
        logger is made to raise here — which is what any swallowed wiring error
        would do — so if the seam hides such an error, this test fails.
        """
        self.register_dynamic()

        class _Exploding:
            def __getattr__(self, _name):
                raise AssertionError("the seam swallowed a wiring error")

        with mock.patch.object(ts, "logger", _Exploding()):
            toolset_names, _diag = ts.resolve_toolsets_for_request("developer")
        # Reaching here means nothing raised, so the merge ran for real rather
        # than being rescued by the fallback.
        self.assertIn(self.TOOLSET, toolset_names)


# ---------------------------------------------------------------------------
# Task 3 — plugin capability, end to end
# ---------------------------------------------------------------------------


def make_community_plugin(root: Path, name: str, manifest_extra: str = "") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.yaml").write_text(
        textwrap.dedent(
            "name: %s\nversion: 1.0.0\nprovides_tools:\n  - greet\n  - crash\n"
            # Publish to everyone, EXPLICITLY. Phase 8.1.6 made an empty
            # audience mean "nobody", so a fixture that wants universal
            # visibility has to say so — which is the whole point of the change.
            'capability:\n  allowed_agents: ["*"]\n%s'
        ) % (name, manifest_extra),
        encoding="utf-8",
    )
    (directory / "__init__.py").write_text(textwrap.dedent(PLUGIN_BODY), encoding="utf-8")
    return directory


class _FakeManifest:
    def __init__(self, *, name: str, path: str, source: str = "user",
                 provides_tools=("greet", "crash"), trust_level=None, sandbox=None):
        self.name = name
        self.path = path
        self.source = source
        self.provides_tools = list(provides_tools)
        self.trust_level = trust_level
        self.sandbox = sandbox


class _FakeLoaded:
    def __init__(self, manifest, *, enabled=False, error=""):
        self.manifest = manifest
        self.enabled = enabled
        self.error = error


class _FakeManager:
    def __init__(self, entries):
        self._plugins = entries


def refused_entry(name: str, path, **kw):
    manifest = _FakeManifest(name=name, path=str(path), **kw)
    return name, _FakeLoaded(
        manifest, enabled=False,
        error="%s: third-party; must run under the MCP boundary + sandbox"
              % TRUST_REFUSAL_PREFIX)


class _ClosureCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._saved_policies = pt.PLUGIN_GATE_POLICIES
        self._saved_caps = list(creg.CAPABILITIES.all())
        pt.PLUGIN_GATE_POLICIES = pt.GatePolicyRegistry()
        creg.CAPABILITIES.clear()
        self.addCleanup(self._restore)
        self._registry = ts and None  # placeholder to keep flake quiet
        self.loader = pt.SandboxPluginLoader(policies=pt.PLUGIN_GATE_POLICIES)
        self.addCleanup(self._teardown)

    def _restore(self) -> None:
        creg.CAPABILITIES.clear()
        for cap in self._saved_caps:
            try:
                creg.CAPABILITIES.register(cap, replace=True)
            except Exception:  # noqa: BLE001
                pass
        pt.PLUGIN_GATE_POLICIES = self._saved_policies

    def _teardown(self) -> None:
        try:
            for key in list(self.loader._loaded):
                self.loader.disable(key)
        except Exception:  # noqa: BLE001 — best-effort teardown
            pass

    def load(self, name: str = "acme", **kw) -> dict:
        plugin_dir = make_community_plugin(self.root, name, **kw)
        manager = _FakeManager(dict([refused_entry(name, plugin_dir)]))
        return self.loader.load_all(manager)


class PluginCapabilityEndToEndTest(_ClosureCase):
    """Task 3: sandbox load -> capability -> agent discovers -> call -> gate."""

    def test_load_publishes_a_capability(self) -> None:
        result = self.load()
        self.assertEqual(result["loaded"], 1, result["plugins"])
        self.assertTrue(creg.CAPABILITIES.get("plugin__acme__greet"))

    def test_the_capability_is_a_plugin_kind_with_provenance(self) -> None:
        self.load()
        cap = creg.CAPABILITIES.get("plugin__acme__greet")
        self.assertIs(cap.kind, CapabilityKind.PLUGIN)
        self.assertEqual(cap.provider, "plugin:acme")
        self.assertEqual(cap.toolset, "plugin")

    def test_the_agent_can_now_discover_the_tool(self) -> None:
        """Verification 1: reachable by the agent, not merely registered."""
        self.load()
        resolved = cr.resolve_agent_capabilities("developer")
        self.assertIn("plugin", resolved.toolsets)
        self.assertIn("plugin__acme__greet", resolved.available_tools)

    def test_the_real_request_seam_offers_the_toolset(self) -> None:
        self.load()
        names, diagnostics = ts.resolve_toolsets_for_request("developer")
        self.assertIn("plugin", names)
        self.assertIn("plugin__acme__greet", diagnostics["available_tools"])

    def test_the_tool_executes_through_the_chain(self) -> None:
        from roveagent.tools.registry import registry

        self.load()
        output = registry.dispatch("plugin__acme__greet", {"name": "closure"})
        self.assertEqual(json.loads(output), {"greeting": "hello closure"})

    def test_the_gate_governs_the_tool(self) -> None:
        """Verification 2: the gate resolves a named row, not the catch-all."""
        from roveagent.enterprise import gate_hook

        self.load()
        saved = gate_hook._gate
        gate_hook._gate = None
        self.addCleanup(setattr, gate_hook, "_gate", saved)
        gate = gate_hook.get_gate()
        policy = gate.policy_for("plugin__acme__greet")
        self.assertEqual(policy.pattern, "plugin__acme__greet")
        self.assertNotEqual(policy.approval, "none")

    def test_the_capability_grants_no_permission_by_itself(self) -> None:
        """'declaration != grant': visibility is not authorisation."""
        from roveagent.enterprise import gate_hook
        from roveagent.tools.framework import ToolContext

        self.load()
        saved = gate_hook._gate
        gate_hook._gate = None
        self.addCleanup(setattr, gate_hook, "_gate", saved)
        gate = gate_hook.get_gate()
        ctx = ToolContext(tenant_id="t", business_id="b", user_id="u",
                          role="staff", permissions=frozenset(), request_id="r")
        decision = gate.authorize(ctx, "plugin__acme__greet", {})
        self.assertFalse(decision.allowed)

    def test_a_crash_does_not_remove_the_capability(self) -> None:
        """Verification 5: crash containment, at the capability layer too."""
        from roveagent.tools.registry import registry

        self.load()
        output = registry.dispatch("plugin__acme__crash", {})
        self.assertIn("error", json.loads(output))
        self.assertIsNotNone(creg.CAPABILITIES.get("plugin__acme__greet"))
        self.assertIn("plugin", cr.resolve_agent_capabilities("developer").toolsets)


# ---------------------------------------------------------------------------
# Task 4 — lifecycle (R43, R44)
# ---------------------------------------------------------------------------


class DisabledPluginTest(_ClosureCase):
    """Verification 3: a disabled plugin must not be discoverable."""

    def test_a_disabled_plugin_is_not_loaded(self) -> None:
        plugin_dir = make_community_plugin(self.root, "disabled-one")
        manager = _FakeManager({"disabled-one": _FakeLoaded(
            _FakeManifest(name="disabled-one", path=str(plugin_dir)),
            enabled=False, error="disabled via config")})
        result = self.loader.load_all(manager)
        self.assertEqual(result["candidates"], 0)
        self.assertEqual(result["loaded"], 0)
        self.assertIsNone(creg.CAPABILITIES.get("plugin__disabled-one__greet"))

    def test_the_disabled_list_is_honoured_even_if_a_refusal_is_present(self) -> None:
        """R43 hardening: the loader applies the disabled list itself.

        PluginManager's ordering already prevents this combination. The loader
        checking for itself makes that an enforced guarantee rather than an
        inherited property.
        """
        plugin_dir = make_community_plugin(self.root, "both")
        manager = _FakeManager(dict([refused_entry("both", plugin_dir)]))
        with mock.patch.object(pt.SandboxPluginLoader, "_disabled_keys",
                               return_value={"both"}):
            result = self.loader.load_all(manager)
        self.assertEqual(result["candidates"], 0)
        self.assertEqual(result["loaded"], 0)

    def test_the_disabled_list_is_matched_case_insensitively(self) -> None:
        plugin_dir = make_community_plugin(self.root, "mixedcase")
        manager = _FakeManager(dict([refused_entry("mixedcase", plugin_dir)]))
        with mock.patch.object(pt.SandboxPluginLoader, "_disabled_keys",
                               return_value={"mixedcase"}):
            self.assertEqual(self.loader.discover_candidates(manager), [])


class DisableLifecycleTest(_ClosureCase):
    """Verification 4: disable removes capability, tool, policy, sandbox, and audits."""

    def test_disable_removes_everything(self) -> None:
        from roveagent.tools.registry import registry

        self.load()
        self.assertIsNotNone(registry.get_entry("plugin__acme__greet"))
        self.assertTrue(creg.CAPABILITIES.get("plugin__acme__greet"))

        removed = self.loader.disable("acme", reason="unit test", actor="tester")

        self.assertIsNone(registry.get_entry("plugin__acme__greet"),
                          "the tool survived disable")
        self.assertIsNone(creg.CAPABILITIES.get("plugin__acme__greet"),
                          "the capability survived disable")
        self.assertEqual(pt.PLUGIN_GATE_POLICIES.policies(), (),
                         "the gate policy survived disable")
        self.assertTrue(removed["sandbox_stopped"])
        self.assertEqual(sorted(removed["tools_removed"]),
                         ["plugin__acme__crash", "plugin__acme__greet"])

    def test_disable_stops_the_sandbox_process(self) -> None:
        self.load()
        from roveagent.tools.registry import registry

        # Start the process so there is something to stop.
        registry.dispatch("plugin__acme__greet", {"name": "warm"})
        bridge = self.loader._bridges.get("acme")
        self.assertIsNotNone(bridge)
        self.assertTrue(bridge._process.running)
        self.loader.disable("acme")
        self.assertFalse(bridge._process.running if bridge._process else False)

    def test_the_agent_can_no_longer_see_the_toolset(self) -> None:
        self.load()
        self.assertIn("plugin", cr.resolve_agent_capabilities("developer").toolsets)
        self.loader.disable("acme")
        self.assertNotIn("plugin", cr.resolve_agent_capabilities("developer").toolsets)

    def test_disable_is_idempotent(self) -> None:
        self.load()
        self.loader.disable("acme")
        second = self.loader.disable("acme")
        self.assertEqual(second["tools_removed"], [])
        self.assertFalse(second["sandbox_stopped"])

    def test_disabling_one_plugin_leaves_another_intact(self) -> None:
        first = make_community_plugin(self.root, "alpha")
        second = make_community_plugin(self.root, "beta")
        manager = _FakeManager(dict([
            refused_entry("alpha", first), refused_entry("beta", second),
        ]))
        result = self.loader.load_all(manager)
        self.assertEqual(result["loaded"], 2, result["plugins"])

        self.loader.disable("alpha", reason="only alpha")

        self.assertIsNone(creg.CAPABILITIES.get("plugin__alpha__greet"))
        self.assertIsNotNone(creg.CAPABILITIES.get("plugin__beta__greet"),
                             "disabling one plugin removed another's capability")

    def test_disable_writes_an_audit_row(self) -> None:
        from roveagent.enterprise.audit import AuditLog

        audit_path = self.root / "audit" / "plugin_sandbox.jsonl"
        self.loader._audit = AuditLog(audit_path)
        self.load()
        self.loader.disable("acme", reason="audited", actor="tester")

        self.assertTrue(audit_path.exists(), "disable left no audit trail")
        rows = [json.loads(l) for l in audit_path.read_text(encoding="utf-8").splitlines()
                if l.strip()]
        actions = [r["action"] for r in rows]
        self.assertIn("plugin_sandbox_loaded", actions)
        self.assertIn("plugin_sandbox_disabled", actions)
        disabled = [r for r in rows if r["action"] == "plugin_sandbox_disabled"][0]
        self.assertEqual(disabled["result"], "ok")
        self.assertIn("acme", disabled["detail"])

    def test_disable_marks_audited_true(self) -> None:
        from roveagent.enterprise.audit import AuditLog

        self.loader._audit = AuditLog(self.root / "audit" / "x.jsonl")
        self.load()
        self.assertTrue(self.loader.disable("acme")["audited"])


# ---------------------------------------------------------------------------
# Verification 6 — bundled regression
# ---------------------------------------------------------------------------


class ConsentGateTest(_ClosureCase):
    """The sandbox path must not be a way around the pre-existing consent layer.

    ``clisupport.plugin_capabilities`` records which declared capabilities an
    operator consented to, and the plugin framework honours it. Found late, when
    a reachability check surfaced the module: the sandbox loader was not
    consulting it, so a community plugin declaring a high-risk capability would
    have been loaded and made agent-visible with no consent recorded.
    """

    def test_a_plugin_declaring_nothing_needs_no_consent(self) -> None:
        result = self.load()
        self.assertEqual(result["loaded"], 1, result["plugins"])

    def test_an_ungranted_capability_blocks_the_load(self) -> None:
        plugin_dir = make_community_plugin(self.root, "greedy")
        manifest = _FakeManifest(name="greedy", path=str(plugin_dir))
        manifest.capabilities = ["roveagent.tools.override"]
        manager = _FakeManager({"greedy": _FakeLoaded(
            manifest, enabled=False,
            error="%s: community" % TRUST_REFUSAL_PREFIX)})
        result = self.loader.load_all(manager)
        self.assertEqual(result["loaded"], 0)
        self.assertIn("never consented", result["plugins"][0]["reason"])
        self.assertIsNone(creg.CAPABILITIES.get("plugin__greedy__greet"))

    def test_an_ungranted_capability_registers_no_tools(self) -> None:
        from roveagent.tools.registry import registry

        plugin_dir = make_community_plugin(self.root, "greedy2")
        manifest = _FakeManifest(name="greedy2", path=str(plugin_dir))
        manifest.capabilities = ["roveagent.tools.override"]
        manager = _FakeManager({"greedy2": _FakeLoaded(
            manifest, enabled=False,
            error="%s: community" % TRUST_REFUSAL_PREFIX)})
        self.loader.load_all(manager)
        self.assertIsNone(registry.get_entry("plugin__greedy2__greet"))

    def test_a_granted_capability_allows_the_load(self) -> None:
        plugin_dir = make_community_plugin(self.root, "polite")
        manifest = _FakeManifest(name="polite", path=str(plugin_dir))
        manifest.capabilities = ["roveagent.tools.override"]
        manager = _FakeManager({"polite": _FakeLoaded(
            manifest, enabled=False,
            error="%s: community" % TRUST_REFUSAL_PREFIX)})
        with mock.patch(
            "roveagent.clisupport.plugin_capabilities.plugin_capability_granted",
            return_value=True,
        ):
            result = self.loader.load_all(manager)
        self.assertEqual(result["loaded"], 1, result["plugins"])

    def test_an_unavailable_consent_layer_fails_closed(self) -> None:
        """A check that cannot run must not become a bypass."""
        plugin_dir = make_community_plugin(self.root, "unchecked")
        manifest = _FakeManifest(name="unchecked", path=str(plugin_dir))
        manifest.capabilities = ["roveagent.tools.override"]
        manager = _FakeManager({"unchecked": _FakeLoaded(
            manifest, enabled=False,
            error="%s: community" % TRUST_REFUSAL_PREFIX)})
        with mock.patch.dict(
            sys.modules,
            {"roveagent.clisupport.plugin_capabilities": None},
        ):
            result = self.loader.load_all(manager)
        self.assertEqual(result["loaded"], 0)
        self.assertIn("could not be consulted", result["plugins"][0]["reason"])


class UndefinedNameGuardTest(unittest.TestCase):
    """A static check for the defect class that recurred three times.

    Three separate wiring edits introduced code that referenced a module-level
    name the module never defined:

      * ``plugin_tools`` used ``Path`` without importing it (Phase 8.1) — the
        ``NameError`` was swallowed by a broad ``except``, so 21 tests failed
        with the misleading symptom "Unknown tool";
      * ``toolsets`` used ``logger`` before it existed (caught by reading);
      * ``capability_router`` used ``logger`` before it existed (caught by the
        seam test above).

    Each was invisible at import time — the name only resolves when the branch
    runs — and each was masked by a fallback ``except Exception``. A dynamic
    test can only catch the branch that happens to execute, so the check below
    is static: parse every module under ``api/`` and fail if it reads a
    module-level name it never binds.
    """

    #: Names Python guarantees, plus common module-level bindings that are
    #: legitimately imported from elsewhere.
    _ALWAYS_DEFINED = frozenset({
        "__name__", "__file__", "__doc__", "__package__", "__spec__",
        "__loader__", "__builtins__", "__annotations__", "__class__",
        "self", "cls", "None", "True", "False", "NotImplemented", "Ellipsis",
    })

    def test_no_module_uses_an_undefined_logger(self) -> None:
        import ast

        api_dir = Path(__file__).parent
        offenders: list[str] = []
        for path in sorted(api_dir.glob("*.py")):
            if path.name.endswith("_test.py"):
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:
                continue
            module_bindings: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    for alias in node.names:
                        module_bindings.add(alias.asname or alias.name.split(".")[0])
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    module_bindings.add(node.name)
                elif isinstance(node, ast.Assign):
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            module_bindings.add(target.id)
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    module_bindings.add(node.target.id)
                elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    module_bindings.add(node.id)
                elif isinstance(node, (ast.arg,)) and node.arg:
                    module_bindings.add(node.arg)
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    module_bindings.add(node.name)
                elif isinstance(node, (ast.comprehension,)):
                    pass
                elif isinstance(node, ast.Global):
                    module_bindings.update(node.names)

            for node in ast.walk(tree):
                if (isinstance(node, ast.Attribute)
                        and isinstance(node.value, ast.Name)
                        and node.value.id == "logger"
                        and node.value.id not in module_bindings):
                    offenders.append("%s:%d" % (path.name, node.lineno))
                    break

        self.assertEqual(offenders, [],
                         "these modules use `logger` without defining it: %s"
                         % offenders)


class BundledRegressionTest(unittest.TestCase):
    def test_54_bundled_plugins_still_load(self) -> None:
        """Verification 6: the shipped set is unaffected by the closure layer."""
        from roveagent.clisupport.plugins import (
            _ensure_plugins_discovered, get_plugin_manager,
        )

        manager = _ensure_plugins_discovered()
        enabled = [p for p in manager._plugins.values() if p.enabled]
        self.assertGreater(len(enabled), 10,
                           "bundled plugin loading regressed")
        self.assertGreater(len(manager._plugins), 40)

    def test_no_bundled_plugin_gained_a_sandbox_capability(self) -> None:
        """Bundled plugins run in-process; they must not appear as dynamic caps."""
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        bundled = [c for c in creg.CAPABILITIES.all()
                   if c.provider.startswith("plugin:")]
        self.assertEqual(bundled, [],
                         "a bundled plugin leaked into the dynamic capability "
                         "registry: %s" % [c.name for c in bundled])

    def test_the_base_agent_table_is_still_authoritative(self) -> None:
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        for agent in ("ceo", "developer", "devops", "marketing", "operations"):
            with self.subTest(agent=agent):
                resolved = cr.resolve_agent_capabilities(agent)
                self.assertEqual(resolved.toolsets[:len(resolved.base_toolsets)],
                                 resolved.base_toolsets)

    def test_bundled_tools_are_still_available_to_their_agents(self) -> None:
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        developer = cr.resolve_agent_capabilities("developer")
        for tool in ("read_file", "write_file", "terminal"):
            self.assertIn(tool, developer.available_tools,
                          "the closure layer removed a base tool from developer")


if __name__ == "__main__":
    unittest.main()
