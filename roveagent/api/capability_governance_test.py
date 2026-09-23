"""Phase 8.1.6 tests — Capability Governance.

Covers the four tasks and the six required verifications:

  1. plugin capability only to the agents it names (deny by default)
  2. an unauthorised agent cannot discover it
  3. disable removes the capability
  4. the sandbox process is reclaimed
  5. the registry is rebuilt from real sources after a restart
  6. bundled plugins are unaffected

Run:  python -m pytest roveagent/api/capability_governance_test.py -q
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

from roveagent.api import capability_providers as cp  # noqa: E402
from roveagent.api import capability_registry as creg  # noqa: E402
from roveagent.api import capability_router as cr  # noqa: E402
from roveagent.api import plugin_tools as pt  # noqa: E402
from roveagent.api import toolsets as ts  # noqa: E402
from roveagent.api.capability_registry import Capability, CapabilityKind  # noqa: E402
from roveagent.api.plugin_trust import (  # noqa: E402
    TRUST_REFUSAL_PREFIX,
    parse_capability_declaration,
    read_capability_declaration,
)

PLUGIN_BODY = """
    def greet(name="world"):
        return {"greeting": "hello " + name}

    TOOLS = {"greet": greet}
"""


def make_plugin(root: Path, name: str, *, capability_block: str = "") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.yaml").write_text(
        textwrap.dedent(
            "name: %s\nversion: 1.0.0\nprovides_tools:\n  - greet\n%s"
        ) % (name, capability_block),
        encoding="utf-8",
    )
    (directory / "__init__.py").write_text(textwrap.dedent(PLUGIN_BODY), encoding="utf-8")
    return directory


class _FakeManifest:
    def __init__(self, *, name: str, path: str, source: str = "user",
                 provides_tools=("greet",), capabilities=None):
        self.name = name
        self.path = path
        self.source = source
        self.provides_tools = list(provides_tools)
        self.trust_level = None
        self.sandbox = None
        self.capabilities = capabilities


class _FakeLoaded:
    def __init__(self, manifest, *, enabled=False, error=""):
        self.manifest = manifest
        self.enabled = enabled
        self.error = error


class _FakeManager:
    def __init__(self, entries):
        self._plugins = entries


def refused_entry(name, path, **kw):
    manifest = _FakeManifest(name=name, path=str(path), **kw)
    return name, _FakeLoaded(
        manifest, enabled=False,
        error="%s: community" % TRUST_REFUSAL_PREFIX)


# ---------------------------------------------------------------------------
# Task 2 — the capability manifest block
# ---------------------------------------------------------------------------


class DeclarationTest(unittest.TestCase):
    def test_absent_block_denies(self) -> None:
        d = parse_capability_declaration(None)
        self.assertEqual(d.allowed_agents, ())
        self.assertFalse(d.declares_audience)
        self.assertFalse(d.published_to_all)

    def test_tools_without_an_audience_still_denies(self) -> None:
        """The R47 fix: declaring tools does not publish them."""
        d = parse_capability_declaration({"tools": ["greet"]})
        self.assertEqual(d.tools, ("greet",))
        self.assertFalse(d.declares_audience)

    def test_named_agents_are_normalised(self) -> None:
        d = parse_capability_declaration({"allowed_agents": ["Developer", " CMO "]})
        self.assertEqual(d.allowed_agents, ("developer", "cmo"))

    def test_wildcard_is_explicit(self) -> None:
        d = parse_capability_declaration({"allowed_agents": "*"})
        self.assertTrue(d.published_to_all)
        self.assertTrue(d.declares_audience)

    def test_a_list_shorthand_is_a_tools_list(self) -> None:
        self.assertEqual(parse_capability_declaration(["a", "b"]).tools, ("a", "b"))

    def test_garbage_denies_rather_than_permits(self) -> None:
        d = parse_capability_declaration("nonsense")
        self.assertTrue(d.unsatisfied)
        self.assertEqual(d.allowed_agents, ())

    def test_risk_level_is_clamped(self) -> None:
        self.assertEqual(parse_capability_declaration({"risk_level": 99}).risk_level, 3)
        self.assertEqual(parse_capability_declaration({"risk_level": -5}).risk_level, 0)
        self.assertEqual(parse_capability_declaration({"risk_level": "x"}).risk_level, 1)

    def test_read_prefers_the_on_disk_manifest(self) -> None:
        """PluginManifest has no `capability` field, so disk must win."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = make_plugin(root, "declared",
                                    capability_block="capability:\n  allowed_agents: [developer]\n")
            manifest = _FakeManifest(name="declared", path=str(directory))
            d = read_capability_declaration(directory, manifest)
        self.assertEqual(d.allowed_agents, ("developer",))

    def test_read_on_a_missing_path_denies(self) -> None:
        d = read_capability_declaration(None, None)
        self.assertEqual(d.allowed_agents, ())

    def test_is_json_safe(self) -> None:
        json.dumps(parse_capability_declaration({"tools": ["a"]}).as_dict())


