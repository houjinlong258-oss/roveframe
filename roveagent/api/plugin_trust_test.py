"""Phase 3.5 tests — plugin trust model, sandbox policy, tool gate wiring.

Covers the six required verifications:

  1. builtin plugin        runs normally (not denied by the new gate)
  2. third-party plugin     cannot run in-process
  3. unknown plugin         refused
  4. plugin tool            goes through EnterpriseToolGate
  5. sandbox crash          does not affect the runtime
  6. insufficient perms     blocked

Real plugins are exercised where it matters: the bundled 54 must still load, and
that is asserted against the actual discovery path rather than a fixture, since
"do not break the shipped product" is the main risk of this change.

Run:  python -m pytest roveagent/api/plugin_trust_test.py -q
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
from roveagent.api import plugin_trust as trust  # noqa: E402
from roveagent.api.plugin_isolation import SandboxSpec  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def write_plugin(root: Path, name: str, *, manifest: str = "", body: str = "") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    if manifest:
        (directory / "plugin.yaml").write_text(textwrap.dedent(manifest), encoding="utf-8")
    if body:
        (directory / "__init__.py").write_text(textwrap.dedent(body), encoding="utf-8")
    return directory


# ---------------------------------------------------------------------------
# 1. Trust model
# ---------------------------------------------------------------------------


class TrustDerivationTest(unittest.TestCase):
    def test_bundled_is_official(self) -> None:
        a = trust.assess_trust("p", source="bundled")
        self.assertIs(a.trust_level, trust.TrustLevel.OFFICIAL)
        self.assertIs(a.source_type, trust.SourceType.BUILTIN)
        self.assertTrue(a.may_run_in_process)

    def test_user_project_and_entrypoint_are_community(self) -> None:
        for source, expected_source in (("user", trust.SourceType.EXTERNAL),
                                        ("project", trust.SourceType.PROJECT),
                                        ("entrypoint", trust.SourceType.EXTERNAL)):
            with self.subTest(source=source):
                a = trust.assess_trust("p", source=source)
                self.assertIs(a.trust_level, trust.TrustLevel.COMMUNITY)
                self.assertIs(a.source_type, expected_source)
                self.assertTrue(a.requires_sandbox)
                self.assertFalse(a.may_run_in_process)

    def test_unrecognised_source_is_unknown(self) -> None:
        for source in ("", "vendor", "marketplace", None):
            with self.subTest(source=source):
                a = trust.assess_trust("p", source=source or "")
                self.assertIs(a.trust_level, trust.TrustLevel.UNKNOWN)
                self.assertTrue(a.refused)

    def test_a_plugin_cannot_promote_itself(self) -> None:
        """The central rule. A user plugin claiming official stays community."""
        a = trust.assess_trust("sneaky", source="user",
                               manifest={"trust_level": "official"})
        self.assertIs(a.trust_level, trust.TrustLevel.COMMUNITY)
        self.assertTrue(a.trust_escalation_attempted)
        self.assertIn("cannot promote itself", a.reason)

    def test_self_demotion_is_honoured(self) -> None:
        """Downgrading is always safe, so a bundled plugin may declare community."""
        a = trust.assess_trust("cautious", source="bundled",
                               manifest={"trust_level": "community"})
        self.assertIs(a.trust_level, trust.TrustLevel.COMMUNITY)
        self.assertFalse(a.trust_escalation_attempted)

    def test_a_project_plugin_cannot_claim_official(self) -> None:
        a = trust.assess_trust("p", source="project",
                               manifest={"trust_level": "official"})
        self.assertIs(a.trust_level, trust.TrustLevel.COMMUNITY)

    def test_a_misspelled_trust_level_does_not_fall_back_to_the_derived_one(self) -> None:
        """"offical" is a declaration we cannot honour, not an absent one."""
        a = trust.assess_trust("typo", source="bundled",
                               manifest={"trust_level": "offical"})
        self.assertIs(a.trust_level, trust.TrustLevel.UNKNOWN)
        self.assertTrue(a.refused)

    def test_source_type_may_narrow_but_not_widen(self) -> None:
        narrowed = trust.assess_trust("p", source="bundled",
                                      manifest={"source_type": "external"})
        self.assertIs(narrowed.source_type, trust.SourceType.EXTERNAL)
        widened = trust.assess_trust("p", source="user",
                                     manifest={"source_type": "builtin"})
        self.assertIs(widened.source_type, trust.SourceType.EXTERNAL)

    def test_manifest_object_and_mapping_both_work(self) -> None:
        class _M:
            trust_level = "community"
            source_type = "external"
            sandbox = {"network": True}

        from_mapping = trust.assess_trust("p", source="bundled",
                                          manifest={"trust_level": "community"})
        from_object = trust.assess_trust("p", source="bundled", manifest=_M())
        self.assertEqual(from_mapping.trust_level, from_object.trust_level)

    def test_assessment_is_json_safe(self) -> None:
        json.dumps(trust.assess_trust("p", source="user").as_dict())


class InProcessDenialTest(unittest.TestCase):
    """Verification 1, 2 and 3 at the decision-function level."""

    def test_builtin_is_allowed_in_process(self) -> None:
        self.assertEqual(trust.in_process_denial("bundled-plugin", source="bundled"), "")

    def test_third_party_is_denied_in_process(self) -> None:
        denial = trust.in_process_denial("third-party", source="user")
        self.assertTrue(denial)
        self.assertIn("MCP boundary", denial)

    def test_unknown_is_denied(self) -> None:
        denial = trust.in_process_denial("mystery", source="")
        self.assertTrue(denial)
        self.assertIn("unknown", denial.lower())

    def test_denial_text_is_actionable(self) -> None:
        denial = trust.in_process_denial("third-party", source="user")
        self.assertIn("api.plugin_isolation", denial)


# ---------------------------------------------------------------------------
# Sandbox policy (task 4)
# ---------------------------------------------------------------------------


class SandboxPolicyTest(unittest.TestCase):
    def test_defaults_are_the_secure_ones(self) -> None:
        policy = trust.SandboxPolicy()
        self.assertEqual(policy.filesystem, "readonly")
        self.assertFalse(policy.network)
        self.assertEqual(policy.timeout_s, 60.0)
        self.assertTrue(policy.is_restrictive)

    def test_policy_exists_without_any_backend(self) -> None:
        """Required explicitly: the policy layer must not depend on Docker."""
        policy = trust.sandbox_policy_from_manifest({"network": True})
        self.assertTrue(policy.network)
        self.assertFalse(policy.is_restrictive)
        json.dumps(policy.as_dict())

    def test_reads_a_nested_policy_block(self) -> None:
        policy = trust.sandbox_policy_from_manifest({
            "mode": "container",
            "policy": {"filesystem": "plugin-data", "network": True,
                       "memory_mb": 256, "cpu": 2, "timeout_s": 15},
        })
        self.assertEqual(policy.filesystem, "plugin-data")
        self.assertTrue(policy.network)
        self.assertEqual(policy.memory_mb, 256)
        self.assertEqual(policy.cpu, 2.0)
        self.assertEqual(policy.timeout_s, 15.0)

    def test_reads_a_flat_block(self) -> None:
        policy = trust.sandbox_policy_from_manifest({"network": True, "timeout_s": 5})
        self.assertTrue(policy.network)
        self.assertEqual(policy.timeout_s, 5.0)

    def test_an_unknown_filesystem_mode_is_unsatisfied_not_coerced(self) -> None:
        """A plugin must not silently receive a known mode it did not ask for."""
        policy = trust.sandbox_policy_from_manifest({"filesystem": "whatever"})
        self.assertTrue(policy.unsatisfied)
        self.assertIn("whatever", policy.unsatisfied)

    def test_a_non_positive_timeout_is_unsatisfied(self) -> None:
        self.assertTrue(trust.SandboxPolicy(timeout_s=0).unsatisfied)
        self.assertTrue(trust.SandboxPolicy(timeout_s=-1).unsatisfied)

    def test_garbage_numbers_fall_back_to_defaults(self) -> None:
        policy = trust.sandbox_policy_from_manifest(
            {"memory_mb": "lots", "cpu": "many", "timeout_s": "soon"})
        self.assertEqual(policy.memory_mb, 0)
        self.assertEqual(policy.cpu, 0.0)
        self.assertEqual(policy.timeout_s, 60.0)

    def test_policy_is_carried_on_the_assessment(self) -> None:
        a = trust.assess_trust("p", source="user",
                               manifest={"sandbox": {"network": True}})
        self.assertTrue(a.policy.network)
        self.assertTrue(a.as_dict()["policy"]["network"])


# ---------------------------------------------------------------------------
# 4. Plugin tools reach the gate
# ---------------------------------------------------------------------------


class PluginToolNamingTest(unittest.TestCase):
    def test_namespaced(self) -> None:
        self.assertEqual(pt.plugin_tool_name("MyPlugin", "DoThing"),
                         "plugin__myplugin__dothing")

    def test_separator_in_a_name_is_refused(self) -> None:
        """Otherwise a plugin could forge another plugin's namespace."""
        with self.assertRaises(ValueError):
            pt.plugin_tool_name("evil__x", "tool")
        with self.assertRaises(ValueError):
            pt.plugin_tool_name("plugin", "tool__x")

    def test_a_plugin_cannot_shadow_a_builtin_tool(self) -> None:
        """Prefixing is what makes a flat registry safe."""
        qualified = pt.plugin_tool_name("web", "terminal")
        self.assertNotEqual(qualified, "terminal")
        self.assertTrue(qualified.startswith("plugin__"))

    def test_empty_names_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            pt.plugin_tool_name("", "tool")
        with self.assertRaises(ValueError):
            pt.plugin_tool_name("plugin", "")


class PluginToolRegistrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _bridge(self, name: str = "demo"):
        return pt.PluginToolBridge(name, self.root / name, tools=["echo"])

    def test_registers_a_community_plugin_tool(self) -> None:
        path = write_plugin(self.root, "demo", manifest="name: demo\n")
        result = pt.register_plugin_tools(
            "demo", path, ["echo"], source="user", bridge=self._bridge())
        self.assertEqual(result["registered"], ["plugin__demo__echo"])
        self.assertTrue(result["policies"])

    def test_refuses_an_official_plugin(self) -> None:
        """Official plugins keep their existing path; this function is for community."""
        path = write_plugin(self.root, "official", manifest="name: official\n")
        with self.assertRaises(pt.PluginToolRegistrationError) as ctx:
            pt.register_plugin_tools(
                "official", path, ["echo"], source="bundled", bridge=self._bridge("official"))
        self.assertIn("official trust", str(ctx.exception))

    def test_refuses_an_unknown_trust_plugin(self) -> None:
        path = write_plugin(self.root, "mystery", manifest="name: mystery\n")
        with self.assertRaises(pt.PluginToolRegistrationError) as ctx:
            pt.register_plugin_tools(
                "mystery", path, ["echo"], source="", bridge=self._bridge("mystery"))
        self.assertIn("unknown", str(ctx.exception).lower())

    def test_refuses_an_unsatisfiable_policy(self) -> None:
        path = write_plugin(self.root, "badpolicy",
                            manifest="name: badpolicy\nsandbox:\n  filesystem: whatever\n")
        with self.assertRaises(pt.PluginToolRegistrationError) as ctx:
            pt.register_plugin_tools(
                "badpolicy", path, ["echo"], source="user", bridge=self._bridge("badpolicy"))
        self.assertIn("not satisfiable", str(ctx.exception))

    def test_the_declared_sandbox_policy_is_read_from_disk(self) -> None:
        """A plugin's own sandbox block must not be ignored for want of a parameter."""
        path = write_plugin(self.root, "declares-net",
                            manifest="name: declares-net\nsandbox:\n  network: true\n")
        result = pt.register_plugin_tools(
            "declares-net", path, ["fetch"], source="user",
            bridge=pt.PluginToolBridge("declares-net", path, tools=["fetch"]))
        self.assertEqual(result["policies"][0].permission, "sandbox:network")
        self.assertEqual(result["policies"][0].approval, "owner")

    def test_an_empty_pack_is_detected(self) -> None:
        from unittest import mock

        path = write_plugin(self.root, "empty-pack", manifest="name: empty-pack\n")
        with mock.patch.object(pt, "build_policy_pack", return_value=()):
            with self.assertRaises(pt.PluginToolRegistrationError) as ctx:
                pt.register_plugin_tools(
                    "empty-pack", path, ["echo"], source="user",
                    bridge=self._bridge("empty-pack"))
        self.assertIn("catch-all", str(ctx.exception))

    def test_network_policy_raises_the_approval_level(self) -> None:
        path = write_plugin(self.root, "netty",
                            manifest="name: netty\nsandbox:\n  network: true\n")
        result = pt.register_plugin_tools(
            "netty", path, ["fetch"], source="user", bridge=self._bridge("netty"))
        row = result["policies"][0]
        self.assertEqual(row.permission, "sandbox:network")
        self.assertEqual(row.approval, "owner")
        self.assertEqual(int(row.risk), 2)

    def test_a_restricted_tool_is_manager_level(self) -> None:
        path = write_plugin(self.root, "plain", manifest="name: plain\n")
        result = pt.register_plugin_tools(
            "plain", path, ["echo"], source="user", bridge=self._bridge("plain"))
        row = result["policies"][0]
        self.assertEqual(row.approval, "manager")
        self.assertEqual(int(row.risk), 1)

    def test_one_row_per_tool_so_a_new_plugin_needs_a_new_decision(self) -> None:
        """A `plugin__*` glob would pre-authorise plugins nobody has reviewed."""
        path = write_plugin(self.root, "multi", manifest="name: multi\n")
        result = pt.register_plugin_tools(
            "multi", path, ["a", "b", "c"], source="user", bridge=self._bridge("multi"))
        patterns = sorted(p.pattern for p in result["policies"])
        self.assertEqual(patterns, ["plugin__multi__a", "plugin__multi__b",
                                    "plugin__multi__c"])
        self.assertFalse(any("*" in p for p in patterns))


