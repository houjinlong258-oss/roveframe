"""Plugin tools into the Tool Registry and through the gate (Phase 3.5, task 3).

The rule
--------

A plugin tool is a tool. It is registered in the same registry as every other
tool, it is dispatched through the same ``registry.dispatch``, and
``EnterpriseToolGate`` authorises it exactly as it authorises ``terminal`` or
``write_file``. There is no plugin-private path to execution, and a plugin
cannot call its own code directly: the only way in is a registered tool.

    Plugin Tool -> Registry -> Gate -> Sandbox -> (result)

Why the policy pack is mandatory, not optional
----------------------------------------------

``DEFAULT_POLICIES`` ends with a catch-all ``ToolPolicy("*", "", LOW, NONE)``,
and its own comment says the catch-all means "registered therefore allowed,
without approval". So a plugin tool that reaches the gate with no matching row
would be **executed without approval** — the gate would look like it was
working while authorising nothing.

This module therefore refuses to register a plugin tool unless its policy pack
covers the tool name. That converts a silent, dangerous default into a loud
error at registration time.

Why the pack is prepended rather than added to DEFAULT_POLICIES
--------------------------------------------------------------

``EnterpriseToolGate.__init__`` documents ``policies`` as prepended overrides.
Using that extension point keeps the gate's core logic untouched — a stated
prohibition — while still giving plugin tools explicit rows.

What a plugin tool is granted
-----------------------------

A plugin tool is ``MEDIUM`` risk with ``MANAGER`` approval by default, and
``HIGH``/``OWNER`` when its sandbox policy asks for network or writable
filesystem. The reasoning: a sandboxed plugin cannot touch the host, so the
residual risk is what it does through its declared capabilities, and those are
the two that reach outside.
"""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from roveagent.api.plugin_isolation import (
    IsolationMode,
    PluginPermissions,
    PluginSandboxProcess,
    SandboxError,
    SandboxSpec,
    parse_sandbox_spec,
    evaluate_isolation,
)
from roveagent.api.plugin_trust import (
    SandboxPolicy,
    TrustAssessment,
    assess_trust,
    read_manifest_mapping,
)

logger = logging.getLogger(__name__)

__all__ = [
    "PluginToolBinding",
    "PluginToolRegistrationError",
    "plugin_tool_name",
    "build_policy_pack",
    "policy_covers",
    "register_plugin_tools",
    "PluginToolBridge",
    "GatePolicyRegistry",
    "PLUGIN_GATE_POLICIES",
    "plugin_gate_policies",
    "SandboxPluginLoader",
    "SANDBOX_PLUGIN_LOADER",
    "load_community_plugins",
    "PluginLifecycleManager",
    "PLUGIN_LIFECYCLE",
    "PluginLifecycleError",
    "DisableOutcome",
    "ensure_capabilities_built",
    "reset_capability_build_flag",
    "PLUGIN_TOOLSET",
]

#: Toolset plugin tools are grouped under, so an agent capability profile can
#: grant "the plugin tools" as one intent.
PLUGIN_TOOLSET = "plugin"

#: Prefix that makes a plugin tool recognisable in the gate policy table and in
#: audit output. A short, fixed prefix also means one glob row can cover the
#: whole class when a deployment wants that.
PLUGIN_TOOL_PREFIX = "plugin__"


def _default_root() -> Path:
    """The kernel data root, matching ``enterprise.gate_hook.audit_root``.

    Prefers ``ROVEAGENT_ROOT`` because that is the kernel's authoritative root;
    ``ROVEAGENT_HOME`` is the legacy name and only a fallback. Writing audit rows
    to a different root than the gate would split the trail in two.
    """
    import os

    return Path(
        os.environ.get("ROVEAGENT_ROOT")
        or os.environ.get("ROVEAGENT_HOME")
        or Path.home() / ".roveagent"
    )


class PluginToolRegistrationError(RuntimeError):
    """A plugin tool could not be registered safely. Registration is refused."""


def plugin_tool_name(plugin_name: str, tool_name: str) -> str:
    """Namespaced tool name: ``plugin__<plugin>__<tool>``.

    Namespacing is not cosmetic. Two plugins shipping a tool called ``search``
    would otherwise collide in one flat registry, and a plugin could then
    shadow a built-in tool by naming itself after it. ``__`` is the separator
    because the existing tool names never contain it.
    """
    plugin = str(plugin_name or "").strip()
    tool = str(tool_name or "").strip()
    if not plugin or not tool:
        raise ValueError("plugin_name and tool_name are both required")
    for value, label in ((plugin, "plugin_name"), (tool, "tool_name")):
        if "__" in value:
            raise ValueError(
                "%s must not contain '__': it is the namespace separator" % label)
        if not value.replace("-", "").replace("_", "").replace(".", "").isalnum():
            raise ValueError(
                "%s %r may only contain letters, digits, '-', '_' and '.'"
                % (label, value))
    return "%s%s__%s" % (PLUGIN_TOOL_PREFIX, plugin.lower(), tool.lower())


def policy_covers(tool_name: str, pack: Sequence[Any]) -> bool:
    """True when *pack* has an explicit row matching *tool_name*.

    Uses the same ``fnmatch.fnmatchcase`` semantics as
    ``EnterpriseToolGate.policy_for``, so a tool this says is covered cannot
    still land on the catch-all once the pack is prepended.
    """
    import fnmatch

    return any(fnmatch.fnmatchcase(tool_name, getattr(p, "pattern", "")) for p in pack)