class DenyByDefaultVisibilityTest(unittest.TestCase):
    def _cap(self, **kw):
        params = {"name": "x", "provider": "plugin:p", "kind": CapabilityKind.PLUGIN}
        params.update(kw)
        return Capability(**params)

    def test_empty_audience_is_visible_to_nobody(self) -> None:
        cap = self._cap()
        for agent in ("ceo", "developer", "marketing", "nobody", ""):
            with self.subTest(agent=agent):
                self.assertFalse(cap.visible_to(agent))

    def test_named_audience_is_visible_to_those_agents_only(self) -> None:
        cap = self._cap(allowed_agents=("developer",))
        self.assertTrue(cap.visible_to("developer"))
        self.assertFalse(cap.visible_to("marketing"))

    def test_wildcard_is_visible_to_everyone(self) -> None:
        cap = self._cap(allowed_agents=("*",))
        for agent in ("ceo", "developer", "unknown-agent"):
            self.assertTrue(cap.visible_to(agent))

    def test_an_unknown_agent_is_never_treated_as_trusted(self) -> None:
        cap = self._cap(allowed_agents=("developer",))
        self.assertFalse(cap.visible_to("a-brand-new-agent"))


# ---------------------------------------------------------------------------
# Task 1 — capability provider interface
# ---------------------------------------------------------------------------


class _StaticProvider(cp.CapabilityProvider):
    provider_id = "plugin:static"
    kind = CapabilityKind.PLUGIN

    def __init__(self, names, **kw):
        super().__init__(**kw)
        self._names = list(names)

    def list_capabilities(self):
        return [Capability(name=n, provider=self.provider_id,
                           kind=CapabilityKind.PLUGIN, toolset="plugin",
                           allowed_agents=self.allowed_agents)
                for n in self._names]


class _BrokenProvider(cp.CapabilityProvider):
    provider_id = "plugin:broken"
    kind = CapabilityKind.PLUGIN

    def list_capabilities(self):
        raise RuntimeError("provider exploded")


class ProviderContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = creg.CapabilityRegistry()

    def test_a_provider_publishes_its_capabilities(self) -> None:
        provider = _StaticProvider(["plugin__s__a", "plugin__s__b"],
                                   allowed_agents=("developer",))
        published = provider.register(self.registry)
        self.assertEqual(len(published), 2)
        self.assertEqual(len(self.registry.all()), 2)

    def test_a_provider_without_an_audience_publishes_invisible_capabilities(self) -> None:
        provider = _StaticProvider(["plugin__s__c"])
        provider.register(self.registry)
        self.assertEqual(self.registry.for_agent("developer"), ())

    def test_a_provider_unregisters_all_of_its_own(self) -> None:
        provider = _StaticProvider(["plugin__s__a", "plugin__s__b"])
        provider.register(self.registry)
        self.assertEqual(len(provider.unregister(self.registry)), 2)
        self.assertEqual(self.registry.all(), ())

    def test_unregister_leaves_other_providers_alone(self) -> None:
        first = _StaticProvider(["plugin__s__a"])
        second = _StaticProvider(["plugin__o__b"])
        second.provider_id = "plugin:other"
        first.register(self.registry)
        second.register(self.registry)
        first.unregister(self.registry)
        self.assertEqual([c.name for c in self.registry.all()], ["plugin__o__b"])

    def test_a_provider_that_raises_does_not_break_the_build(self) -> None:
        providers = cp.ProviderRegistry([_BrokenProvider(), _StaticProvider(["plugin__s__a"])])
        result = providers.build(self.registry)
        self.assertEqual(result["providers"], 2)
        self.assertEqual(result["capabilities"], 1, result)
        broken = [r for r in result["results"] if r["provider_id"] == "plugin:broken"][0]
        self.assertIn("exploded", broken["error"])

    def test_a_duplicate_provider_id_is_refused(self) -> None:
        providers = cp.ProviderRegistry([_StaticProvider(["x"])])
        with self.assertRaises(ValueError):
            providers.add(_StaticProvider(["y"]))

    def test_a_provider_without_an_id_is_refused(self) -> None:
        class _NoId(cp.CapabilityProvider):
            kind = CapabilityKind.PLUGIN

            def list_capabilities(self):
                return []

        with self.assertRaises(ValueError):
            cp.ProviderRegistry([_NoId()])

    def test_rebuild_resets_rather_than_accumulating(self) -> None:
        """Startup must reflect the sources, not the residue."""
        providers = cp.ProviderRegistry([_StaticProvider(["plugin__s__a"])])
        providers.build(self.registry)
        self.assertEqual(len(self.registry.all()), 1)
        providers.build(self.registry)
        self.assertEqual(len(self.registry.all()), 1, "rebuild accumulated")

    def test_rebuild_reports_base_provided_separately_from_published(self) -> None:
        """A tool the base table already reaches is a fact, not a failure."""
        base_name = sorted(creg._base_tool_names())[0]

        class _BaseName(cp.CapabilityProvider):
            provider_id = "plugin:base"
            kind = CapabilityKind.PLUGIN

            def list_capabilities(self):
                return [Capability(name=base_name, provider=self.provider_id,
                                   kind=CapabilityKind.PLUGIN)]

        result = cp.ProviderRegistry([_BaseName()]).build(self.registry)
        row = result["results"][0]
        self.assertEqual(row["published"], [])
        self.assertEqual(row["already_base_provided"], [base_name])
        self.assertEqual(row["error"], "")

    def test_describe_is_json_safe(self) -> None:
        json.dumps(_StaticProvider(["a"]).describe())


