"""Unified capability registry — the dynamic half of agent capability resolution.

The problem this closes
-----------------------

Agent capability was a single hardcoded table (``capability_router.AGENT_CAPABILITIES``)
mapping an agent to a fixed tuple of toolset names. Anything that appeared at
runtime — a sandbox-loaded plugin's tools, a newly configured media provider, a
skill's tool — was **registered in the tool registry and then invisible**: the
agent's toolset list never mentioned the toolset those tools landed in, so they
were never handed to the model.

That is the same failure as R39, one layer up: the mechanism worked, and no
capability reached the agent.

What this module is, and is not
-------------------------------

It IS the registry the resolver consults for capabilities that were not known
when the agent table was written. It is NOT a second agent system: it holds no
agents, no roles, and no execution authority. It records what exists and who may
see it, and the existing resolver + gate keep every decision they already made.

Two invariants, both enforced rather than documented
----------------------------------------------------

1. **A dynamic capability cannot shadow a base tool.** Registering a name that
   any agent's base resolution already produces is refused. Otherwise a plugin
   could register itself as ``terminal`` and inherit the meaning, the audits,
   and the approvals attached to that name while running entirely different
   code.

2. **A dynamic capability cannot grant permissions.** ``permissions`` on a
   capability is FILTERING information for the resolver, never authorisation.
   The gate still checks ``ToolContext.permissions`` against the policy row on
   every call. Registration makes a tool discoverable; it never makes it
   permitted. Same rule as the plugin framework's "declaration != grant".

Provider naming
---------------

``provider`` is a ``kind:identifier`` string (``plugin:acme``, ``media:fal``).
It exists so an operator can answer "what put this tool here" and so a single
provider's capabilities can be retracted together — which is what the plugin
disable path needs.
"""

from __future__ import annotations

import dataclasses
import re
import threading
from enum import Enum
from typing import Any, Iterable, Mapping, Optional

__all__ = [
    "CapabilityKind",
    "Capability",
    "CapabilityRegistry",
    "CapabilityConflict",
    "CAPABILITIES",
    "register_capability",
    "unregister_provider",
]

_PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]*:[A-Za-z0-9._:-]+$")


class CapabilityKind(str, Enum):
    """Where a capability came from. Drives grouping and provenance display.

    One entry per provider family, so ``provider:`` prefixes stay mechanical and
    a new capability source is a new enum member rather than a special case.
    """

    PLUGIN = "plugin"
    SKILL = "skill"
    MEDIA = "media"
    SEARCH = "search"
    SOCIAL = "social"
    MCP = "mcp"
    BUILTIN = "builtin"


class CapabilityConflict(ValueError):
    """A registration that would shadow an existing or base capability."""