def build_policy_pack(
    bindings: Iterable["PluginToolBinding"],
) -> tuple[Any, ...]:
    """Build gate policy rows for a set of plugin tools.

    One row per tool — no glob. A glob such as ``plugin__*`` would authorise
    every plugin tool that will ever exist at whatever level the glob names,
    including tools registered later by a plugin nobody has reviewed. Per-tool
    rows mean a new plugin needs a new decision, which is the point.
    """
    from roveagent.tools.framework import ApprovalPolicy, RiskLevel, ToolPolicy

    rows: list[Any] = []
    for binding in bindings:
        high_impact = binding.policy.network or binding.policy.filesystem != "readonly"
        rows.append(ToolPolicy(
            # The QUALIFIED name: that is what the registry dispatches and what
            # the gate matches. A row on the bare tool name would never fire,
            # and the call would fall through to the catch-all.
            binding.qualified_name,
            "sandbox:network" if binding.policy.network else "sandbox:execute",
            RiskLevel.HIGH if high_impact else RiskLevel.MEDIUM,
            ApprovalPolicy.OWNER if high_impact else ApprovalPolicy.MANAGER,
        ))
    return tuple(rows)


@dataclasses.dataclass(frozen=True)
class PluginToolBinding:
    """One plugin tool, ready to register."""

    plugin_name: str
    tool_name: str
    #: Full namespaced name, as it appears in the registry and the gate table.
    qualified_name: str
    description: str = ""
    schema: Optional[Mapping[str, Any]] = None
    policy: SandboxPolicy = dataclasses.field(default_factory=SandboxPolicy)
    assessment: Optional[TrustAssessment] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "plugin_name": self.plugin_name,
            "tool_name": self.tool_name,
            "qualified_name": self.qualified_name,
            "description": self.description,
            "policy": self.policy.as_dict(),
            "trust_level": (self.assessment.trust_level.value
                            if self.assessment else "unknown"),
        }


class PluginToolBridge:
    """Routes a registered plugin tool call to the plugin's sandbox process.

    Owns the process per plugin, lazily: a plugin whose tools are never called
    never gets a process. Every call goes through
    :class:`~roveagent.api.plugin_isolation.PluginSandboxProcess`, so a plugin
    that hangs or dies during a tool call is contained by the boundary.

    The bridge does NOT authorise. It is reached only after the gate has
    approved the call.
    """

    def __init__(
        self, plugin_name: str, plugin_path: Any, *, tools: Sequence[str] = (),
        spec: Optional[SandboxSpec] = None, timeout_s: float = 60.0,
    ) -> None:
        self.plugin_name = plugin_name
        self.plugin_path = plugin_path
        self.tools = tuple(tools)
        mode = spec.mode if spec else IsolationMode.SUBPROCESS
        self.spec = spec or SandboxSpec(mode=mode, timeout_s=timeout_s)
        self._process: Optional[PluginSandboxProcess] = None

    def _ensure(self) -> PluginSandboxProcess:
        if self._process is not None and self._process.running:
            return self._process
        proc = PluginSandboxProcess(
            self.plugin_name, self.plugin_path, tools=self.tools, spec=self.spec)
        proc.start()
        self._process = proc
        return proc

    def call(self, tool_name: str, arguments: Mapping[str, Any]) -> Any:
        """Invoke one tool in the sandbox. Errors propagate as ``SandboxError``."""
        proc = self._ensure()
        return proc.call_tool(tool_name, dict(arguments))

    def shutdown(self) -> None:
        if self._process is not None:
            self._process.graceful_shutdown()
            self._process = None

    def describe(self) -> dict[str, Any]:
        return {
            "plugin_name": self.plugin_name,
            "mode": self.spec.mode.value,
            "running": self._process is not None and self._process.running,
            "tools": list(self.tools),
        }


def resolve_plugin_manifest(plugin_path: Any, manifest: Any) -> Any:
    """Merge the on-disk manifest with an object manifest for assessment.

    The on-disk manifest is the AUTHORITY for ``sandbox`` and ``trust_level``
    because ``PluginManifest`` — the dataclass the plugin loader hands over —
    has no such fields (R42). Assessing only the object would silently ignore a
    plugin's own ``sandbox:`` block, which is how a plugin asking for
    ``network: true`` gets registered as if it had asked for nothing, and how
    ``filesystem: whatever`` goes unrefused.

    Fields the object does own (``name``, ``source``) win over the on-disk copy,
    so a caller that already normalised them is not overridden by raw text.

    Exported rather than inlined because both the loader (which needs the
    verdict before building a bridge) and ``register_plugin_tools`` (which needs
    it before building the policy pack) must agree; two copies of this merge
    would be two chances to disagree about what a plugin asked for.
    """
    if isinstance(manifest, Mapping):
        return manifest
    on_disk = read_manifest_mapping(plugin_path) if plugin_path is not None else {}
    if not on_disk:
        return manifest
    merged = dict(on_disk)
    for attr in ("name", "source"):
        value = getattr(manifest, attr, None)
        if value:
            merged[attr] = value
    return merged


