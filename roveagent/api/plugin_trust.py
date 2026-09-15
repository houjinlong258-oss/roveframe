"""Plugin trust model and sandbox policy (Phase 3.5).

Two-track plugin model
----------------------

    official   ships with the product      -> in-process, as today
    community  third-party                 -> MCP boundary + sandbox ONLY
    unknown    anything else               -> refused

Why a trust model rather than "sandbox everything"
--------------------------------------------------

Sandboxing all 54 bundled plugins would mean rewriting the ``PluginContext``
contract they register tools and hooks through — a rewrite the work explicitly
forbids, and unnecessary: bundled code is the product. The line drawn here is
the one browsers draw between built-in components and extensions, and it keeps
the blast radius of this change to plugins that are actually untrusted.

The rule that matters
---------------------

**A plugin cannot promote its own trust.** The effective level is the MINIMUM of
what the manifest declares and what discovery can prove from where the plugin
came. A user-installed plugin that writes ``trust_level: official`` in its
manifest is still ``community``; a bundled plugin may declare ``community`` and
be honoured, because downgrading is always safe. Declaration can lower trust,
never raise it.

Unknown trust is refused, not defaulted
---------------------------------------

The requirement is explicit, and it is the right default: a plugin whose
provenance cannot be established is exactly the one that should not be imported
into the host process. ``UNKNOWN`` therefore denies, and the denial says which
check failed rather than "denied".

Relationship to the rest of the tree
------------------------------------

  * ``api.plugin_isolation`` owns the runtime boundary (process, protocol) and
    the manifest read for ``sandbox``/``permissions``. This module owns the
    TRUST decision that decides whether that boundary is required at all.
  * ``tools.framework.EnterpriseToolGate`` is untouched. Plugin tools reach it
    through ``api.plugin_tools``, which uses the gate's documented prepend
    extension point.
"""

from __future__ import annotations

import dataclasses
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Optional

__all__ = [
    "TrustLevel",
    "SourceType",
    "SandboxPolicy",
    "TrustAssessment",
    "assess_trust",
    "in_process_denial",
    "requires_sandbox",
    "read_manifest_mapping",
    "KNOWN_TRUST_LEVELS",
    "KNOWN_SOURCE_TYPES",
    "TRUST_REFUSAL_PREFIX",
]

#: Every in-process refusal starts with this. The sandbox loader uses it to
#: find exactly the plugins PluginManager declined to import — one shared
#: constant rather than a substring duplicated in two modules, so a reworded
#: denial cannot silently stop the sandbox loader from seeing anything.
TRUST_REFUSAL_PREFIX = "refused in-process load"

KNOWN_TRUST_LEVELS = ("official", "community", "unknown")
KNOWN_SOURCE_TYPES = ("builtin", "external", "project", "unknown")


class TrustLevel(str, Enum):
    OFFICIAL = "official"
    COMMUNITY = "community"
    UNKNOWN = "unknown"


class SourceType(str, Enum):
    BUILTIN = "builtin"
    EXTERNAL = "external"
    PROJECT = "project"
    UNKNOWN = "unknown"


#: Trust implied by WHERE a plugin came from. This is the trustworthy half of
#: the assessment, because it is derived from discovery rather than asserted by
#: the plugin.
_SOURCE_TRUST: Mapping[str, tuple[TrustLevel, SourceType]] = {
    "bundled": (TrustLevel.OFFICIAL, SourceType.BUILTIN),
    "user": (TrustLevel.COMMUNITY, SourceType.EXTERNAL),
    "project": (TrustLevel.COMMUNITY, SourceType.PROJECT),
    "entrypoint": (TrustLevel.COMMUNITY, SourceType.EXTERNAL),
}

#: Rank used to combine declared and derived trust by taking the minimum.
_RANK: Mapping[TrustLevel, int] = {
    TrustLevel.UNKNOWN: 0,
    TrustLevel.COMMUNITY: 1,
    TrustLevel.OFFICIAL: 2,
}