@dataclasses.dataclass(frozen=True)
class Capability:
    """One dynamically available tool, with its provenance and audience."""

    name: str
    provider: str
    kind: CapabilityKind
    toolset: str = ""
    permissions: tuple[str, ...] = ()
    #: Which agents may see this. **Deny by default**: an empty tuple means NO
    #: agent, not every agent. Declaring a capability does not publish it.
    #:
    #: ``("*",)`` is the explicit wildcard for genuinely universal capabilities
    #: (a web search tool every agent may use). It is spelled out rather than
    #: implied, so "everyone can see this" is a decision someone wrote down and
    #: an operator can grep for.
    allowed_agents: tuple[str, ...] = ()
    risk_level: int = 0
    description: str = ""
    #: Free-form provenance for display ("sandbox plugin", "provider registry").
    source: str = ""

    #: The explicit wildcard entry in ``allowed_agents``.
    WILDCARD = "*"

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("capability name is required")
        if not self.provider.strip():
            raise ValueError("capability provider is required")
        if not isinstance(self.kind, CapabilityKind):
            raise ValueError(
                "kind must be a CapabilityKind; got %r" % (self.kind,))
        if _PROVIDER_RE.match(self.provider) is None:
            raise ValueError(
                "provider must be 'kind:identifier' (e.g. plugin:acme); got %r"
                % self.provider)
        if _provider_kind(self.provider) != self.kind.value:
            raise ValueError(
                "provider prefix %r does not match kind %r"
                % (_provider_kind(self.provider), self.kind.value))
        object.__setattr__(self, "permissions", tuple(self.permissions))
        object.__setattr__(self, "allowed_agents",
                           tuple(a.strip().lower() for a in self.allowed_agents if a.strip()))

    @property
    def restricted(self) -> bool:
        """True when this is NOT the explicit everyone-wildcard."""
        return self.WILDCARD not in self.allowed_agents

    @property
    def published_to_all(self) -> bool:
        return self.WILDCARD in self.allowed_agents

    def visible_to(self, agent_key: str) -> bool:
        """Whether *agent_key* may see this capability.

        Deny by default. An unnamed audience and an unknown agent both yield
        False, so the two ways this check could fail open — an empty list read as
        "everyone", and an unrecognised agent read as "trusted" — are both
        closed.
        """
        if self.published_to_all:
            return True
        key = str(agent_key or "").strip().lower()
        return bool(key) and key in self.allowed_agents

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "kind": self.kind.value,
            "toolset": self.toolset,
            "permissions": list(self.permissions),
            "allowed_agents": list(self.allowed_agents),
            "risk_level": self.risk_level,
            "description": self.description,
            "source": self.source,
        }


def _provider_kind(provider: str) -> str:
    return provider.split(":", 1)[0]


_BASE_TOOLSETS_CACHE: frozenset[str] = frozenset()
_BASE_TOOLSETS_READY = False
_BASE_DECLARED_CACHE: frozenset[str] = frozenset()
_BASE_DECLARED_READY = False


def _base_toolsets() -> frozenset[str]:
    """The toolset NAMES any agent's base profile reaches, includes expanded.

    **Static**: it comes from ``AGENT_CAPABILITIES`` and the ``TOOLSETS``
    declarations, neither of which changes at runtime. Cacheable for the process
    lifetime with no invalidation problem.
    """
    global _BASE_TOOLSETS_CACHE, _BASE_TOOLSETS_READY
    if _BASE_TOOLSETS_READY:
        return _BASE_TOOLSETS_CACHE
    names: set[str] = set()
    try:
        from roveagent.api.capability_router import AGENT_CAPABILITIES
        from roveagent.toolsets import TOOLSETS

        seen: set[str] = set()

        def _expand(name: str) -> None:
            key = str(name).strip()
            if not key or key in seen:
                return
            seen.add(key)
            names.add(key)
            spec = TOOLSETS.get(key) or {}
            for child in spec.get("includes") or []:
                _expand(str(child))

        for profile in AGENT_CAPABILITIES.values():
            for toolset in profile.toolsets:
                _expand(toolset)
    except Exception:  # noqa: BLE001 — absence of the table must not break registration
        names = set()
    _BASE_TOOLSETS_CACHE = frozenset(names)
    _BASE_TOOLSETS_READY = True
    return _BASE_TOOLSETS_CACHE


def _base_declared_tools() -> frozenset[str]:
    """Tool names the base toolsets DECLARE. Static; computed once.

    This is where most base tools actually come from. Measured on this tree:
    ``read_file`` is not a registry entry at all — it is declared by the ``file``
    toolset — so an implementation that only walked the registry reported an
    empty base set and silently accepted ``read_file`` as a new capability.
    """
    global _BASE_DECLARED_CACHE, _BASE_DECLARED_READY
    if _BASE_DECLARED_READY:
        return _BASE_DECLARED_CACHE
    names: set[str] = set()
    try:
        from roveagent.toolsets import TOOLSETS

        for toolset in _base_toolsets():
            spec = TOOLSETS.get(toolset) or {}
            for tool in spec.get("tools") or []:
                text = str(tool).strip()
                if text:
                    names.add(text)
    except Exception:  # noqa: BLE001 — declaration layer optional
        names = set()
    _BASE_DECLARED_CACHE = frozenset(names)
    _BASE_DECLARED_READY = True
    return _BASE_DECLARED_CACHE