def sandbox_spec_for_plugin(
    plugin_path: Any, manifest: Any, *, timeout_s: float,
) -> "SandboxSpec":
    """按插件**自己声明的** sandbox 模式构造 SandboxSpec（Phase 13 / P1-3）。

    修复前这里在两处硬编码 ``SandboxSpec(mode=IsolationMode.SUBPROCESS)``，
    于是 ``plugin_isolation.container_argv()`` 那套完整的容器硬化参数
    （``--network none`` / ``--read-only`` / ``--tmpfs`` / ``--user 65534``）
    **永远不可能被执行** —— 不是因为没实现，而是因为没有任何调用点会把
    ``mode`` 设成 CONTAINER。审计把这记作"容器模式是死代码"。

    这与本模块自身的契约直接矛盾：``parse_sandbox_spec`` 的文档写着

        A manifest that asks for confinement we cannot provide must NOT be
        silently downgraded.

    而硬编码 SUBPROCESS 恰恰就是那个静默降级：作者写了
    ``sandbox: {mode: container}``，运行时却在进程里跑。

    现在的行为：
      · manifest 声明 container 且引擎可用  -> 真跑容器
      · manifest 声明 container 但无引擎    -> ``PluginSandboxProcess.start()``
        抛出 SandboxStartError（拒绝加载），不再静默降级
      · manifest 未声明 / 声明 subprocess    -> 与修复前完全一致

    ``timeout_s`` 仍来自策略，不被 manifest 覆盖（超时属运营策略而非插件诉求）。
    """
    resolved = resolve_plugin_manifest(plugin_path, manifest)
    raw = resolved.get("sandbox") if isinstance(resolved, Mapping) else None
    spec = parse_sandbox_spec(raw)
    return dataclasses.replace(spec, timeout_s=timeout_s)


def register_plugin_tools(
    plugin_name: str, plugin_path: Any, tool_names: Sequence[str], *,
    source: str = "", manifest: Any = None, assessment: Optional[TrustAssessment] = None,
    description: str = "", schema: Optional[Mapping[str, Any]] = None,
    bridge: Optional[PluginToolBridge] = None,
    registry: Any = None, extra_policies: Sequence[Any] = (),
) -> dict[str, Any]:
    """Register a community plugin's tools so the gate governs them.

    Refuses, with a reason, when:

      * the plugin is not community trust (official plugins keep their existing
        in-process registration path; unknown is refused outright),
      * the plugin's sandbox policy is unsatisfiable,
      * the tools' policy rows would not cover them (the catch-all would then
        authorise them without approval).

    On success the fully-qualified names are returned so a caller can build the
    policy pack and hand it to ``EnterpriseToolGate(policies=...)``.
    """
    from roveagent.tools.registry import registry as default_registry

    registry = registry or default_registry

    # Resolve the declarations to use, then assess. See
    # ``resolve_plugin_manifest`` for why the on-disk copy wins on `sandbox`.
    resolved = resolve_plugin_manifest(plugin_path, manifest)
    verdict = assessment or assess_trust(plugin_name, source=source, manifest=resolved)

    if verdict.refused:
        raise PluginToolRegistrationError(
            "refusing to register tools for %r: %s" % (plugin_name, verdict.reason))
    if verdict.official:
        raise PluginToolRegistrationError(
            "%r is official trust and keeps its existing registration path; "
            "register_plugin_tools is for community plugins under the sandbox"
            % plugin_name)
    if not verdict.requires_sandbox:
        raise PluginToolRegistrationError(
            "%r is neither official nor community; refusing" % plugin_name)

    policy = verdict.policy
    if policy.unsatisfied:
        raise PluginToolRegistrationError(
            "sandbox policy for %r is not satisfiable: %s"
            % (plugin_name, policy.unsatisfied))

    if not tool_names:
        raise PluginToolRegistrationError(
            "%r declares no tools; nothing to register" % plugin_name)

    bindings: list[PluginToolBinding] = []
    for raw in tool_names:
        qualified = plugin_tool_name(plugin_name, raw)
        bindings.append(PluginToolBinding(
            plugin_name=plugin_name, tool_name=str(raw), qualified_name=qualified,
            description=description or "Tool provided by the %s plugin." % plugin_name,
            schema=schema, policy=policy, assessment=verdict))

    pack = tuple(build_policy_pack(bindings)) + tuple(extra_policies)
    uncovered = [b.qualified_name for b in bindings if not policy_covers(b.qualified_name, pack)]
    if uncovered:
        raise PluginToolRegistrationError(
            "no gate policy row covers %s; registering them would let the gate's "
            "catch-all authorise the calls without approval. Extend the pack."
            % ", ".join(uncovered))

    bridge = bridge or PluginToolBridge(
        plugin_name, plugin_path, tools=[b.tool_name for b in bindings],
        spec=sandbox_spec_for_plugin(plugin_path, manifest, timeout_s=policy.timeout_s))

    registered: list[str] = []
    for binding in bindings:
        registry.register(
            name=binding.qualified_name,
            toolset=PLUGIN_TOOLSET,
            schema=binding.schema or {
                "name": binding.qualified_name,
                "description": binding.description,
                "parameters": {"type": "object", "properties": {},
                               "additionalProperties": True},
            },
            handler=_make_handler(bridge, binding),
            emoji="\U0001F50C",
        )
        registered.append(binding.qualified_name)

    return {
        "plugin_name": plugin_name,
        "registered": registered,
        "policies": pack,
        "bindings": [b.as_dict() for b in bindings],
        "mode": bridge.spec.mode.value,
        "note": (
            "Registered into toolset %r. Pass the returned policies to "
            "EnterpriseToolGate(policies=...) — until then the gate will not "
            "have rows for these tools." % PLUGIN_TOOLSET
        ),
    }