@dataclasses.dataclass(frozen=True)
class SandboxPolicy:
    """What a sandboxed plugin is allowed to touch. Independent of any backend.

    This layer exists so the policy can be stated, reviewed, and enforced even
    on a host with no container engine — the requirement is explicit about that.
    The policy is what a plugin is ALLOWED; ``plugin_isolation.SandboxSpec`` is
    HOW it is launched. Keeping them apart means the policy does not change when
    the mechanism does (docker today, microVM tomorrow), and a policy can be
    evaluated and refused without any backend being present.
    """

    filesystem: str = "readonly"
    network: bool = False
    cpu: float = 0.0
    memory_mb: int = 0
    timeout_s: float = 60.0
    #: Extra writable paths, only meaningful when filesystem is not readonly.
    extra_writable_paths: tuple[str, ...] = ()
    #: Set when the manifest asked for something the policy layer rejects.
    unsatisfied: str = ""

    VALID_FILESYSTEM = ("readonly", "plugin-data", "unrestricted")

    def __post_init__(self) -> None:
        if self.filesystem not in self.VALID_FILESYSTEM:
            object.__setattr__(
                self, "unsatisfied",
                "filesystem must be one of %s; got %r"
                % (", ".join(self.VALID_FILESYSTEM), self.filesystem))
        if self.timeout_s <= 0:
            object.__setattr__(self, "unsatisfied",
                               "timeout_s must be positive; got %r" % (self.timeout_s,))

    @property
    def is_restrictive(self) -> bool:
        """The secure default: no network, read-only root, bounded time."""
        return self.filesystem == "readonly" and not self.network and self.timeout_s > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "filesystem": self.filesystem,
            "network": self.network,
            "cpu": self.cpu,
            "memory_mb": self.memory_mb,
            "timeout_s": self.timeout_s,
            "extra_writable_paths": list(self.extra_writable_paths),
            "is_restrictive": self.is_restrictive,
            "unsatisfied": self.unsatisfied,
        }


def sandbox_policy_from_manifest(raw: Any) -> SandboxPolicy:
    """Read ``sandbox.policy`` (or a flat ``sandbox`` block) into a policy.

    Defaults are the secure ones, and a value the policy layer does not accept
    (``filesystem: whatever``) becomes ``unsatisfied`` rather than being coerced
    — a plugin asking for an unknown filesystem mode must not silently receive
    one of the known ones.
    """
    if not isinstance(raw, Mapping):
        return SandboxPolicy()
    block = raw.get("policy")
    source = block if isinstance(block, Mapping) else raw

    filesystem = str(source.get("filesystem") or "readonly").strip().lower()
    network = bool(source.get("network", False))
    try:
        cpu = max(0.0, float(source.get("cpu") or source.get("cpus") or 0))
    except (TypeError, ValueError):
        cpu = 0.0
    try:
        memory_mb = max(0, int(source.get("memory_mb") or source.get("memory") or 0))
    except (TypeError, ValueError):
        memory_mb = 0
    try:
        timeout_s = float(source.get("timeout_s") or source.get("timeout") or 60.0)
    except (TypeError, ValueError):
        timeout_s = 60.0

    paths = source.get("extra_writable_paths") or source.get("writable_paths") or ()
    if isinstance(paths, str):
        paths = (paths,)
    return SandboxPolicy(
        filesystem=filesystem, network=network, cpu=cpu, memory_mb=memory_mb,
        timeout_s=timeout_s,
        extra_writable_paths=tuple(str(p) for p in paths if str(p).strip()),
    )


@dataclasses.dataclass(frozen=True)
class TrustAssessment:
    """The trust decision for one plugin, with its evidence."""

    plugin_name: str
    trust_level: TrustLevel
    source_type: SourceType
    #: What discovery proved, and what the manifest claimed. Kept separate so a
    #: reviewer can see when the two disagreed.
    derived_trust: TrustLevel
    declared_trust: Optional[TrustLevel] = None
    #: True when the manifest tried to claim MORE trust than its origin allows.
    trust_escalation_attempted: bool = False
    reason: str = ""
    policy: SandboxPolicy = dataclasses.field(default_factory=SandboxPolicy)

    @property
    def official(self) -> bool:
        return self.trust_level is TrustLevel.OFFICIAL

    @property
    def requires_sandbox(self) -> bool:
        return self.trust_level is TrustLevel.COMMUNITY

    @property
    def refused(self) -> bool:
        return self.trust_level is TrustLevel.UNKNOWN

    @property
    def may_run_in_process(self) -> bool:
        return self.official

    def as_dict(self) -> dict[str, Any]:
        return {
            "plugin_name": self.plugin_name,
            "trust_level": self.trust_level.value,
            "source_type": self.source_type.value,
            "derived_trust": self.derived_trust.value,
            "declared_trust": self.declared_trust.value if self.declared_trust else None,
            "trust_escalation_attempted": self.trust_escalation_attempted,
            "may_run_in_process": self.may_run_in_process,
            "requires_sandbox": self.requires_sandbox,
            "refused": self.refused,
            "reason": self.reason,
            "policy": self.policy.as_dict(),
        }


