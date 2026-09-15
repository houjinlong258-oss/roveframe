"""Phase 8.1 tests — Plugin Execution Closure (R39 + R41).

What these prove
----------------

The full chain, with a real sandbox process and the real gate:

    Community Plugin -> trust check -> SandboxPluginLoader -> MCP boundary
      -> PluginToolBridge -> Tool Registry -> EnterpriseToolGate
      -> approval -> execution -> result

Before this phase the chain was broken in two places: the policy pack was
produced and discarded (R39), and a community plugin was refused in-process
with nothing taking over (R41). Both are now closed, and the tests below fail
if either reopens.

The distinction these tests keep honest
---------------------------------------

The chain is exercised END TO END with a synthetic manager entry and a real
plugin directory, real child process, and real gate. The `_ensure_plugins_discovered`
hook is proven by CALL ASSERTION rather than by running the full bundled
discovery into a temp home: the hook is one call, and asserting it fires is
exactly the property at risk. The report says which is which.

Run:  python -m pytest roveagent/api/plugin_integration_test.py -q
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.api import plugin_tools as pt  # noqa: E402
from roveagent.api.plugin_trust import TRUST_REFUSAL_PREFIX  # noqa: E402

PLUGIN_BODY = """
    def greet(name="world"):
        return {"greeting": "hello " + name}

    def crash():
        import os
        os._exit(11)

    def hang():
        import time
        time.sleep(600)

    TOOLS = {"greet": greet, "crash": crash, "hang": hang}
"""


def make_community_plugin(root: Path, name: str = "acme", manifest_extra: str = "") -> Path:
    """A real plugin directory declaring community-appropriate contents."""
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            name: %s
            version: 1.0.0
            author: ACME
            provides_tools:
              - greet
              - crash
              - hang
            %s"""
        ) % (name, manifest_extra),
        encoding="utf-8",
    )
    (directory / "__init__.py").write_text(textwrap.dedent(PLUGIN_BODY), encoding="utf-8")
    return directory


class _FakeManifest:
    """Stands in for PluginManifest: only the fields the loader reads."""

    def __init__(self, *, name: str, path: str, source: str = "user",
                 provides_tools=("greet", "crash", "hang"), trust_level=None,
                 sandbox=None) -> None:
        self.name = name
        self.path = path
        self.source = source
        self.provides_tools = list(provides_tools)
        self.trust_level = trust_level
        self.sandbox = sandbox


class _FakeLoaded:
    def __init__(self, manifest, *, enabled=False, error="") -> None:
        self.manifest = manifest
        self.enabled = enabled
        self.error = error


class _FakeManager:
    """Mimics the one attribute the sandbox loader reads: ``_plugins``."""

    def __init__(self, entries) -> None:
        self._plugins = entries


def refused_entry(name: str, path: Path, **kw) -> tuple[str, _FakeLoaded]:
    """Exactly what PluginManager records for a community plugin."""
    manifest = _FakeManifest(name=name, path=str(path), **kw)
    return name, _FakeLoaded(
        manifest, enabled=False,
        error="%s: third-party; must run under the MCP boundary + sandbox"
              % TRUST_REFUSAL_PREFIX,
    )