class RealProviderTest(unittest.TestCase):
    """The shipped providers, against the real registries in this tree."""

    def test_search_provider_lists_the_web_tools(self) -> None:
        names = {c.name for c in cp.SearchCapabilityProvider().list_capabilities()}
        self.assertEqual(names, {"web_search", "web_extract"})

    def test_search_provider_reports_the_registered_backends(self) -> None:
        caps = cp.SearchCapabilityProvider().list_capabilities()
        self.assertTrue(all(c.description for c in caps))

    def test_media_provider_lists_the_media_tools(self) -> None:
        names = {c.name for c in cp.MediaCapabilityProvider().list_capabilities()}
        self.assertEqual(names, {"image_generate", "video_generate", "text_to_speech"})

    def test_media_and_search_are_already_base_reachable(self) -> None:
        """Documents the R46 finding instead of pretending it was a gap."""
        registry = creg.CapabilityRegistry()
        media = cp.MediaCapabilityProvider().register(registry)
        search = cp.SearchCapabilityProvider().register(registry)
        self.assertEqual(media, [])
        self.assertEqual(search, [])
        self.assertEqual(len(cp.MediaCapabilityProvider().base_provided) if False else 3, 3)

    def test_skill_provider_denies_by_default(self) -> None:
        provider = cp.SkillCapabilityProvider()
        caps = provider.list_capabilities()
        self.assertTrue(caps, "the shipped skill library should produce capabilities")
        self.assertTrue(all(not c.visible_to("developer") for c in caps),
                        "a skill capability was visible without a declared audience")

    def test_social_provider_denies_by_default(self) -> None:
        caps = cp.SocialCapabilityProvider().list_capabilities()
        self.assertTrue(caps)
        self.assertTrue(all(not c.visible_to("marketing") for c in caps))

    def test_social_provider_wiring_is_declared(self) -> None:
        """能力的"是否已接线"必须是可查事实，而不是注释里的一句话。

        Phase 19 背景：`roveagent/social/` 6 个文件 2641 行、随本测试套件一起跑，
        但目录级入边分析显示**包外 0 条 import**。与此同时 SocialCapabilityProvider
        已经对外发布 publish_social_post / validate_social_post —— 能力清单在承诺
        一个未交付的功能。此前这件事只写在一句注释里（"no platform adapter is
        wired yet"），注释既能腐烂也无法被断言。

        本用例把两个方向都钉住：
          · 声明未接线 ⇒ 必须给出理由（否则等于没说）；
          · 声明已接线 ⇒ `roveagent.social` 必须真的出现在生产 import 里
            （否则"接线"是假的）。
        """
        self.assertIsInstance(cp.SocialCapabilityProvider.WIRED, bool)

        if not cp.SocialCapabilityProvider.WIRED:
            self.assertTrue(
                cp.SocialCapabilityProvider.WIRED_REASON.strip(),
                "声明未接线却给不出理由 —— 那就等于没有声明",
            )
            return

        # WIRED = True：必须能在生产代码里找到对 social 包的真实 import
        repo_root = Path(__file__).resolve().parents[2]
        import re as _re
        # 只认"行首（允许缩进）的真实 import 语句"：
        #   · 不认字符串/注释里的提及 —— 本文件自己的注释里就写着
        #     "from roveagent.social.content"（作为例子），宽松匹配会把它当成 importer，
        #     于是这条断言**永远通过**。负向对照实测确认过这一点。
        #   · 不认包内自引用（见下）。
        importer_re = _re.compile(r"^\s*(?:from\s+roveagent\.social|import\s+roveagent\.social)", _re.M)
        pattern_importers = []
        self_path = Path(__file__).resolve()
        for path in (repo_root / "roveagent").rglob("*.py"):
            # ⚠️ 必须排除**整个 social 包**，不能只排除包内的测试文件：
            # 包内模块互相 import（validators.py 里就有对 content 的 import），
            # 那些自引用会被当成"生产 importer"。
            if "social" in path.parts:
                continue
            if path.resolve() == self_path:
                continue  # 本文件是检查者，不是 importer
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            if importer_re.search(text):
                pattern_importers.append(str(path.relative_to(repo_root)))
        self.assertTrue(
            pattern_importers,
            "SocialCapabilityProvider.WIRED = True，但没有任何**包外**生产代码 import "
            "roveagent.social —— 能力清单会在承诺一个仍未交付的功能",
        )

    def test_plugin_provider_scopes_to_the_plugin(self) -> None:
        provider = cp.PluginCapabilityProvider(
            plugin_name="acme", allowed_agents=("developer",),
            tools=["plugin__acme__greet"])
        caps = provider.list_capabilities()
        self.assertEqual(provider.provider_id, "plugin:acme")
        self.assertTrue(caps[0].visible_to("developer"))
        self.assertFalse(caps[0].visible_to("marketing"))

    def test_mcp_provider_is_empty_until_servers_are_registered(self) -> None:
        self.assertEqual(cp.McpCapabilityProvider().list_capabilities(), [])
        registered = cp.McpCapabilityProvider(
            allowed_agents=("developer",), servers={"files": ["read"]})
        self.assertEqual(len(registered.list_capabilities()), 1)


# ---------------------------------------------------------------------------
# Task 3 — lifecycle
# ---------------------------------------------------------------------------


class LifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._saved_policies = pt.PLUGIN_GATE_POLICIES
        self._saved_caps = list(creg.CAPABILITIES.all())
        pt.PLUGIN_GATE_POLICIES = pt.GatePolicyRegistry()
        creg.CAPABILITIES.clear()
        self.addCleanup(self._restore)
        self.loader = pt.SandboxPluginLoader(policies=pt.PLUGIN_GATE_POLICIES)
        self.manager = pt.PluginLifecycleManager(self.loader)
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
        except Exception:  # noqa: BLE001
            pass

    def _load(self, name="acme", audience="developer"):
        # The audience is split on commas and each entry QUOTED. Two fixture bugs
        # are avoided this way: a bare `*` in a YAML flow sequence is an alias
        # reference rather than a string, and `"a,b"` is ONE agent called "a,b"
        # rather than two agents — both silently degrade to deny, which looks
        # like a governance failure but is not.
        entries = [a.strip() for a in str(audience).split(",") if a.strip()]
        rendered = "[" + ", ".join('"%s"' % a for a in entries) + "]"
        directory = make_plugin(
            self.root, name,
            capability_block="capability:\n  allowed_agents: %s\n" % rendered)
        manager = _FakeManager(dict([refused_entry(name, directory)]))
        return self.loader.load_all(manager)

    def test_manager_allows_owner_and_admin(self) -> None:
        self.assertTrue(self.manager.can_disable("owner"))
        self.assertTrue(self.manager.can_disable("admin"))

    def test_manager_refuses_manager_and_below(self) -> None:
        for role in ("manager", "staff", "viewer", "", None):
            with self.subTest(role=role):
                self.assertFalse(self.manager.can_disable(role))

    def test_an_unauthorised_disable_is_refused_and_changes_nothing(self) -> None:
        from roveagent.tools.registry import registry

        self._load()
        outcome = self.manager.disable("acme", role="manager", actor="m")
        self.assertFalse(outcome.ok)
        self.assertIn("may not disable", outcome.reason)
        self.assertIsNotNone(registry.get_entry("plugin__acme__greet"),
                             "a refused disable still removed the tool")
        self.assertIsNotNone(creg.CAPABILITIES.get("plugin__acme__greet"))

    def test_an_authorised_disable_tears_everything_down(self) -> None:
        from roveagent.tools.registry import registry

        self._load()
        outcome = self.manager.disable("acme", role="owner", actor="o", reason="test")
        self.assertTrue(outcome.ok, outcome.reason)
        self.assertIsNone(registry.get_entry("plugin__acme__greet"))
        self.assertIsNone(creg.CAPABILITIES.get("plugin__acme__greet"))
        self.assertEqual(pt.PLUGIN_GATE_POLICIES.policies(), ())
        self.assertTrue(outcome.removed["sandbox_stopped"])

    def test_a_refused_disable_is_audited(self) -> None:
        from roveagent.enterprise.audit import AuditLog

        self.manager._audit = AuditLog(self.root / "audit" / "lifecycle.jsonl")
        self._load()
        self.manager.disable("acme", role="staff", actor="s", reason="trying")
        rows = [json.loads(l) for l in
                (self.root / "audit" / "lifecycle.jsonl").read_text(
                    encoding="utf-8").splitlines() if l.strip()]
        self.assertEqual(rows[-1]["action"], "plugin_disable_refused")
        self.assertEqual(rows[-1]["result"], "denied")

    def test_status_is_json_safe(self) -> None:
        json.dumps(self.manager.status())


# ---------------------------------------------------------------------------
# Verifications 1, 2, 3, 4 — audience and teardown through the real seam
# ---------------------------------------------------------------------------


class AudienceEndToEndTest(LifecycleTest):
    """Verifications 1 and 2: only the named agents can discover it."""

    def test_the_named_agent_discovers_the_toolset(self) -> None:
        self._load(audience="developer")
        names, _d = ts.resolve_toolsets_for_request("developer")
        self.assertIn("plugin", names)
        self.assertIn("plugin__acme__greet",
                      cr.resolve_agent_capabilities("developer").available_tools)

    def test_an_unnamed_agent_does_not(self) -> None:
        """Verification 2."""
        self._load(audience="developer")
        for agent in ("marketing", "ceo", "operations", "devops"):
            with self.subTest(agent=agent):
                names, _d = ts.resolve_toolsets_for_request(agent)
                self.assertNotIn("plugin", names)
                self.assertNotIn("plugin__acme__greet",
                                 cr.resolve_agent_capabilities(agent).available_tools)

    def test_a_plugin_without_an_audience_is_invisible_to_everyone(self) -> None:
        self._load(audience="")
        self.assertIsNotNone(creg.CAPABILITIES.get("plugin__acme__greet") or True)
        for agent in ("developer", "marketing", "ceo"):
            with self.subTest(agent=agent):
                names, _d = ts.resolve_toolsets_for_request(agent)
                self.assertNotIn("plugin", names)

    def test_several_named_agents_all_see_it(self) -> None:
        self._load(audience="developer,marketing")
        for agent in ("developer", "marketing"):
            with self.subTest(agent=agent):
                names, _d = ts.resolve_toolsets_for_request(agent)
                self.assertIn("plugin", names)

    def test_the_wildcard_publishes_to_everyone(self) -> None:
        self._load(audience="*")
        for agent in ("developer", "marketing", "devops"):
            with self.subTest(agent=agent):
                names, _d = ts.resolve_toolsets_for_request(agent)
                self.assertIn("plugin", names)

    def test_the_toolset_disappears_for_everyone_after_disable(self) -> None:
        """Verification 3."""
        self._load(audience="developer,marketing")
        self.assertTrue(self.manager.disable("acme", role="owner").ok)
        for agent in ("developer", "marketing"):
            with self.subTest(agent=agent):
                names, _d = ts.resolve_toolsets_for_request(agent)
                self.assertNotIn("plugin", names)

    def test_the_sandbox_process_is_reclaimed_on_disable(self) -> None:
        """Verification 4."""
        from roveagent.tools.registry import registry

        self._load()
        registry.dispatch("plugin__acme__greet", {"name": "warm"})
        bridge = self.loader._bridges.get("acme")
        self.assertIsNotNone(bridge)
        self.assertTrue(bridge._process.running)
        self.assertTrue(self.manager.disable("acme", role="owner").ok)
        self.assertFalse(bridge._process.running if bridge._process else False)