def _make_handler(bridge: PluginToolBridge, binding: PluginToolBinding) -> Callable[..., str]:
    """Build the registry handler for one plugin tool.

    Returns a STRING because every registry handler in this tree does, and the
    agent loop expects text. A sandbox failure is rendered as a structured
    error rather than an exception: it is a tool outcome, not a host fault.
    """
    import json

    def handler(args: dict[str, Any], **_kwargs: Any) -> str:
        try:
            value = bridge.call(binding.tool_name, args or {})
        except SandboxError as exc:
            # The sandbox refused or the plugin misbehaved. Say which, and never
            # let this look like a host error.
            return json.dumps({
                "error": "plugin sandbox could not complete the call",
                "plugin": binding.plugin_name,
                "tool": binding.tool_name,
                "detail": str(exc),
            }, ensure_ascii=False)
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, default=str)

    handler.__name__ = "plugin_tool_%s" % binding.tool_name.replace("-", "_")
    return handler


# ---------------------------------------------------------------------------
# R39 closure: plugin policies actually reach the gate
# ---------------------------------------------------------------------------


class GatePolicyRegistry:
    """Collects plugin tool policies so the gate can prepend them.

    Before this existed, ``register_plugin_tools`` returned a policy pack that
    nobody consumed: plugin tools were registered in the tool registry, the
    pack was discarded, and every call fell through to the gate's catch-all
    row — which its own comment describes as "registered therefore allowed,
    without approval". The tools looked governed and were not.

    This registry is the missing link:

        PluginLoader -> register_plugin_tools() -> GatePolicyRegistry
                                                          |
                                            enterprise.gate_hook.get_gate()

    Thread-safe and process-local: policies die with the process, which is
    correct because the tools they govern are registered in the same process.
    """

    def __init__(self) -> None:
        self._lock = __import__("threading").Lock()
        self._by_plugin: dict[str, tuple[Any, ...]] = {}
        self._generation = 0

    def publish(self, plugin_name: str, pack: Sequence[Any]) -> None:
        """Record the rows for one plugin, replacing any previous set."""
        with self._lock:
            self._by_plugin[str(plugin_name)] = tuple(pack)
            self._generation += 1

    def retract(self, plugin_name: str) -> bool:
        """Drop one plugin's rows (used when a plugin is unloaded)."""
        with self._lock:
            existed = self._by_plugin.pop(str(plugin_name), None) is not None
            if existed:
                self._generation += 1
            return existed

    def clear(self) -> None:
        with self._lock:
            self._by_plugin.clear()
            self._generation += 1

    @property
    def generation(self) -> int:
        return self._generation

    def policies(self) -> tuple[Any, ...]:
        """All rows, sorted by pattern.

        Sorted globally, not merely grouped by plugin: a gate built at two
        different times from the same set must resolve a name to the same row.
        Registration order would otherwise leak into precedence — the exact
        implicit behaviour the policy table exists to remove. Safe to sort
        because every plugin row is an exact tool name, so no row can shadow
        another regardless of order.
        """
        with self._lock:
            rows = [row for name in sorted(self._by_plugin)
                    for row in self._by_plugin[name]]
        return tuple(sorted(rows, key=lambda row: getattr(row, "pattern", "")))

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "plugins": {name: [getattr(p, "pattern", "") for p in rows]
                            for name, rows in sorted(self._by_plugin.items())},
                "plugins_with_policies": len(self._by_plugin),
                "policy_rows": sum(len(rows) for rows in self._by_plugin.values()),
                "generation": self._generation,
            }


#: Process-level singleton the gate reads. Named in caps because it is a
#: module-level collaboration point, not a per-call value.
PLUGIN_GATE_POLICIES = GatePolicyRegistry()


def plugin_gate_policies() -> tuple[Any, ...]:
    """The rows a gate should prepend. Safe to call before anything is loaded."""
    return PLUGIN_GATE_POLICIES.policies()


# ---------------------------------------------------------------------------
# R41 closure: community plugins are LOADED, not merely refused
# ---------------------------------------------------------------------------
#
# Phase 3.5 made PluginManager refuse to import a community plugin, which was
# the safe half of the job. The other half — actually running it under the
# sandbox — had no caller, so a community plugin was refused and then nothing
# happened. This loader is that caller.
#
# It discovers its work from the refusals themselves: it walks the manager's
# entries and picks up exactly those whose error is a trust refusal. That means
# PluginManager needs no further change, the two halves cannot disagree about
# which plugins are community, and a plugin that stops being refused stops
# being sandbox-loaded without any extra bookkeeping.

#: Where a sandbox-loaded plugin's tools are recorded in the manager, so status
#: surfaces can show them without re-deriving anything.
SANDBOX_STATE_ATTR = "sandbox_state"