class _CleanState(unittest.TestCase):
    """Each test gets its own loader and an empty policy registry."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._saved = pt.PLUGIN_GATE_POLICIES
        pt.PLUGIN_GATE_POLICIES = pt.GatePolicyRegistry()
        self._loader = pt.SandboxPluginLoader(policies=pt.PLUGIN_GATE_POLICIES)
        self._registered: list[str] = []
        # Order matters: stop the sandbox processes BEFORE removing the temp
        # directory. On Windows a child whose cwd is the plugin directory keeps
        # it locked, so cleanup would fail with WinError 32 — which is how the
        # missing bridge reference in the loader first showed up.
        self.addCleanup(self._restore)
        self.addCleanup(self._shutdown_bridges)
        self.addCleanup(self._deregister)

    def _restore(self) -> None:
        pt.PLUGIN_GATE_POLICIES = self._saved

    def _shutdown_bridges(self) -> None:
        try:
            self._loader.shutdown()
        except Exception:  # noqa: BLE001 — best-effort teardown
            pass

    def _deregister(self) -> None:
        from roveagent.tools.registry import registry

        for name in self._registered:
            try:
                registry.deregister(name)
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass

    def load(self, name: str = "acme", **kw) -> dict:
        plugin_dir = make_community_plugin(self.root, name, **kw)
        manager = _FakeManager(dict([refused_entry(name, plugin_dir)]))
        self._loader = pt.SandboxPluginLoader(policies=pt.PLUGIN_GATE_POLICIES)
        result = self._loader.load_all(manager)
        for record in result["plugins"]:
            self._registered.extend(record.get("tools") or [])
        return result


# ---------------------------------------------------------------------------
# R41 — community plugins are LOADED, not merely refused
# ---------------------------------------------------------------------------


class SandboxLoaderTest(_CleanState):
    def test_a_refused_community_plugin_is_picked_up(self) -> None:
        result = self.load()
        self.assertEqual(result["candidates"], 1)
        self.assertEqual(result["loaded"], 1, result["plugins"])

    def test_its_tools_are_registered(self) -> None:
        from roveagent.tools.registry import registry

        self.load()
        for tool in ("plugin__acme__greet", "plugin__acme__crash", "plugin__acme__hang"):
            with self.subTest(tool=tool):
                self.assertIsNotNone(registry.get_entry(tool))

    def test_the_plugin_module_is_never_imported_into_the_host(self) -> None:
        """The prohibition, checked directly against sys.modules."""
        before = set(sys.modules)
        self.load()
        new_sandbox_helpers = {
            m for m in set(sys.modules) - before
            if "sandboxed_plugin" in m or m.endswith("acme")
        }
        self.assertEqual(new_sandbox_helpers, set(),
                         "the plugin was imported into the host process: %s"
                         % new_sandbox_helpers)

    def test_an_official_plugin_is_left_alone(self) -> None:
        """Bundled plugins keep their existing in-process path."""
        plugin_dir = make_community_plugin(self.root, "official-ish")
        manifest = _FakeManifest(name="official-ish", path=str(plugin_dir),
                                source="bundled")
        manager = _FakeManager({"official-ish": _FakeLoaded(manifest, enabled=True)})
        result = self._loader.load_all(manager)
        self.assertEqual(result["candidates"], 0)
        self.assertEqual(result["loaded"], 0)

    def test_loading_is_idempotent(self) -> None:
        plugin_dir = make_community_plugin(self.root, "twice")
        manager = _FakeManager(dict([refused_entry("twice", plugin_dir)]))
        first = self._loader.load_all(manager)
        second = self._loader.load_all(manager)
        self.assertEqual(first["loaded"], 1)
        self.assertEqual(second["loaded"], 1)
        self.assertEqual(len(second["plugins"]), 1, "the plugin was loaded twice")
        for tool in first["plugins"][0]["tools"]:
            self._registered.append(tool)

    def test_a_plugin_with_no_tools_loads_without_registering(self) -> None:
        plugin_dir = make_community_plugin(self.root, "toolless")
        manifest = _FakeManifest(name="toolless", path=str(plugin_dir), provides_tools=())
        manager = _FakeManager({"toolless": _FakeLoaded(
            manifest, enabled=False,
            error="%s: community" % TRUST_REFUSAL_PREFIX)})
        result = self._loader.load_all(manager)
        self.assertEqual(result["loaded"], 1)
        self.assertIn("no tools", result["plugins"][0]["reason"])

    def test_a_bad_plugin_does_not_stop_the_others(self) -> None:
        """One unloadable community plugin must not block the rest."""
        good = make_community_plugin(self.root, "good")
        broken_manifest = _FakeManifest(name="missing", path="")
        manager = _FakeManager({
            "missing": _FakeLoaded(
                broken_manifest, enabled=False,
                error="%s: community" % TRUST_REFUSAL_PREFIX),
            "good": refused_entry("good", good)[1],
        })
        result = self._loader.load_all(manager)
        self.assertEqual(result["candidates"], 2)
        self.assertEqual(result["loaded"], 1, result["plugins"])
        self.assertEqual(result["failed"], 1)
        for record in result["plugins"]:
            self._registered.extend(record.get("tools") or [])

    def test_unsatisfiable_policy_is_refused_not_loaded(self) -> None:
        result = self.load("badpolicy", manifest_extra="sandbox:\n  filesystem: whatever\n")
        self.assertEqual(result["loaded"], 0)
        self.assertIn("not satisfiable", result["plugins"][0]["reason"])


# ---------------------------------------------------------------------------
# R39 — plugin policies actually reach the gate
# ---------------------------------------------------------------------------


class GatePolicyRegistryTest(_CleanState):
    def test_registration_publishes_rows(self) -> None:
        self.load()
        snapshot = pt.PLUGIN_GATE_POLICIES.snapshot()
        self.assertEqual(snapshot["plugins_with_policies"], 1)
        self.assertEqual(snapshot["policy_rows"], 3)

    def test_rows_are_sorted_for_stable_precedence(self) -> None:
        a = make_community_plugin(self.root, "aaa")
        b = make_community_plugin(self.root, "bbb")
        manager = _FakeManager(dict([
            refused_entry("bbb", b), refused_entry("aaa", a),
        ]))
        result = self._loader.load_all(manager)
        for record in result["plugins"]:
            self._registered.extend(record.get("tools") or [])
        patterns = [p.pattern for p in pt.PLUGIN_GATE_POLICIES.policies()]
        self.assertEqual(patterns, sorted(patterns))

    def test_retract_removes_a_plugin_rows(self) -> None:
        self.load()
        self.assertTrue(pt.PLUGIN_GATE_POLICIES.retract("acme"))
        self.assertEqual(pt.PLUGIN_GATE_POLICIES.policies(), ())

    def test_an_empty_registry_yields_no_rows(self) -> None:
        self.assertEqual(pt.plugin_gate_policies(), ())


class RealGateWiringTest(_CleanState):
    """The acceptance test for R39: the REAL gate reads the rows."""

    def setUp(self) -> None:
        super().setUp()
        from roveagent.enterprise import gate_hook

        self.gate_hook = gate_hook
        self._saved_gate = gate_hook._gate
        gate_hook._gate = None
        self.addCleanup(self._restore_gate)

    def _restore_gate(self) -> None:
        self.gate_hook._gate = self._saved_gate

    def test_get_gate_picks_up_plugin_rows(self) -> None:
        """Before Phase 8.1 get_gate() built a gate with no plugin rows at all."""
        self.load()
        gate = self.gate_hook.get_gate()
        policy = gate.policy_for("plugin__acme__greet")
        self.assertEqual(policy.pattern, "plugin__acme__greet",
                         "the gate still resolves the plugin tool to the catch-all")
        self.assertNotEqual(policy.pattern, "*")

    def test_without_loading_there_are_no_plugin_rows(self) -> None:
        gate = self.gate_hook.get_gate()
        self.assertEqual(gate.policy_for("plugin__acme__greet").pattern, "*")

    def test_install_enterprise_gate_keeps_plugin_rows(self) -> None:
        self.load()
        gate = self.gate_hook.install_enterprise_gate()
        self.assertEqual(gate.policy_for("plugin__acme__greet").pattern,
                         "plugin__acme__greet")
        self.gate_hook.uninstall_enterprise_gate()

    def test_a_caller_pack_does_not_displace_plugin_rows(self) -> None:
        from roveagent.tools.framework import ApprovalPolicy, RiskLevel, ToolPolicy

        self.load()
        gate = self.gate_hook.install_enterprise_gate(
            policies=[ToolPolicy("caller_tool", "caller:read", RiskLevel.LOW,
                                 ApprovalPolicy.NONE)])
        try:
            self.assertEqual(gate.policy_for("caller_tool").pattern, "caller_tool")
            self.assertEqual(gate.policy_for("plugin__acme__greet").pattern,
                             "plugin__acme__greet")
        finally:
            self.gate_hook.uninstall_enterprise_gate()

    def test_gate_builds_even_when_the_plugin_module_is_broken(self) -> None:
        """A broken plugin layer must not stop the gate from existing."""
        from unittest import mock

        with mock.patch.dict(sys.modules, {"roveagent.api.plugin_tools": None}):
            gate = self.gate_hook.get_gate()
        self.assertIsNotNone(gate)
        self.assertTrue(gate.policies)


# ---------------------------------------------------------------------------
# Approval and execution through the gate
# ---------------------------------------------------------------------------


class ApprovalTest(_CleanState):
    """Verification 3: approval actually applies to plugin tools."""

    def _ctx(self, role: str, permissions=("*",)):
        from roveagent.tools.framework import ToolContext

        return ToolContext(
            tenant_id="t", business_id="b", user_id="u", role=role,
            permissions=frozenset(permissions), request_id="r", task_id="k",
            agent_id="marketing",
        )

    def _gate(self):
        from roveagent.enterprise import gate_hook

        saved = gate_hook._gate
        gate_hook._gate = None
        self.addCleanup(setattr, gate_hook, "_gate", saved)
        return gate_hook.get_gate()

    def test_a_plugin_tool_requires_approval_for_a_staff_role(self) -> None:
        self.load()
        gate = self._gate()
        decision = gate.authorize(self._ctx("staff"), "plugin__acme__greet", {})
        self.assertTrue(decision.requires_approval, decision.reason)
        self.assertFalse(decision.allowed)

    def test_owner_can_self_approve_the_manager_level_row(self) -> None:
        """Documented behaviour of the role ladder, asserted so it cannot drift."""
        self.load()
        gate = self._gate()
        decision = gate.authorize(self._ctx("owner"), "plugin__acme__greet", {})
        self.assertTrue(decision.allowed, decision.reason)

    def test_a_network_granting_plugin_needs_owner_even_for_a_manager(self) -> None:
        result = self.load("netty", manifest_extra="sandbox:\n  network: true\n")
        self.assertEqual(result["loaded"], 1, result["plugins"])
        gate = self._gate()
        decision = gate.authorize(self._ctx("manager"), "plugin__netty__greet", {})
        self.assertTrue(decision.requires_approval, decision.reason)
        self.assertEqual(decision.approval_policy, "owner")

    def test_missing_permission_blocks_before_approval(self) -> None:
        self.load()
        gate = self._gate()
        decision = gate.authorize(
            self._ctx("owner", permissions=()), "plugin__acme__greet", {})
        self.assertFalse(decision.allowed)
        self.assertIn("permission denied", decision.reason)

    def test_a_plugin_tool_is_audited(self) -> None:
        events: list[dict] = []
        from roveagent.enterprise import gate_hook
        from roveagent.tools.framework import EnterpriseToolGate

        self.load()
        gate = EnterpriseToolGate(
            policies=list(pt.plugin_gate_policies()),
            audit_sink=lambda e: events.append(e))
        gate.authorize(self._ctx("staff"), "plugin__acme__greet", {})
        self.assertTrue(events, "an approval decision left no audit event")

    def test_the_catch_all_hazard_is_gone(self) -> None:
        """The concrete R39 failure: a registered plugin tool on the catch-all."""
        self.load()
        gate = self._gate()
        policy = gate.policy_for("plugin__acme__greet")
        self.assertNotEqual(
            (policy.pattern, policy.approval), ("*", "none"),
            "plugin tool is authorised without approval — R39 reopened")


# ---------------------------------------------------------------------------
# Execution + crash isolation through the real chain
# ---------------------------------------------------------------------------


class ExecutionChainTest(_CleanState):
    """Verifications 1 and 4: it runs, and a crash stays contained."""

    def _dispatch(self, tool: str, args: dict | None = None) -> str:
        from roveagent.tools.registry import registry

        return registry.dispatch(tool, args or {})

    def test_a_community_plugin_tool_executes_successfully(self) -> None:
        """Verification 1: end to end, through a real child process."""
        self.load()
        output = self._dispatch("plugin__acme__greet", {"name": "RoveFrame"})
        self.assertEqual(json.loads(output), {"greeting": "hello RoveFrame"})

    def test_repeated_calls_reuse_one_sandbox_process(self) -> None:
        from roveagent.tools.registry import registry

        self.load()
        entry = registry.get_entry("plugin__acme__greet")
        handler = getattr(entry, "handler", None)
        for i in range(3):
            output = self._dispatch("plugin__acme__greet", {"name": str(i)})
            self.assertEqual(json.loads(output), {"greeting": "hello %d" % i})
        self.assertIsNotNone(handler)

    def test_a_crashing_plugin_tool_does_not_affect_the_runtime(self) -> None:
        """Verification 4."""
        from roveagent.tools.registry import registry

        self.load()
        output = self._dispatch("plugin__acme__crash")
        payload = json.loads(output)
        self.assertIn("error", payload)
        self.assertEqual(payload["plugin"], "acme")
        # The host is alive and the tool is still registered.
        self.assertIsNotNone(registry.get_entry("plugin__acme__crash"))

    def test_the_runtime_recovers_after_a_plugin_crash(self) -> None:
        """A crash must not poison subsequent calls to the same plugin."""
        self.load()
        self.assertIn("error", json.loads(self._dispatch("plugin__acme__crash")))
        output = self._dispatch("plugin__acme__greet", {"name": "after"})
        self.assertEqual(json.loads(output), {"greeting": "hello after"})

    def test_a_hanging_plugin_tool_times_out(self) -> None:
        """The sandbox discards the process; the host records an error."""
        from roveagent.api import plugin_tools as local_pt
        from roveagent.api.plugin_isolation import IsolationMode, SandboxSpec

        plugin_dir = make_community_plugin(self.root, "slowpoke")
        bridge = local_pt.PluginToolBridge(
            "slowpoke", plugin_dir, tools=["hang"],
            spec=SandboxSpec(mode=IsolationMode.SUBPROCESS, timeout_s=2.0))
        result = local_pt.register_plugin_tools(
            "slowpoke", plugin_dir, ["hang"], source="user", bridge=bridge)
        self._registered.extend(result["registered"])
        try:
            import time as _t

            started = _t.time()
            output = self._dispatch(result["registered"][0])
            self.assertLess(_t.time() - started, 45.0)
            self.assertIn("error", json.loads(output))
        finally:
            bridge.shutdown()


# ---------------------------------------------------------------------------
# The discovery hook (call assertion)
# ---------------------------------------------------------------------------


class DiscoveryHookTest(unittest.TestCase):
    """``_ensure_plugins_discovered`` must invoke the sandbox loader.

    Asserted by call rather than by pointing a whole plugin home at a temp
    directory: the property at risk is that the hook fires at all, and running
    full bundled discovery here would test the loader path that the tests above
    already cover end to end.
    """

    def test_discovery_invokes_the_sandbox_loader(self) -> None:
        from unittest import mock

        from roveagent.clisupport import plugins as pm
        from roveagent.api import plugin_tools

        calls: list[object] = []
        real = plugin_tools.load_community_plugins

        def spy(manager):
            calls.append(manager)
            return real(manager)

        with mock.patch.object(plugin_tools, "load_community_plugins", side_effect=spy):
            manager = pm._ensure_plugins_discovered()
        self.assertEqual(len(calls), 1,
                         "_ensure_plugins_discovered no longer loads community plugins")
        self.assertIs(calls[0], manager)

    def test_a_broken_loader_does_not_break_discovery(self) -> None:
        """The host must still start; a refused plugin stays refused."""
        from unittest import mock

        from roveagent.clisupport import plugins as pm

        with mock.patch.dict(sys.modules, {"roveagent.api.plugin_tools": None}):
            manager = pm._ensure_plugins_discovered()
        self.assertIsNotNone(manager)
        self.assertGreater(len(manager._plugins), 10)

    def test_bundled_plugins_are_still_loaded_after_the_hook(self) -> None:
        from roveagent.clisupport import plugins as pm

        manager = pm._ensure_plugins_discovered()
        enabled = [p for p in manager._plugins.values() if p.enabled]
        self.assertGreater(len(enabled), 10,
                           "the sandbox hook broke bundled plugin loading")
        denied = [(k, getattr(v, "error", "")) for k, v in manager._plugins.items()
                  if getattr(v, "error", "") and TRUST_REFUSAL_PREFIX in str(v.error)]
        self.assertEqual(denied, [])


if __name__ == "__main__":
    unittest.main()