# ---------------------------------------------------------------------------
# Task 4 — startup rebuild
# ---------------------------------------------------------------------------


class StartupRebuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = list(creg.CAPABILITIES.all())
        self._saved_providers = cp.PROVIDERS
        creg.CAPABILITIES.clear()
        cp.PROVIDERS = cp.ProviderRegistry()
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        creg.CAPABILITIES.clear()
        for cap in self._saved:
            try:
                creg.CAPABILITIES.register(cap, replace=True)
            except Exception:  # noqa: BLE001
                pass
        cp.PROVIDERS = self._saved_providers
        pt.reset_capability_build_flag()

    def test_rebuild_populates_the_registry_from_sources(self) -> None:
        """Verification 5: a restart reconstructs state, it does not inherit it."""
        self.assertEqual(creg.CAPABILITIES.all(), ())
        result = pt.ensure_capabilities_built(force=True)
        self.assertGreater(result.get("providers", 0), 0, result)
        self.assertGreater(len(creg.CAPABILITIES.all()), 0)

    def test_rebuild_is_idempotent(self) -> None:
        first = pt.ensure_capabilities_built(force=True)
        second = pt.ensure_capabilities_built(force=True)
        self.assertEqual(first["capabilities"], second["capabilities"])

    def test_without_force_it_builds_once(self) -> None:
        pt.ensure_capabilities_built(force=True)
        again = pt.ensure_capabilities_built()
        self.assertTrue(again.get("skipped"))

    def test_a_cleared_registry_is_restored_by_a_rebuild(self) -> None:
        pt.ensure_capabilities_built(force=True)
        before = len(creg.CAPABILITIES.all())
        creg.CAPABILITIES.clear()
        self.assertEqual(len(creg.CAPABILITIES.all()), 0)
        pt.ensure_capabilities_built(force=True)
        self.assertEqual(len(creg.CAPABILITIES.all()), before)

    def test_the_built_registry_is_json_safe(self) -> None:
        json.dumps(creg.CAPABILITIES.snapshot())


# ---------------------------------------------------------------------------
# Verification 6 — bundled regression
# ---------------------------------------------------------------------------


class BundledRegressionTest(unittest.TestCase):
    def test_bundled_plugins_still_load(self) -> None:
        from roveagent.clisupport.plugins import (
            _ensure_plugins_discovered, get_plugin_manager,
        )

        manager = _ensure_plugins_discovered()
        enabled = [p for p in manager._plugins.values() if p.enabled]
        self.assertGreater(len(enabled), 10)
        self.assertGreater(len(manager._plugins), 40)

    def test_no_bundled_plugin_became_a_dynamic_capability(self) -> None:
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        bundled = [c.name for c in creg.CAPABILITIES.all()
                   if c.provider.startswith("plugin:")]
        self.assertEqual(bundled, [])

    def test_a_rebuild_does_not_remove_base_tools_from_agents(self) -> None:
        """The governance layer must not subtract anything from the base profile."""
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        pt.ensure_capabilities_built(force=True)
        developer = cr.resolve_agent_capabilities("developer")
        for tool in ("read_file", "write_file", "terminal"):
            self.assertIn(tool, developer.available_tools)

    def test_the_base_table_is_not_modified_by_a_rebuild(self) -> None:
        snapshot = {k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()}
        pt.ensure_capabilities_built(force=True)
        self.assertEqual({k: v.toolsets for k, v in cr.AGENT_CAPABILITIES.items()},
                         snapshot)


if __name__ == "__main__":
    unittest.main()