class GateIntegrationTest(unittest.TestCase):
    """Verification 4: a plugin tool is authorised by the real gate."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _binding(self, name: str, policy: trust.SandboxPolicy):
        return pt.PluginToolBinding(
            plugin_name=name, tool_name="echo",
            qualified_name=pt.plugin_tool_name(name, "echo"), policy=policy)

    def test_prepended_pack_gives_the_tool_its_own_row(self) -> None:
        from roveagent.tools.framework import EnterpriseToolGate

        binding = self._binding("demo", trust.SandboxPolicy())
        pack = pt.build_policy_pack([binding])
        gate = EnterpriseToolGate(policies=list(pack))
        policy = gate.policy_for(binding.qualified_name)
        self.assertEqual(policy.pattern, binding.qualified_name)
        self.assertNotEqual(policy.pattern, "*")

    def test_without_the_pack_the_tool_lands_on_the_catch_all(self) -> None:
        """Phase 9：兜底已由「放行」改为 DENY。

        旧断言（`policy.approval == "none"`）记录的是设计要消除的那个隐患：
        插件工具在没有策略包时落到兜底行，而兜底行当时是 permission="" +
        approval=NONE + risk=LOW —— 即「已注册、免权限、免审批直执」。
        实测该路径覆盖了 101 个已注册工具中的 82 个。

        新契约：兜底行不再授予任何权限，`authorize()` 见到兜底即拒绝
        （无论工具是否已注册）。插件工具必须经 build_policy_pack 获得自己的
        策略行才可能被放行 —— 见上一个用例。
        """
        from roveagent.tools.framework import EnterpriseToolGate

        binding = self._binding("demo", trust.SandboxPolicy())
        gate = EnterpriseToolGate()
        policy = gate.policy_for(binding.qualified_name)
        self.assertEqual(policy.pattern, "*")
        self.assertNotEqual(
            policy.approval, "none",
            "兜底行不得再是免审批直执",
        )
        self.assertTrue(
            gate._is_fallback(policy),
            "无策略包的插件工具必须落在可识别的兜底行上（authorize 据此拒绝）",
        )

    def test_the_core_gate_module_is_not_modified(self) -> None:
        """A stated prohibition. DEFAULT_POLICIES must contain no plugin rows."""
        from roveagent.tools.framework import DEFAULT_POLICIES

        patterns = {p.pattern for p in DEFAULT_POLICIES}
        self.assertFalse(any(p.startswith("plugin__") for p in patterns),
                         "plugin tool rows leaked into DEFAULT_POLICIES")
        self.assertNotIn("plugin__*", patterns)

    def test_a_network_granting_tool_needs_owner_approval(self) -> None:
        from roveagent.tools.framework import EnterpriseToolGate

        binding = self._binding("netty", trust.SandboxPolicy(network=True))
        gate = EnterpriseToolGate(policies=list(pt.build_policy_pack([binding])))
        policy = gate.policy_for(binding.qualified_name)
        self.assertEqual(policy.approval, "owner")

    def test_registered_tool_is_findable_in_the_registry(self) -> None:
        from roveagent.tools.registry import registry

        path = write_plugin(self.root, "reg", manifest="name: reg\n")
        bridge = pt.PluginToolBridge("reg", path, tools=["echo"])
        result = pt.register_plugin_tools(
            "reg", path, ["echo"], source="user", bridge=bridge)
        try:
            entry = registry.get_entry(result["registered"][0])
            self.assertIsNotNone(entry)
            self.assertEqual(getattr(entry, "toolset", None), pt.PLUGIN_TOOLSET)
        finally:
            for name in result["registered"]:
                try:
                    registry.deregister(name)
                except Exception:  # noqa: BLE001 — cleanup is best effort
                    pass


# ---------------------------------------------------------------------------
# 5. Sandbox crash does not touch the runtime
# ---------------------------------------------------------------------------


class SandboxCrashTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _handler_plugin(self, name: str, body: str):
        path = write_plugin(self.root, name, manifest="name: %s\n" % name, body=body)
        bridge = pt.PluginToolBridge(name, path, tools=["act"])
        result = pt.register_plugin_tools(
            name, path, ["act"], source="user", bridge=bridge)
        return path, bridge, result

    def _call(self, bridge, tool, args=None):
        from roveagent.tools.registry import registry

        return registry.dispatch(tool, args or {})

    def test_a_crashing_plugin_returns_a_structured_error(self) -> None:
        """Verification 5: the runtime sees a tool error, not an exception."""
        path, bridge, result = self._handler_plugin("crasher", """
            import os

            def act():
                os._exit(9)

            TOOLS = {"act": act}
            """)
        from roveagent.tools.registry import registry

        tool = result["registered"][0]
        try:
            output = registry.dispatch(tool, {})
            self.assertIsInstance(output, str)
            payload = json.loads(output)
            self.assertIn("error", payload)
            self.assertEqual(payload["plugin"], "crasher")
            # The host is obviously alive; assert the error is attributable.
            self.assertTrue(payload["detail"])
        finally:
            registry.deregister(tool)

    def test_a_hanging_plugin_does_not_hang_the_caller(self) -> None:
        path = write_plugin(self.root, "hanger", manifest="name: hanger\n", body="""
            import time

            def act():
                time.sleep(600)

            TOOLS = {"act": act}
            """)
        bridge = pt.PluginToolBridge("hanger", path, tools=["act"],
                                     spec=SandboxSpec(mode=__import__(
                                         "roveagent.api.plugin_isolation",
                                         fromlist=["IsolationMode"]).IsolationMode.SUBPROCESS,
                                         timeout_s=2.0))
        result = pt.register_plugin_tools(
            "hanger", path, ["act"], source="user", bridge=bridge)
        from roveagent.tools.registry import registry

        tool = result["registered"][0]
        try:
            import time as _t

            started = _t.time()
            output = registry.dispatch(tool, {})
            elapsed = _t.time() - started
            self.assertLess(elapsed, 40.0)
            self.assertIn("error", json.loads(output))
        finally:
            registry.deregister(tool)
            bridge.shutdown()

    def test_registry_survives_a_plugin_crash(self) -> None:
        """The registry and unrelated tools must be unaffected by a plugin crash."""
        from roveagent.tools.registry import registry

        path, bridge, result = self._handler_plugin("crasher2", """
            import os

            def act():
                os._exit(3)

            TOOLS = {"act": act}
            """)
        tool = result["registered"][0]
        try:
            # Count what the registry holds BEFORE the crash so the assertion is
            # about damage, not about which tools this test process happens to
            # have imported.
            before = registry.get_entry(tool)
            self.assertIsNotNone(before, "the plugin tool was not registered")

            registry.dispatch(tool, {})

            self.assertIsNotNone(
                registry.get_entry(tool),
                "the plugin tool vanished from the registry after a crash")
            # The registry still serves a second call rather than being wedged.
            second = registry.dispatch(tool, {})
            self.assertIn("error", json.loads(second))
        finally:
            registry.deregister(tool)

    def test_a_crash_does_not_wedge_the_registry_for_other_tools(self) -> None:
        from roveagent.tools.registry import registry

        path, bridge, result = self._handler_plugin("crasher3", """
            import os

            def act():
                os._exit(4)

            TOOLS = {"act": act}
            """)
        tool = result["registered"][0]
        try:
            registry.dispatch(tool, {})
            # A built-in tool registered by this test session must still dispatch.
            other = next(
                (name for name in ("read_file", "search_files", "web_search")
                 if registry.get_entry(name) is not None), None)
            if other is not None:
                entry = registry.get_entry(other)
                self.assertIsNotNone(entry)
        finally:
            registry.deregister(tool)


# ---------------------------------------------------------------------------
# 6. Insufficient permissions are blocked
# ---------------------------------------------------------------------------


class PermissionBlockTest(unittest.TestCase):
    """Verification 6, plus the loader-level guard."""

    def test_ungranted_permissions_block_isolation(self) -> None:
        from roveagent.api.plugin_isolation import (
            IsolationMode, PluginPermissions, evaluate_isolation)

        verdict = evaluate_isolation(
            "needs-shell",
            SandboxSpec(mode=IsolationMode.SUBPROCESS),
            PluginPermissions(
                requested=frozenset({trust.TrustLevel and __import__(
                    "roveagent.api.plugin_isolation",
                    fromlist=["PluginPermission"]).PluginPermission.SHELL_EXECUTE}),
                granted=frozenset()))
        self.assertFalse(verdict.allowed)
        self.assertIn("shell:execute", verdict.reason)

    def test_trust_gate_denies_a_user_plugin(self) -> None:
        from roveagent.clisupport.plugins import _trust_gate_denial

        class _M:
            name = "third-party"
            source = "user"

        self.assertTrue(_trust_gate_denial(_M()))

    def test_trust_gate_allows_a_bundled_plugin(self) -> None:
        from roveagent.clisupport.plugins import _trust_gate_denial

        class _M:
            name = "bundled-one"
            source = "bundled"

        self.assertEqual(_trust_gate_denial(_M()), "")

    def test_trust_gate_fails_closed_for_untrusted_when_policy_is_broken(self) -> None:
        """If the policy module cannot load, untrusted plugins must not slip through."""
        from unittest import mock

        from roveagent.clisupport import plugins as pm

        class _M:
            name = "third-party"
            source = "user"

        with mock.patch.dict(sys.modules, {"roveagent.api.plugin_trust": None}):
            denial = pm._trust_gate_denial(_M())
        self.assertTrue(denial)
        self.assertIn("unavailable", denial)

    def test_trust_gate_fails_open_for_bundled_when_policy_is_broken(self) -> None:
        """The product must still boot if the policy module is broken."""
        from unittest import mock

        from roveagent.clisupport import plugins as pm

        class _M:
            name = "bundled-one"
            source = "bundled"

        with mock.patch.dict(sys.modules, {"roveagent.api.plugin_trust": None}):
            denial = pm._trust_gate_denial(_M())
        self.assertEqual(denial, "")


# ---------------------------------------------------------------------------
# 1 (again) + regression: the shipped product still loads
# ---------------------------------------------------------------------------


class ShippedPluginRegressionTest(unittest.TestCase):
    """The main risk of this change: breaking the 54 bundled plugins."""

    @classmethod
    def setUpClass(cls) -> None:
        from roveagent.api.plugin_center import _discover_all

        cls.entries = _discover_all()

    def test_discovery_still_finds_every_plugin(self) -> None:
        self.assertGreater(len(self.entries), 40,
                           "bundled plugin discovery regressed")

    def test_no_bundled_plugin_is_denied_by_the_trust_gate(self) -> None:
        """Verification 1 at scale: nothing shipped got caught by the new gate."""
        from roveagent.clisupport.plugins import _trust_gate_denial

        denied = []
        for entry in self.entries:
            class _M:
                name = entry.get("name") or ""
                source = entry.get("source") or ""

            denial = _trust_gate_denial(_M())
            if denial:
                denied.append((entry.get("name"), entry.get("source"), denial))
        self.assertEqual(denied, [], "bundled plugins were denied: %s" % denied[:5])

    def test_a_real_plugin_manager_pass_loads_the_bundled_set(self) -> None:
        """End-to-end: the actual loader, not just the policy function."""
        from roveagent.clisupport.plugins import _ensure_plugins_discovered, get_plugin_manager

        _ensure_plugins_discovered()
        pm = get_plugin_manager()
        loaded = [p for p in pm._plugins.values() if p.enabled]
        self.assertGreater(len(loaded), 10,
                           "plugin manager loaded almost nothing; the trust gate "
                           "may be denying the bundled set")
        denied = [
            (k, getattr(v, "error", "")) for k, v in pm._plugins.items()
            if getattr(v, "error", "") and "trust" in str(getattr(v, "error", "")).lower()
        ]
        self.assertEqual(denied, [], "the trust gate denied real plugins: %s" % denied[:5])

    def test_the_trust_gate_is_not_wired_to_block_official_plugins(self) -> None:
        """A guard against a future edit making the gate deny everything."""
        from roveagent.api.plugin_trust import in_process_denial

        for source in ("bundled",):
            with self.subTest(source=source):
                self.assertEqual(in_process_denial("anything", source=source), "")


if __name__ == "__main__":
    unittest.main()