class SandboxPluginLoader:
    """Loads community plugins through the MCP boundary + sandbox.

    Never imports plugin code into the host process. A plugin whose tools are
    registered but never called costs one manifest read and nothing else: the
    sandbox process is started lazily by :class:`PluginToolBridge` on the first
    call.

    Also the lifecycle owner: :meth:`disable` removes every trace of a plugin —
    capability, tool, gate policy, sandbox process — and audits the removal.
    Registration without a matching teardown is how a "disabled" plugin keeps
    its tools; see R44.
    """

    def __init__(self, *, registry: Any = None, policies: Optional[GatePolicyRegistry] = None,
                 bridge_factory: Optional[Callable[..., PluginToolBridge]] = None,
                 capabilities: Any = None, audit: Any = None) -> None:
        self._registry = registry
        self._policies = policies or PLUGIN_GATE_POLICIES
        self._bridge_factory = bridge_factory or PluginToolBridge
        self._capabilities = capabilities
        self._audit = audit
        self._loaded: dict[str, dict[str, Any]] = {}
        # Bridges are retained so their sandbox processes can be STOPPED. Without
        # this the loader would hand a bridge to the registry and lose the only
        # handle to the child process: it would keep running (and, on Windows,
        # keep its plugin directory locked) with no way to shut it down.
        self._bridges: dict[str, PluginToolBridge] = {}

    # -- discovery -----------------------------------------------------

    def discover_candidates(self, manager: Any) -> list[tuple[str, Any]]:
        """Plugins the manager refused in-process for trust reasons.

        Reading the refusals rather than re-deriving trust keeps one authority:
        if the manager did not refuse it, this loader does not touch it.

        **R43**: an explicitly disabled plugin is also skipped here, even though
        the manager's ordering already means a disabled plugin never receives a
        trust refusal. The explicit check makes that ordering a guarantee this
        loader enforces for itself rather than a property it happens to inherit
        — if the discovery order ever changed, a disabled plugin would otherwise
        start running in a sandbox without anyone deciding that.
        """
        from roveagent.api.plugin_trust import TRUST_REFUSAL_PREFIX

        disabled = self._disabled_keys(manager)
        found: list[tuple[str, Any]] = []
        for key, loaded in getattr(manager, "_plugins", {}).items():
            if getattr(loaded, "enabled", False):
                continue
            error = str(getattr(loaded, "error", "") or "")
            if not error.startswith(TRUST_REFUSAL_PREFIX):
                continue
            manifest = getattr(loaded, "manifest", None)
            if manifest is None:
                continue
            if str(key).lower() in disabled or str(
                    getattr(manifest, "name", "")).lower() in disabled:
                logger.debug(
                    "skipping disabled plugin %r in the sandbox loader", key)
                continue
            found.append((str(key), manifest))
        return found

    @staticmethod
    def _disabled_keys(manager: Any) -> set[str]:
        """The config disabled-list, in lowercase. Fail-open to empty.

        Empty is the safe direction here because the manager has already had the
        final say on whether a plugin is disabled: this is a second, explicit
        confirmation, not the primary gate. If the config cannot be read, the
        refusal-based discovery still applies.
        """
        try:
            from roveagent.clisupport.plugins import _get_disabled_plugins

            return {str(v).strip().lower() for v in _get_disabled_plugins()}
        except Exception as exc:  # noqa: BLE001 — config layer optional
            logger.debug("disabled-plugin list unavailable: %s", exc)
            return set()

    # -- loading -------------------------------------------------------

    def load_one(self, key: str, manifest: Any) -> dict[str, Any]:
        """Sandbox-load one plugin. Returns a status record; never raises.

        A failure here is recorded, not propagated: one unloadable community
        plugin must not stop the others, and it must not stop host startup.
        """
        name = str(getattr(manifest, "name", "") or key)
        source = str(getattr(manifest, "source", "") or "")
        raw_path = getattr(manifest, "path", None)

        record: dict[str, Any] = {
            "plugin_key": key, "plugin_name": name, "source": source,
            "loaded": False, "reason": "", "tools": [], "policies": [],
        }

        if not raw_path:
            record["reason"] = "manifest declares no path"
            self._loaded[key] = record
            return record

        assessment = assess_trust(
            name, source=source,
            manifest=resolve_plugin_manifest(raw_path, manifest))
        if not assessment.requires_sandbox:
            record["reason"] = (
                "%s is not community trust (%s); the sandbox loader only handles "
                "community plugins" % (name, assessment.trust_level.value))
            self._loaded[key] = record
            return record

        configured = getattr(manifest, "provides_tools", None)
        tool_names = [str(t) for t in configured] if configured else []

        # Consent check against the EXISTING capability-consent layer.
        #
        # ``clisupport.plugin_capabilities`` already records which of a plugin's
        # declared capabilities an operator consented to, and the plugin
        # framework honours it. Without this call the sandbox path would be a
        # way AROUND that consent: a community plugin declaring a high-risk
        # capability (``roveagent.tools.override`` replaces built-in tools) would
        # be sandbox-loaded and made agent-visible with no consent recorded.
        # Sandboxing limits what a plugin can reach; it does not make the
        # consent screen optional.
        consent_refusal = self._consent_refusal(name, manifest)
        if consent_refusal:
            record["reason"] = consent_refusal
            self._loaded[key] = record
            return record

        if not tool_names:
            # Nothing to expose. Recorded as loaded-in-principle so status is
            # honest: the plugin exists, is sandboxed, and has no tools.
            record.update({"loaded": True,
                           "reason": "sandboxed; declares no tools to expose"})
            self._loaded[key] = record
            return record

        try:
            bridge = self._bridge_factory(
                name, Path(raw_path) if not isinstance(raw_path, Path) else raw_path,
                tools=tool_names,
                spec=sandbox_spec_for_plugin(
                    raw_path, manifest, timeout_s=assessment.policy.timeout_s),
            )
            result = register_plugin_tools(
                name, raw_path, tool_names, source=source, manifest=manifest,
                assessment=assessment, bridge=bridge, registry=self._registry,
            )
        except PluginToolRegistrationError as exc:
            record["reason"] = "registration refused: %s" % exc
            self._loaded[key] = record
            return record
        except Exception as exc:  # noqa: BLE001 — a plugin must not break loading
            record["reason"] = "load failed: %s: %s" % (type(exc).__name__, exc)
            self._loaded[key] = record
            return record

        self._policies.publish(name, result["policies"])
        self._bridges[key] = bridge
        published = self._publish_capabilities(
            name, result["registered"], assessment, raw_path, manifest)
        record.update({
            "loaded": True,
            "reason": "loaded under the MCP boundary + sandbox",
            "tools": list(result["registered"]),
            "policies": [getattr(p, "pattern", "") for p in result["policies"]],
            "capabilities": published,
            "mode": result["mode"],
        })
        self._loaded[key] = record
        self._audit_event(name, "plugin_sandbox_loaded", "ok",
                          "tools=%d capabilities=%d" % (len(result["registered"]),
                                                        len(published)))
        return record

    # -- capabilities (Phase 8.1.5, task 3) ---------------------------

    @staticmethod
    def _consent_refusal(plugin_name: str, manifest: Any) -> str:
        """Refuse a plugin whose declared capabilities were never consented to.

        Uses the pre-existing ``clisupport.plugin_capabilities`` layer rather
        than a second consent mechanism — one registry of what an operator
        agreed to, or the two would disagree and the weaker one would win.

        Fail-CLOSED when the consent layer itself cannot be consulted: an
        ungranted high-risk capability must not slip through because the check
        that would have caught it was unavailable. An empty declaration needs no
        consent, so a plugin declaring nothing is unaffected.
        """
        declared_raw = getattr(manifest, "capabilities", None)
        if declared_raw is None and not isinstance(manifest, Mapping):
            # PluginManifest owns `capabilities`; a mapping manifest may too.
            declared_raw = getattr(manifest, "capabilities", None)
        try:
            from roveagent.clisupport.plugin_capabilities import (
                parse_declared_capabilities, plugin_capability_granted,
            )

            declared = parse_declared_capabilities(declared_raw, plugin_name)
            if not declared:
                return ""
            ungranted = [
                cap for cap in declared
                if not plugin_capability_granted(plugin_name, cap)
            ]
        except Exception as exc:  # noqa: BLE001 — consent layer unavailable
            if not declared_raw:
                return ""
            return (
                "refusing to sandbox-load %r: it declares capabilities (%r) but the "
                "consent layer could not be consulted (%s: %s). Refusing rather "
                "than running a plugin whose declared capabilities are unverified."
                % (plugin_name, declared_raw, type(exc).__name__, exc))

        if ungranted:
            return (
                "refusing to sandbox-load %r: declared capabilities were never "
                "consented to: %s. Sandboxing limits what the plugin can reach; it "
                "does not make consent optional."
                % (plugin_name, ", ".join(sorted(ungranted))))
        return ""

    def _capability_registry(self) -> Any:
        if self._capabilities is not None:
            return self._capabilities
        from roveagent.api.capability_registry import CAPABILITIES

        return CAPABILITIES

    def _publish_capabilities(self, name: str, tools: Sequence[str],
                              assessment: Any, raw_path: Any,
                              manifest: Any = None) -> list[str]:
        """Make the loaded tools discoverable by an agent — to the RIGHT agents.

        Registering a tool in the tool registry is not enough: the agent's
        toolset list is what decides whether the model ever hears about it.

        **Audience comes from the manifest and defaults to deny** (Phase 8.1.6 /
        R47). Before this, a plugin's tools were visible to every agent, so a
        finance plugin's tools would have reached the marketing agent. A plugin
        that names no audience publishes nothing; ``allowed_agents: ["*"]`` is
        the explicit opt-in for genuinely universal tools.

        Failure is recorded, not raised. A capability-registry problem must not
        undo a successful sandbox load — the tools would then be registered but
        the plugin reported as failed, which is worse than either outcome alone.
        """
        try:
            from roveagent.api.capability_registry import Capability, CapabilityKind
            from roveagent.api.plugin_trust import read_capability_declaration

            declaration = read_capability_declaration(raw_path, manifest)
            if not declaration.declares_audience:
                logger.info(
                    "plugin %r loaded but publishes no capability: its manifest "
                    "declares no capability.allowed_agents, and the default is deny",
                    name)
                return []

            provider = "plugin:%s" % name
            registry = self._capability_registry()
            published: list[str] = []
            high_impact = declaration.risk_level >= 2
            for tool in tools:
                registry.register(Capability(
                    name=tool,
                    provider=provider,
                    kind=CapabilityKind.PLUGIN,
                    toolset=PLUGIN_TOOLSET,
                    permissions=("sandbox:network",) if high_impact else ("sandbox:execute",),
                    allowed_agents=declaration.allowed_agents,
                    risk_level=declaration.risk_level,
                    description="Tool provided by the %s plugin (sandboxed)." % name,
                    source="sandbox plugin loader",
                ), replace=True)
                published.append(tool)
            logger.info(
                "plugin %r published %d capability/ies to %s",
                name, len(published), ", ".join(declaration.allowed_agents))
            return published
        except Exception as exc:  # noqa: BLE001 — registry optional, load already succeeded
            logger.warning("could not publish capabilities for %r: %s", name, exc)
            return []

    def disable(self, key: str, *, reason: str = "", actor: str = "") -> dict[str, Any]:
        """Remove every trace of a sandbox-loaded plugin.

        Order matters and is deliberate:

          1. retract the gate policies — so a call that races this teardown is
             refused by the gate rather than dispatched into a dying process;
          2. retract the capabilities — so the resolver stops offering the tools;
          3. deregister the tools — so nothing can dispatch them;
          4. stop the sandbox process — last, because it is the only step that
             can block;
          5. audit — after the state is consistent, so the record cannot claim a
             removal that did not finish.

        Returns a structured result detailing what was actually removed, so a
        caller can tell "nothing was loaded" from "the teardown failed".
        """
        record = self._loaded.get(key)
        name = str((record or {}).get("plugin_name") or key)
        removed: dict[str, Any] = {"plugin": name, "key": key, "reason": reason}

        policies_removed = self._policies.retract(name)
        removed["policies_removed"] = policies_removed

        caps_removed: list[str] = []
        try:
            caps_removed = list(self._capability_registry().unregister_provider(
                "plugin:%s" % name))
        except Exception as exc:  # noqa: BLE001
            removed["capability_error"] = "%s: %s" % (type(exc).__name__, exc)
        removed["capabilities_removed"] = sorted(caps_removed)

        tools_removed: list[str] = []
        registry = self._registry
        if registry is None:
            from roveagent.tools.registry import registry as _default
            registry = _default
        for tool in list((record or {}).get("tools") or []):
            try:
                registry.deregister(tool)
                tools_removed.append(tool)
            except Exception as exc:  # noqa: BLE001 — best effort per tool
                logger.debug("deregister %s failed: %s", tool, exc)
        removed["tools_removed"] = tools_removed

        bridge = self._bridges.pop(key, None)
        removed["sandbox_stopped"] = False
        if bridge is not None:
            try:
                bridge.shutdown()
                removed["sandbox_stopped"] = True
            except Exception as exc:  # noqa: BLE001
                removed["sandbox_error"] = "%s: %s" % (type(exc).__name__, exc)

        self._loaded.pop(key, None)
        removed["audited"] = self._audit_event(
            name, "plugin_sandbox_disabled", "ok",
            "tools=%d capabilities=%d policies=%s reason=%s"
            % (len(tools_removed), len(caps_removed), policies_removed, reason or "-"),
            actor=actor)
        return removed

    def _audit_event(self, plugin: str, action: str, result: str, detail: str = "",
                     *, actor: str = "") -> bool:
        """Append one audit row. Returns whether it was written."""
        if self._audit is None:
            try:
                from roveagent.enterprise.audit import AuditLog

                root = _default_root()
                self._audit = AuditLog(root / "audit" / "plugin_sandbox.jsonl")
            except Exception as exc:  # noqa: BLE001
                logger.debug("plugin audit log unavailable: %s", exc)
                return False
        try:
            from roveagent.enterprise.audit import AuditEvent

            self._audit.record(AuditEvent(
                tenant_id="", agent=actor or "plugin_loader",
                action=action, detail="%s %s" % (plugin, detail), result=result))
            return True
        except Exception as exc:  # noqa: BLE001 — audit must not break teardown
            logger.warning("plugin audit write failed: %s", exc)
            return False

    def load_all(self, manager: Any) -> dict[str, Any]:
        """Load every refused community plugin. Idempotent per plugin key."""
        candidates = self.discover_candidates(manager)
        records: list[dict[str, Any]] = []
        for key, manifest in candidates:
            if key in self._loaded:
                records.append(self._loaded[key])
                continue
            records.append(self.load_one(key, manifest))

        loaded = [r for r in records if r["loaded"]]
        failed = [r for r in records if not r["loaded"]]
        return {
            "candidates": len(candidates),
            "loaded": len(loaded),
            "failed": len(failed),
            "plugins": records,
            "gate_policies": plugin_gate_policies(),
            "note": (
                "Community plugins are loaded through the MCP boundary + sandbox. "
                "No plugin module was imported into the host process."
            ),
        }

    # -- introspection -------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "loaded": {k: dict(v) for k, v in sorted(self._loaded.items())},
            "policies": self._policies.snapshot(),
        }

    def shutdown(self, key: Optional[str] = None) -> None:
        """Stop sandbox processes and retract their policies.

        ``key=None`` stops every loaded plugin. Secrets of state are cleaned in
        both cases: a process stopped but a policy left behind would authorise a
        tool whose handler can no longer run.
        """
        keys = list(self._loaded) if key is None else [key]
        for record_key in keys:
            bridge = self._bridges.pop(record_key, None)
            if bridge is not None:
                try:
                    bridge.shutdown()
                except Exception as exc:  # noqa: BLE001 — shutdown is best effort
                    logger.debug("bridge shutdown failed for %s: %s", record_key, exc)
            record = self._loaded.get(record_key)
            if record:
                self._policies.retract(record.get("plugin_name", record_key))
            self._loaded.pop(record_key, None)