def _registry_entries() -> list[Any]:
    """Every registered tool entry, across the registry's known accessors.

    Tries several shapes because getting this wrong is SILENT: an empty result
    would drop the registry half of the base set. The tool half is covered by
    :func:`_base_declared_tools`, so a wrong accessor degrades the guard rather
    than disabling it — but the result is still verified by a test that asserts a
    real base tool is refused.
    """
    try:
        from roveagent.tools.registry import registry
    except Exception:  # noqa: BLE001 — registry optional
        return []

    rows: list[Any] = []
    for accessor in ("_tools", "_entries"):
        found = getattr(registry, accessor, None)
        if isinstance(found, dict) and found:
            rows.extend(found.values())
    scoped = getattr(registry, "_scoped_tools", None)
    if isinstance(scoped, dict):
        for bucket in scoped.values():
            if isinstance(bucket, dict):
                rows.extend(bucket.values())
    if rows:
        return rows
    merged = getattr(registry, "_merged_tools", None)
    if callable(merged):
        try:
            found = merged(None)
            if isinstance(found, dict) and found:
                return list(found.values())
        except Exception:  # noqa: BLE001
            pass
    return []


def _base_tool_names() -> frozenset[str]:
    """Every tool name an agent reaches THROUGH A BASE TOOLSET.

    The union of two cheap parts:

      * **declared** tools — static, from the ``TOOLSETS`` tables;
      * **registered** tools whose own toolset is base-reachable — one registry
        enumeration plus a set membership each.

    Correct AND fast. The earlier form resolved every agent's toolset graph
    (3-6.7 s per call, re-paid on each tool registration); the first attempt to
    speed it up walked only the registry and reported an empty base set, which
    silently accepted ``read_file`` as a new capability. Both halves are needed.
    """
    base_toolsets = _base_toolsets()
    if not base_toolsets:
        return frozenset()
    names = set(_base_declared_tools())
    names.update(
        str(getattr(entry, "name", "") or "")
        for entry in _registry_entries()
        if str(getattr(entry, "toolset", "") or "") in base_toolsets
    )
    names.discard("")
    return frozenset(names)


def reset_base_tool_cache() -> None:
    """Drop the memoised base sets. For tests and for a forced rescan."""
    global _BASE_TOOLSETS_CACHE, _BASE_TOOLSETS_READY
    global _BASE_DECLARED_CACHE, _BASE_DECLARED_READY
    _BASE_TOOLSETS_CACHE = frozenset()
    _BASE_TOOLSETS_READY = False
    _BASE_DECLARED_CACHE = frozenset()
    _BASE_DECLARED_READY = False