def _parse_declared(value: Any, *, field: str, known: tuple[str, ...]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text not in known:
        # An unrecognised value is not "no declaration" — it is a declaration we
        # cannot honour, and treating it as absent would let a typo
        # ("trust_level: offical") fall back to the derived level silently.
        return "__invalid__:%s" % text
    return text


def assess_trust(
    plugin_name: str, *, source: str = "", manifest: Any = None,
) -> TrustAssessment:
    """Decide a plugin's trust level from its origin and its manifest.

    ``manifest`` may be a mapping (the parsed plugin.yaml) or any object with
    ``trust_level``/``source_type``/``sandbox`` attributes, so this works with
    both ``PluginManifest`` and the raw frontmatter this project reads.

    The combination rule is MINIMUM, which is what makes self-promotion
    impossible.
    """
    def _field(name: str) -> Any:
        if manifest is None:
            return None
        if isinstance(manifest, Mapping):
            return manifest.get(name)
        return getattr(manifest, name, None)

    derived_trust, derived_source = _SOURCE_TRUST.get(
        str(source or "").strip().lower(), (TrustLevel.UNKNOWN, SourceType.UNKNOWN))

    raw_declared = _parse_declared(_field("trust_level"), field="trust_level",
                                   known=KNOWN_TRUST_LEVELS)
    raw_source = _parse_declared(_field("source_type"), field="source_type",
                                 known=KNOWN_SOURCE_TYPES)

    invalid_note = ""
    declared_trust: Optional[TrustLevel] = None
    if raw_declared is not None:
        if raw_declared.startswith("__invalid__:"):
            invalid_note = ("manifest declares an unrecognised trust_level %r; "
                            "treating the plugin as unknown"
                            % raw_declared.split(":", 1)[1])
            declared_trust = TrustLevel.UNKNOWN
        else:
            declared_trust = TrustLevel(raw_declared)

    declared_source: Optional[SourceType] = None
    if raw_source is not None:
        if raw_source.startswith("__invalid__:"):
            declared_source = SourceType.UNKNOWN
        else:
            declared_source = SourceType(raw_source)

    # Declared source_type may NARROW the derived one (external when discovery
    # said bundled is a safe self-demotion); it may not widen it.
    if declared_source is not None:
        if derived_source is SourceType.BUILTIN and declared_source is not SourceType.BUILTIN:
            source_type = declared_source
        else:
            source_type = derived_source
    else:
        source_type = derived_source

    escalation = False
    if declared_trust is not None:
        if _RANK[declared_trust] > _RANK[derived_trust]:
            escalation = True
            effective = derived_trust
        else:
            effective = declared_trust
    else:
        effective = derived_trust

    policy = sandbox_policy_from_manifest(_field("sandbox"))

    if escalation:
        reason = ("manifest claims trust_level=%s but discovery proves %s; the "
                  "lower level applies (a plugin cannot promote itself)"
                  % (declared_trust.value, derived_trust.value))
    elif invalid_note:
        reason = invalid_note
    elif effective is TrustLevel.OFFICIAL:
        reason = "ships with the product (%s)" % source_type.value
    elif effective is TrustLevel.COMMUNITY:
        reason = "third-party (%s); must run under the MCP boundary + sandbox" % source_type.value
    else:
        reason = ("trust level is unknown: discovery reported source %r, which "
                  "does not establish provenance" % (source or "<none>"))

    return TrustAssessment(
        plugin_name=plugin_name, trust_level=effective, source_type=source_type,
        derived_trust=derived_trust, declared_trust=declared_trust,
        trust_escalation_attempted=escalation, reason=reason, policy=policy,
    )


@dataclasses.dataclass(frozen=True)
class CapabilityDeclaration:
    """The ``capability:`` block a plugin manifest may carry (Phase 8.1.6).

    Shape::

        capability:
          tools: [greet, summarise]
          allowed_agents: [developer, cmo]
          risk_level: 2

    **Deny by default.** An absent block, an absent ``allowed_agents``, or an
    empty one all mean NO agent may see the plugin's tools. Declaring a
    capability never publishes it; naming an audience does. ``["*"]`` is the
    explicit everyone-wildcard for the rare case that genuinely wants it.

    This is the R47 fix: before it, a sandbox-loaded plugin's tools were visible
    to every agent, so a finance plugin's tools would have reached the marketing
    agent by default.
    """

    tools: tuple[str, ...] = ()
    allowed_agents: tuple[str, ...] = ()
    risk_level: int = 1
    #: Set when the block asked for something we cannot honour.
    unsatisfied: str = ""

    @property
    def declares_audience(self) -> bool:
        return bool(self.allowed_agents)

    @property
    def published_to_all(self) -> bool:
        return "*" in self.allowed_agents

    def as_dict(self) -> dict[str, Any]:
        return {
            "tools": list(self.tools),
            "allowed_agents": list(self.allowed_agents),
            "risk_level": self.risk_level,
            "published_to_all": self.published_to_all,
            "unsatisfied": self.unsatisfied,
        }


def parse_capability_declaration(raw: Any) -> CapabilityDeclaration:
    """Parse a ``capability`` block. Never raises; problems become ``unsatisfied``.

    A malformed block must not crash plugin loading, and must not silently
    become a permissive one: anything unparseable yields an empty audience,
    which is the deny default.
    """
    if raw is None:
        return CapabilityDeclaration()
    if isinstance(raw, (list, tuple)):
        # Tolerate `capability: [greet]` as a tools-only shorthand.
        raw = {"tools": list(raw)}
    if not isinstance(raw, Mapping):
        return CapabilityDeclaration(
            unsatisfied="capability must be a mapping or a list of tools")

    raw_tools = raw.get("tools")
    if isinstance(raw_tools, str):
        raw_tools = [raw_tools]
    tools = tuple(str(t).strip() for t in (raw_tools or []) if str(t).strip())

    raw_agents = raw.get("allowed_agents")
    if isinstance(raw_agents, str):
        raw_agents = [raw_agents]
    agents = tuple(
        str(a).strip().lower() for a in (raw_agents or []) if str(a).strip())

    try:
        risk = max(0, min(3, int(raw.get("risk_level", 1))))
    except (TypeError, ValueError):
        risk = 1

    unsatisfied = ""
    if raw_tools and not tools:
        unsatisfied = "capability.tools listed no usable names"
    if raw_agents and not agents:
        unsatisfied = "capability.allowed_agents listed no usable names"

    return CapabilityDeclaration(
        tools=tools, allowed_agents=agents, risk_level=risk, unsatisfied=unsatisfied)


def read_capability_declaration(plugin_path: Any, manifest: Any = None) -> CapabilityDeclaration:
    """Read the ``capability`` block, preferring the on-disk manifest.

    The on-disk copy wins for the same reason ``sandbox`` does: ``PluginManifest``
    has no such field, so an object-only read would silently ignore the plugin's
    own declaration.
    """
    resolved = manifest
    if not isinstance(manifest, Mapping):
        on_disk = read_manifest_mapping(plugin_path) if plugin_path is not None else {}
        if on_disk:
            resolved = on_disk
        elif manifest is None:
            resolved = {}
    if not isinstance(resolved, Mapping):
        return CapabilityDeclaration()
    return parse_capability_declaration(resolved.get("capability"))


def read_manifest_mapping(plugin_path: Any) -> dict[str, Any]:
    """Read a plugin's manifest into a plain mapping. Never raises.

    Returns ``{}`` when there is no manifest or it cannot be parsed. Callers
    that need to distinguish "no declaration" from "unreadable declaration"
    should use ``plugin_isolation.read_manifest_isolation``, which reports the
    error; this one exists for the common case where the manifest is optional
    and an unreadable one simply means no declarations.
    """
    from pathlib import Path

    directory = Path(plugin_path)
    if not directory.is_dir():
        return {}
    for name in ("plugin.yaml", "plugin.yml", "plugin.json"):
        candidate = directory / name
        if not candidate.is_file():
            continue
        try:
            text = candidate.read_text(encoding="utf-8")
            if candidate.suffix == ".json":
                import json

                value = json.loads(text)
            else:
                from roveagent.core.skill_utils import yaml_load

                value = yaml_load(text)
        except Exception:  # noqa: BLE001 — a broken manifest is "no declarations"
            return {}
        return dict(value) if isinstance(value, Mapping) else {}
    return {}


def requires_sandbox(assessment: TrustAssessment) -> bool:
    return assessment.requires_sandbox


def in_process_denial(
    plugin_name: str, *, source: str = "", manifest: Any = None,
) -> str:
    """Return "" when the plugin may be imported in-process, else the reason.

    This is the single function the loader consults. It returns a STRING rather
    than a bool so the refusal carries its explanation into ``LoadedPlugin.error``
    where an operator will actually see it.
    """
    assessment = assess_trust(plugin_name, source=source, manifest=manifest)
    if assessment.may_run_in_process:
        return ""
    if assessment.trust_escalation_attempted:
        return "%s: %s" % (TRUST_REFUSAL_PREFIX, assessment.reason)
    if assessment.requires_sandbox:
        return ("%s: %s. Load it through the MCP boundary + sandbox "
                "(api.plugin_isolation)." % (TRUST_REFUSAL_PREFIX, assessment.reason))
    return "%s: %s" % (TRUST_REFUSAL_PREFIX, assessment.reason)