#: Process-level loader. One instance so a second call to load_all is a no-op
#: rather than a second registration of the same tools.
SANDBOX_PLUGIN_LOADER = SandboxPluginLoader()


def load_community_plugins(manager: Any) -> dict[str, Any]:
    """Load community plugins for *manager*. Safe to call repeatedly."""
    return SANDBOX_PLUGIN_LOADER.load_all(manager)


# ---------------------------------------------------------------------------
# Phase 8.1.6 task 3: Plugin Lifecycle Manager
# ---------------------------------------------------------------------------
# ``SandboxPluginLoader.disable`` existed and was tested, but nothing called it:
# a plugin could be sandbox-loaded and then never unloaded. This is the caller,
# and it adds the step that a lifecycle entry point must have — a permission
# check before anything is torn down.


class PluginLifecycleError(RuntimeError):
    """A lifecycle request was refused."""


@dataclasses.dataclass(frozen=True)
class DisableOutcome:
    ok: bool
    plugin: str
    reason: str = ""
    removed: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "plugin": self.plugin, "reason": self.reason,
                "removed": dict(self.removed)}


class PluginLifecycleManager:
    """The single entry point for loading and unloading sandbox plugins.

    Permission check first, teardown second. The check is not ceremony: disabling
    a plugin removes tools an agent may be mid-call on and stops a process, so it
    is an administrative act, not a convenience.

    The ladder is the gate's: the actor's rank must strictly EXCEED the required
    one (``EnterpriseToolGate.check_approval`` uses the same ``>= required + 1``).
    With ``REQUIRED_ROLE = manager`` that means owner and admin may disable, and
    manager and below may not.

    Why manager rather than owner as the requirement: the tenant owner is who
    installs a plugin, so making the requirement ``owner`` would leave them
    unable to remove what they installed — only a platform admin could. Owner
    outranks manager, so ``manager`` gives exactly the intended set.
    """

    #: Roles allowed to disable a plugin, lowest first. Mirrors the gate ladder.
    ROLE_RANK: Mapping[str, int] = {
        "viewer": 0, "staff": 1, "manager": 2, "owner": 3, "admin": 4,
    }
    REQUIRED_ROLE = "manager"

    def __init__(self, loader: Optional[SandboxPluginLoader] = None,
                 *, audit: Any = None) -> None:
        self._loader = loader or SANDBOX_PLUGIN_LOADER
        self._audit = audit

    @property
    def loader(self) -> SandboxPluginLoader:
        return self._loader

    def can_disable(self, role: str) -> bool:
        """Whether *role* may disable a plugin.

        Requires strictly greater rank than the required role, matching
        ``EnterpriseToolGate.check_approval`` — so an owner (rank 3) can disable,
        and a manager (rank 2) cannot, even though a manager outranks staff.
        """
        rank = self.ROLE_RANK.get(str(role or "").strip().lower(), -1)
        required = self.ROLE_RANK.get(self.REQUIRED_ROLE, 99)
        return rank >= required + 1

    def disable(self, key: str, *, role: str, actor: str = "",
                reason: str = "") -> DisableOutcome:
        """Disable one plugin: check, then remove capability/tool/policy/sandbox/audit."""
        if not self.can_disable(role):
            self._audit_refusal(key, role, actor, reason)
            return DisableOutcome(
                ok=False, plugin=str(key),
                reason=("role %r may not disable a plugin; %s or above is required"
                        % (role or "<none>", self.REQUIRED_ROLE)))
        try:
            removed = self._loader.disable(key, reason=reason, actor=actor)
        except Exception as exc:  # noqa: BLE001 — report, never crash the caller
            return DisableOutcome(ok=False, plugin=str(key),
                                  reason="%s: %s" % (type(exc).__name__, exc))
        return DisableOutcome(ok=True, plugin=str(removed.get("plugin") or key),
                              removed=removed)

    def _audit_refusal(self, key: str, role: str, actor: str, reason: str) -> None:
        try:
            from roveagent.enterprise.audit import AuditEvent, AuditLog

            log = self._audit
            if log is None:
                log = AuditLog(_default_root() / "audit" / "plugin_sandbox.jsonl")
                self._audit = log
            log.record(AuditEvent(
                tenant_id="", agent=actor or "lifecycle",
                action="plugin_disable_refused",
                detail="%s role=%s reason=%s" % (key, role or "-", reason or "-"),
                result="denied"))
        except Exception as exc:  # noqa: BLE001 — audit must not mask the refusal
            logger.warning("could not audit a refused disable: %s", exc)

    def status(self) -> dict[str, Any]:
        return {
            "loaded": sorted(self._loader._loaded),
            "required_role": self.REQUIRED_ROLE,
            "role_rank": dict(self.ROLE_RANK),
        }