class CapabilityRegistry:
    """Process-local registry of dynamically available capabilities.

    Thread-safe. Process-local on purpose: the capabilities describe tools
    registered in this process, so persisting them would describe a state that
    does not exist after a restart.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_name: dict[str, Capability] = {}
        self._generation = 0

    # -- mutation ------------------------------------------------------

    def register(self, capability: Capability, *, replace: bool = False,
                 base_tools: Optional[Iterable[str]] = None) -> Capability:
        """Add one capability. Raises :class:`CapabilityConflict` on a shadow.

        ``base_tools`` lets a caller supply the base set it already computed;
        omitting it derives the set from the agent table.
        """
        if not isinstance(capability, Capability):
            raise TypeError("register() expects a Capability")
        name = capability.name.strip()
        base = frozenset(base_tools) if base_tools is not None else _base_tool_names()

        if name in base:
            raise CapabilityConflict(
                "%r is already provided by the base agent capability table; a "
                "dynamic capability must not shadow a base tool — it would "
                "inherit that name's audits and approvals while running "
                "different code" % name)

        with self._lock:
            existing = self._by_name.get(name)
            if existing is not None and not replace:
                if existing == capability:
                    return existing
                raise CapabilityConflict(
                    "%r is already registered by %s; pass replace=True to "
                    "override deliberately" % (name, existing.provider))
            self._by_name[name] = capability
            self._generation += 1
        return capability

    def register_many(self, capabilities: Iterable[Capability], *,
                      replace: bool = False) -> list[Capability]:
        """Register a batch, stopping at the first conflict.

        Not atomic: rows registered before a conflict stay registered. That is
        the safe direction — a partially registered set is visible and can be
        retracted by provider, whereas a silent rollback would hide which rows
        an operator already saw.
        """
        out: list[Capability] = []
        base = _base_tool_names()
        for capability in capabilities:
            out.append(self.register(capability, replace=replace, base_tools=base))
        return out

    def unregister(self, name: str) -> bool:
        with self._lock:
            existed = self._by_name.pop(str(name).strip(), None) is not None
            if existed:
                self._generation += 1
            return existed

    def unregister_provider(self, provider: str) -> list[str]:
        """Remove every capability from one provider. Returns the names removed.

        This is the retraction primitive the plugin disable path uses: one
        provider identity, one call, no chance of leaving a stray row behind
        because a name was misspelled.
        """
        wanted = str(provider or "").strip()
        with self._lock:
            names = [n for n, c in self._by_name.items() if c.provider == wanted]
            for name in names:
                del self._by_name[name]
            if names:
                self._generation += 1
        return sorted(names)

    def clear(self) -> None:
        with self._lock:
            self._by_name.clear()
            self._generation += 1

    # -- queries -------------------------------------------------------

    @property
    def generation(self) -> int:
        return self._generation

    def get(self, name: str) -> Optional[Capability]:
        with self._lock:
            return self._by_name.get(str(name).strip())

    def all(self) -> tuple[Capability, ...]:
        with self._lock:
            return tuple(self._by_name[n] for n in sorted(self._by_name))

    def by_kind(self, kind: Any) -> tuple[Capability, ...]:
        wanted = kind if isinstance(kind, CapabilityKind) else CapabilityKind(str(kind))
        return tuple(c for c in self.all() if c.kind is wanted)

    def by_provider(self, provider: str) -> tuple[Capability, ...]:
        wanted = str(provider or "").strip()
        return tuple(c for c in self.all() if c.provider == wanted)

    def by_toolset(self, toolset: str) -> tuple[Capability, ...]:
        wanted = str(toolset or "").strip()
        return tuple(c for c in self.all() if c.toolset == wanted)

    def for_agent(self, agent_key: str) -> tuple[Capability, ...]:
        """Capabilities visible to *agent_key*, in name order."""
        return tuple(c for c in self.all() if c.visible_to(agent_key))

    def toolsets_for_agent(self, agent_key: str) -> tuple[str, ...]:
        """Toolset names an agent gains dynamically.

        This is what the resolver merges into the agent's requested toolsets;
        returning names rather than tool names keeps the merge at the same
        granularity the existing resolver already speaks.
        """
        return tuple(sorted({c.toolset for c in self.for_agent(agent_key) if c.toolset}))

    def snapshot(self) -> dict[str, Any]:
        rows = self.all()
        return {
            "total": len(rows),
            "generation": self._generation,
            "by_kind": {k.value: len(self.by_kind(k)) for k in CapabilityKind},
            "by_provider": _counts(c.provider for c in rows),
            "toolsets": sorted({c.toolset for c in rows if c.toolset}),
            "capabilities": [c.as_dict() for c in rows],
        }


def _counts(values: Iterable[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items()))


#: Process-level singleton. The resolver reads it; producers publish to it.
CAPABILITIES = CapabilityRegistry()


def register_capability(capability: Capability, *, replace: bool = False) -> Capability:
    return CAPABILITIES.register(capability, replace=replace)


def unregister_provider(provider: str) -> list[str]:
    return CAPABILITIES.unregister_provider(provider)