#: Process-level lifecycle entry point.
PLUGIN_LIFECYCLE = PluginLifecycleManager()


# ---------------------------------------------------------------------------
# Phase 8.1.6 task 4: startup capability rebuild (R48)
# ---------------------------------------------------------------------------
# The capability registry is process-local by design: it describes tools
# registered in this process. What it must NOT do is depend on residue — a
# process that restarts must rebuild from the real sources rather than hope
# something re-registers. This is that rebuild, and it is safe to call any
# number of times.


def ensure_capabilities_built(*, force: bool = False) -> dict[str, Any]:
    """Build the capability registry from every registered provider.

    ``force=False`` (default) builds once per process; ``force=True`` rebuilds,
    which is what a deployment wants after a plugin lifecycle change or a config
    reload. The result describes what every provider contributed, so a provider
    that contributed nothing is visible rather than indistinguishable from one
    that was never called.
    """
    global _CAPABILITIES_BUILT
    if _CAPABILITIES_BUILT and not force:
        return {"skipped": True, "reason": "already built"}
    try:
        from roveagent.api.capability_providers import (
            PROVIDERS, default_providers, rebuild_capabilities,
        )
    except Exception as exc:  # noqa: BLE001 — providers optional
        logger.debug("capability providers unavailable: %s", exc)
        return {"skipped": True, "reason": "providers unavailable: %s" % exc}

    # Register the shipped providers once; a caller may have added its own.
    if not PROVIDERS.ids():
        for provider in default_providers():
            try:
                PROVIDERS.add(provider)
            except Exception as exc:  # noqa: BLE001
                logger.warning("could not register provider %s: %s",
                               getattr(provider, "provider_id", "?"), exc)

    result = rebuild_capabilities()
    _CAPABILITIES_BUILT = True
    logger.info(
        "capability registry rebuilt: %d provider(s), %d capability/ies",
        result.get("providers"), result.get("capabilities"))
    return result


_CAPABILITIES_BUILT = False


def reset_capability_build_flag() -> None:
    """Test/deployment hook: let the next ``ensure_capabilities_built`` run."""
    global _CAPABILITIES_BUILT
    _CAPABILITIES_BUILT = False
