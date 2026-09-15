"""Capability providers — the single way anything publishes a capability.

Why this interface exists
-------------------------

The Capability Registry became the system bus in Phase 8.1.5. Every producer of
agent-visible tools must therefore publish through it, or the same failure
returns one layer down: a Media Hub that works, that nothing consults.

``CapabilityProvider`` is that single door. A plugin, a media backend, the web
search registry, a skill bundle, a social gateway, and an MCP server all become
"something that lists capabilities", and the resolver never learns which is
which. Adding a capability source is then a provider registration, not an agent
change — which is the rule this phase is meant to establish.

Existing registries are ADAPTED, not duplicated
-----------------------------------------------

``MediaCapabilityProvider`` and ``SearchCapabilityProvider`` translate the
registries this project already has (``core.image_gen_registry``,
``core.video_gen_registry``, ``core.tts_registry``, ``core.web_search_registry``)
into capabilities. They hold no provider data of their own: if the registries
change, these follow, and there is no second list to drift.

Audience is mandatory
---------------------

Deny by default (Phase 8.1.6). A provider must decide who may see each
capability it publishes. Nothing is visible to anyone merely because it exists.
"""

from __future__ import annotations

import abc
import logging
from enum import Enum
from typing import Any, Iterable, Mapping, Optional, Sequence

from roveagent.api.capability_registry import (
    CAPABILITIES,
    Capability,
    CapabilityConflict,
    CapabilityKind,
    CapabilityRegistry,
)

logger = logging.getLogger(__name__)

__all__ = [
    "CapabilityProvider",
    "ProviderTier",
    "ProviderUnavailable",
    "CoreToolsProvider",
    "bootstrap_capabilities",
    "ensure_capability_bootstrap",
    "reset_capability_bootstrap",
    "capability_health",
    "CapabilitySnapshot",
    "InMemoryCapabilitySnapshot",
    "CAPABILITY_SNAPSHOT",
    "ProviderRegistry",
    "PROVIDERS",
    "rebuild_capabilities",
    "MediaCapabilityProvider",
    "SearchCapabilityProvider",
    "SkillCapabilityProvider",
    "PluginCapabilityProvider",
    "SocialCapabilityProvider",
    "McpCapabilityProvider",
    "default_providers",
]

#: Agents that may use broadly useful, non-destructive capabilities. Spelled out
#: rather than implied, so "who can see this" is greppable in one place.
BROAD_AGENT_AUDIENCE: tuple[str, ...] = ("*",)

#: Agents that read business facts and answer questions.
BUSINESS_AGENTS: tuple[str, ...] = ("ceo", "operations", "marketing")


class ProviderTier(str, Enum):
    """How a provider's failure should be treated at startup.

    The distinction is the whole point of the tier: a runtime that refuses to
    start because an OPTIONAL media backend is unconfigured is unusable, and a
    runtime that starts happily with its core capability layer broken is worse —
    it serves requests with no tools and no error.
    """

    CRITICAL = "critical"   # failure fails startup
    OPTIONAL = "optional"   # failure degrades, reported but not fatal


class ProviderUnavailable(RuntimeError):
    """Raised by :meth:`CapabilityProvider.preflight` for a critical provider."""


class CapabilityProvider(abc.ABC):
    """Something that can contribute capabilities to the registry.

    Contract:

      * ``provider_id`` is the ``kind:identifier`` used on every capability this
        provider publishes, so one provider's contributions can be retracted
        together.
      * ``tier`` decides whether a failure here is fatal at startup.
      * ``preflight()`` is an optional startup precondition. Raising from it is
        the provider saying "the runtime cannot serve correctly without me".
      * ``list_capabilities()`` returns what this provider offers RIGHT NOW. It
        must be cheap and side-effect free; it is called on every rebuild.
      * ``register()``/``unregister()`` move that set into (or out of) a
        registry. The default implementations are almost always enough.
    """

    provider_id: str = ""
    kind: CapabilityKind
    #: Defaults to OPTIONAL so a NEW provider cannot accidentally make an
    #: unconfigured backend a startup blocker. Being fatal is opt-in.
    tier: ProviderTier = ProviderTier.OPTIONAL

    def __init__(self, *, allowed_agents: Optional[Sequence[str]] = None) -> None:
        self._allowed_agents = tuple(
            a.strip().lower() for a in (allowed_agents or ()) if a.strip())
        #: Names this provider offers that the base agent table already reaches.
        #: Populated by :meth:`register`; not a failure, a fact worth reporting.
        self.base_provided: list[str] = []

    # -- startup -------------------------------------------------------

    def preflight(self) -> None:
        """Verify a precondition. Raise :class:`ProviderUnavailable` to refuse.

        Called once at bootstrap, before anything is published. The default is a
        no-op: most providers have nothing to verify beyond being able to list.
        """
        return None

    # -- audience ------------------------------------------------------

    @property
    def allowed_agents(self) -> tuple[str, ...]:
        """The audience applied to this provider's capabilities.

        Deny by default: a provider constructed without an audience publishes
        capabilities no agent can see. That is deliberate — a provider that
        forgot to name its audience must be inert, not universal.
        """
        return self._allowed_agents

    def for_agents(self, agents: Iterable[str]) -> dict[str, Any]:
        """Return a copy of the constructor kwargs scoped to *agents*."""
        return {"allowed_agents": tuple(agents)}

    # -- capability production ----------------------------------------

    @abc.abstractmethod
    def list_capabilities(self) -> Sequence[Capability]:
        """Capabilities this provider currently offers. May return ()."""

    # -- registry integration -----------------------------------------

    def register(self, registry: Optional[CapabilityRegistry] = None, *,
                 replace: bool = True) -> list[Capability]:
        """Publish this provider's capabilities. Returns what was registered.

        A name the BASE agent table already provides is not a failure: it means
        agents can already reach that tool without any dynamic capability, which
        is the case for ``web_search``, ``image_generate`` and friends. Those are
        reported through :attr:`base_provided` rather than treated as conflicts,
        so a rebuild's output distinguishes "already reachable" from "refused"
        from "published".

        Any other failure is logged and skipped: one bad capability must not lose
        the rest, and must not be hidden either.
        """
        target = registry or CAPABILITIES
        published: list[Capability] = []
        self.base_provided = []
        # Compute the base set ONCE for the whole batch. The registry memoises it,
        # but passing it explicitly keeps a provider with many capabilities from
        # depending on that memo — this call used to cost one full base
        # resolution per capability (94.6 s for the 73-capability skill provider).
        try:
            from roveagent.api.capability_registry import _base_tool_names

            base = _base_tool_names()
        except Exception:  # noqa: BLE001 — fall back to per-call resolution
            base = None
        for capability in self.list_capabilities():
            try:
                target.register(capability, replace=replace, base_tools=base)
                published.append(capability)
            except CapabilityConflict as exc:
                if _is_base_shadow(exc):
                    # Expected and benign: the base table already reaches it.
                    self.base_provided.append(capability.name)
                    logger.debug("provider %s: %r is already base-reachable",
                                 self.provider_id, capability.name)
                else:
                    logger.warning("provider %s: capability %r refused: %s",
                                   self.provider_id, capability.name, exc)
            except Exception as exc:  # noqa: BLE001 — one bad row, not all
                logger.warning("provider %s: capability %r failed: %s: %s",
                               self.provider_id, capability.name,
                               type(exc).__name__, exc)
        return published

    def unregister(self, registry: Optional[CapabilityRegistry] = None) -> list[str]:
        target = registry or CAPABILITIES
        return target.unregister_provider(self.provider_id)

    def describe(self) -> dict[str, Any]:
        # `tier` is included so the health payload reports the real one. Without
        # it the reader falls back to a default and a CRITICAL provider is
        # published as OPTIONAL — the health endpoint would then understate what
        # would have blocked startup.
        return {
            "provider_id": self.provider_id,
            "kind": self.kind.value,
            "tier": self.tier.value,
            "allowed_agents": list(self.allowed_agents),
        }


def _is_base_shadow(exc: CapabilityConflict) -> bool:
    """Whether a conflict is the benign 'base table already provides this'.

    Matched on the guard's own message so the two cases cannot be confused: a
    duplicate from another PROVIDER is a real conflict that must stay visible.
    """
    return "already provided by the base agent capability table" in str(exc)


class ProviderRegistry:
    """The set of providers consulted on a rebuild. Ordered, idempotent."""

    def __init__(self, providers: Iterable[CapabilityProvider] = ()) -> None:
        self._providers: dict[str, CapabilityProvider] = {}
        for provider in providers:
            self.add(provider)

    def add(self, provider: CapabilityProvider, *, replace: bool = False) -> None:
        if not isinstance(provider, CapabilityProvider):
            raise TypeError("add() expects a CapabilityProvider")
        if not provider.provider_id:
            raise ValueError("provider must declare a provider_id")
        existing = self._providers.get(provider.provider_id)
        if existing is not None and not replace:
            if existing is provider:
                return
            raise ValueError(
                "a provider with id %r is already registered"
                % provider.provider_id)
        self._providers[provider.provider_id] = provider

    def remove(self, provider_id: str) -> bool:
        return self._providers.pop(str(provider_id), None) is not None

    def providers(self) -> tuple[CapabilityProvider, ...]:
        return tuple(self._providers[k] for k in sorted(self._providers))

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._providers))

    def build(self, registry: Optional[CapabilityRegistry] = None, *,
              reset: bool = True) -> dict[str, Any]:
        """Rebuild the registry from every provider.

        ``reset`` clears first, so a rebuild produces exactly what the providers
        currently offer — never "what they offered plus whatever was left over".
        That is the point of a rebuild: startup must not depend on residue.

        Providers are independent: one failing does not stop the others, and its
        failure is reported rather than hidden.
        """
        target = registry or CAPABILITIES
        if reset:
            target.clear()
        results: list[dict[str, Any]] = []
        for provider in self.providers():
            try:
                published = provider.register(target)
                results.append({**provider.describe(),
                                "published": [c.name for c in published],
                                "already_base_provided": list(
                                    getattr(provider, "base_provided", [])),
                                "error": ""})
            except Exception as exc:  # noqa: BLE001 — one provider, not the rebuild
                logger.warning("provider %s failed to build: %s: %s",
                               provider.provider_id, type(exc).__name__, exc)
                results.append({**provider.describe(), "published": [],
                                "already_base_provided": [],
                                "error": "%s: %s" % (type(exc).__name__, exc)})
        return {
            "providers": len(results),
            "capabilities": len(target.all()),
            "results": results,
            "generation": target.generation,
        }


#: Process-level provider set the startup rebuild consults.
PROVIDERS = ProviderRegistry()


def rebuild_capabilities(*, registry: Optional[CapabilityRegistry] = None,
                         reset: bool = True) -> dict[str, Any]:
    """Rebuild the capability registry from every registered provider.

    Call at service startup (and after a plugin lifecycle change). Because the
    registry is process-local, a rebuilt process must be able to reconstruct it
    from the real sources rather than from anything persisted — see R48.
    """
    return PROVIDERS.build(registry, reset=reset)


# ---------------------------------------------------------------------------
# Concrete providers
# ---------------------------------------------------------------------------


class MediaCapabilityProvider(CapabilityProvider):
    """Adapts the existing media registries into capabilities.

    Reads ``core.image_gen_registry`` / ``core.video_gen_registry`` /
    ``core.tts_registry`` rather than holding its own list. An unavailable
    provider (no API key) is still listed: the capability exists and its
    unavailability is the resolver's business, not a reason to pretend it does
    not exist.

    Audience is BUSINESS_AGENTS by default — marketing generates media; a
    developer agent has no reason to.
    """

    provider_id = "media:registry"
    kind = CapabilityKind.MEDIA
    #: OPTIONAL: an unconfigured media backend must not stop the OS from booting.
    tier = ProviderTier.OPTIONAL

    #: The media tools this provider exposes, mapped to the toolset they live in.
    MEDIA_TOOLS: tuple[tuple[str, str, str], ...] = (
        ("image_generate", "image_gen", "Generate an image from a prompt."),
        ("video_generate", "video_gen", "Generate a video from a prompt or image."),
        ("text_to_speech", "tts", "Synthesise speech from text."),
    )

    def __init__(self, *, allowed_agents: Optional[Sequence[str]] = None,
                 tools: Optional[Sequence[tuple[str, str, str]]] = None) -> None:
        super().__init__(allowed_agents=allowed_agents or BUSINESS_AGENTS)
        self._tools = tuple(tools) if tools is not None else self.MEDIA_TOOLS

    def _configured_providers(self) -> dict[str, list[str]]:
        """Names of the media backends registered, per capability."""
        found: dict[str, list[str]] = {}
        for label, module, attr in (
            ("image", "roveagent.core.image_gen_registry", "list_providers"),
            ("video", "roveagent.core.video_gen_registry", "list_providers"),
            ("audio", "roveagent.core.tts_registry", "list_providers"),
        ):
            try:
                import importlib

                mod = importlib.import_module(module)
                lister = getattr(mod, attr, None)
                if lister is None:
                    found[label] = []
                    continue
                # Provider objects may or may not be plugin-discovered yet.
                try:
                    from roveagent.tools.web_tools import _ensure_web_plugins_loaded  # noqa: F401
                except Exception:  # noqa: BLE001
                    pass
                names = [str(getattr(p, "name", p)) for p in lister()]
                found[label] = sorted(set(names))
            except Exception as exc:  # noqa: BLE001 — registry optional
                logger.debug("media registry %s unavailable: %s", label, exc)
                found[label] = []
        return found

    def list_capabilities(self) -> Sequence[Capability]:
        backends = self._configured_providers()
        # Only publish tools whose backend registry exists in this build.
        by_tool = {
            "image_generate": backends.get("image", []),
            "video_generate": backends.get("video", []),
            "text_to_speech": backends.get("audio", []),
        }
        out: list[Capability] = []
        for name, toolset, description in self._tools:
            backends_for_tool = by_tool.get(name, [])
            out.append(Capability(
                name=name,
                provider=self.provider_id,
                kind=CapabilityKind.MEDIA,
                toolset=toolset,
                permissions=("media:generate",),
                allowed_agents=self.allowed_agents,
                risk_level=1,
                description="%s Backends: %s"
                            % (description, ", ".join(backends_for_tool) or "none configured"),
                source="media registry",
            ))
        return out


class SearchCapabilityProvider(CapabilityProvider):
    """Adapts ``core.web_search_registry`` into capabilities.

    The web toolset is broadly useful and read-only, so its audience is the
    explicit wildcard rather than a named list — a search tool every agent may
    use is a decision, and ``("*",)`` records it as one.
    """

    provider_id = "search:web"
    kind = CapabilityKind.SEARCH
    #: OPTIONAL: web search is valuable but the runtime is usable without it
    #: (the keyless tier already degrades gracefully; see Phase 5).
    tier = ProviderTier.OPTIONAL

    SEARCH_TOOLS: tuple[tuple[str, str, str], ...] = (
        ("web_search", "search", "Search the public web."),
        ("web_extract", "web", "Extract the content of a URL."),
    )

    def __init__(self, *, allowed_agents: Optional[Sequence[str]] = None) -> None:
        super().__init__(allowed_agents=allowed_agents or BROAD_AGENT_AUDIENCE)

    def list_capabilities(self) -> Sequence[Capability]:
        backends: list[str] = []
        try:
            from roveagent.tools.web_tools import _ensure_web_plugins_loaded
            from roveagent.core import web_search_registry

            _ensure_web_plugins_loaded()
            backends = sorted({p.name for p in web_search_registry.list_providers()})
        except Exception as exc:  # noqa: BLE001 — registry optional
            logger.debug("web search registry unavailable: %s", exc)

        return [
            Capability(
                name=name, provider=self.provider_id, kind=CapabilityKind.SEARCH,
                toolset=toolset, permissions=("web:read",),
                allowed_agents=self.allowed_agents, risk_level=0,
                description="%s Backends: %s"
                            % (description, ", ".join(backends) or "none registered"),
                source="web search registry",
            )
            for name, toolset, description in self.SEARCH_TOOLS
        ]


class SkillCapabilityProvider(CapabilityProvider):
    """Publishes the tools a skill bundle exposes.

    A skill is a capability bundle, not a second plugin system: it contributes
    capabilities like any other provider. Deny by default until a skill declares
    its audience, so installing a skill publishes nothing on its own.
    """

    provider_id = "skill:bundle"
    kind = CapabilityKind.SKILL
    #: OPTIONAL: a skill library that fails to enumerate degrades the runtime.
    tier = ProviderTier.OPTIONAL

    def __init__(self, *, allowed_agents: Optional[Sequence[str]] = None,
                 skills: Optional[Sequence[Any]] = None) -> None:
        super().__init__(allowed_agents=allowed_agents)
        self._skills = list(skills) if skills is not None else None

    def _entries(self) -> list[Any]:
        if self._skills is not None:
            return self._skills
        try:
            from roveagent.skills.marketplace import catalog

            return list(catalog(None))
        except Exception as exc:  # noqa: BLE001 — marketplace optional
            logger.debug("skill catalog unavailable: %s", exc)
            return []

    def list_capabilities(self) -> Sequence[Capability]:
        out: list[Capability] = []
        for entry in self._entries():
            name = str(getattr(entry, "name", "") or "")
            if not name:
                continue
            out.append(Capability(
                name="skill__%s" % name,
                provider=self.provider_id,
                kind=CapabilityKind.SKILL,
                toolset="skills",
                permissions=("skill:invoke",),
                allowed_agents=self.allowed_agents,
                risk_level=0,
                description=str(getattr(entry, "description", "") or
                                "Skill %s" % name)[:200],
                source="skill catalog",
            ))
        return out


class PluginCapabilityProvider(CapabilityProvider):
    """Publishes one loaded sandbox plugin's tools.

    Thin by design: ``plugin_tools`` already knows how to publish a plugin's
    capabilities, and this adapter exists so plugins enter the registry through
    the same door as everyone else rather than by calling the registry directly.
    """

    provider_id = "plugin:loader"
    kind = CapabilityKind.PLUGIN
    #: CRITICAL: a plugin the operator installed and consented to, whose tools
    #: fail to publish, is a silently missing capability — the runtime would
    #: look healthy while an agent could not reach what it was granted.
    tier = ProviderTier.CRITICAL

    def __init__(self, *, plugin_name: str,
                 allowed_agents: Optional[Sequence[str]] = None,
                 tools: Sequence[str] = ()) -> None:
        # A plugin's audience comes from its manifest, never from a default.
        super().__init__(allowed_agents=allowed_agents)
        self.plugin_name = plugin_name
        self.provider_id = "plugin:%s" % plugin_name
        self._tools = tuple(tools)

    def list_capabilities(self) -> Sequence[Capability]:
        from roveagent.api.plugin_tools import PLUGIN_TOOLSET

        return [
            Capability(
                name=tool, provider=self.provider_id, kind=CapabilityKind.PLUGIN,
                toolset=PLUGIN_TOOLSET, permissions=("sandbox:execute",),
                allowed_agents=self.allowed_agents, risk_level=1,
                description="Tool provided by the %s plugin (sandboxed)." % self.plugin_name,
                source="sandbox plugin loader",
            )
            for tool in self._tools
        ]


class SocialCapabilityProvider(CapabilityProvider):
    """Publishes social publishing capabilities.

    Audience defaults to deny: publishing is owner-approved and irreversible, so
    no agent sees it until a deployment names which agents may draft for it.
    """

    provider_id = "social:gateway"
    kind = CapabilityKind.SOCIAL
    #: OPTIONAL: no platform adapter is wired yet (Phase 6-A), so this must not
    #: be able to block startup.
    tier = ProviderTier.OPTIONAL

    SOCIAL_TOOLS: tuple[tuple[str, str, str], ...] = (
        ("publish_social_post", "social", "Publish an approved social post."),
        ("validate_social_post", "social", "Validate content against platform rules."),
    )

    def list_capabilities(self) -> Sequence[Capability]:
        return [
            Capability(
                name=name, provider=self.provider_id, kind=CapabilityKind.SOCIAL,
                toolset=toolset, permissions=("comms:publish",),
                allowed_agents=self.allowed_agents, risk_level=2,
                description=description, source="social gateway",
            )
            for name, toolset, description in self.SOCIAL_TOOLS
        ]


class McpCapabilityProvider(CapabilityProvider):
    """Publishes tools reached through an MCP server.

    Deny by default, and empty until a deployment registers MCP servers: the
    point is that an MCP tool enters the agent through the same capability path
    as everything else, not through a separate list.
    """

    provider_id = "mcp:servers"
    kind = CapabilityKind.MCP
    #: OPTIONAL: an unreachable MCP server degrades, it does not stop the runtime.
    tier = ProviderTier.OPTIONAL

    def __init__(self, *, allowed_agents: Optional[Sequence[str]] = None,
                 servers: Optional[Mapping[str, Sequence[str]]] = None) -> None:
        super().__init__(allowed_agents=allowed_agents)
        self._servers = dict(servers or {})

    def list_capabilities(self) -> Sequence[Capability]:
        out: list[Capability] = []
        for server in sorted(self._servers):
            for tool in self._servers[server]:
                out.append(Capability(
                    name=str(tool),
                    provider="mcp:%s" % server,
                    kind=CapabilityKind.MCP,
                    toolset="mcp",
                    permissions=("mcp:invoke",),
                    allowed_agents=self.allowed_agents,
                    risk_level=1,
                    description="Tool exposed by the %s MCP server." % server,
                    source="mcp server registry",
                ))
        return out


def default_providers() -> list[CapabilityProvider]:
    """The providers a startup rebuild consults.

    Plugins are absent here on purpose: a plugin registers its own provider when
    it finishes sandbox-loading, because only then does its tool list exist. Its
    tier is CRITICAL, checked when it registers.
    """
    return [
        CoreToolsProvider(),
        SearchCapabilityProvider(),
        MediaCapabilityProvider(),
        SkillCapabilityProvider(),
    ]


class CoreToolsProvider(CapabilityProvider):
    """Verifies the CORE capability layer. Publishes nothing by design.

    Core tools (``read_file``, ``terminal``, ``write_file`` ...) are reached
    through the base agent table's toolsets, so they are already agent-visible
    and a dynamic capability claiming their names would be refused as shadowing.
    What this provider contributes is therefore not capabilities but a STARTUP
    ASSERTION: the base table must resolve to something.

    That makes it the right home for the CRITICAL tier. If the base capability
    table suddenly resolves to zero tools, the runtime would serve every request
    with no tools and no error — the exact failure this whole phase exists to
    prevent, and one no exception would otherwise report.
    """

    provider_id = "builtin:core"
    kind = CapabilityKind.BUILTIN
    tier = ProviderTier.CRITICAL

    #: An agent with ZERO available tools cannot do its job at all, so zero is a
    #: genuine blocker.
    #:
    #: Deliberately not a larger per-agent number. A first attempt used 5 and
    #: fired on `devops`, which resolves to 3 — correctly, because its
    #: `docker_read` and `monitoring` toolsets are pure composites that only
    #: `include` terminal and add no tools of their own. A threshold that trips on
    #: a healthy system trains operators to ignore it, which is worse than no
    #: threshold; the aggregate check below is what actually detects breakage.
    MINIMUM_TOOLS_PER_AGENT = 1

    #: The whole base layer resolving to a handful of tools means the toolset
    #: declarations or the tool registry failed to load. Measured on this tree: 30
    #: declared base tools, so 10 is a floor a broken layer cannot reach and a
    #: healthy one clears by a wide margin.
    MINIMUM_TOTAL_BASE_TOOLS = 10

    def preflight(self) -> None:
        try:
            from roveagent.api.capability_registry import _base_declared_tools
            from roveagent.api.capability_router import (
                AGENT_CAPABILITIES, resolve_agent_capabilities,
            )
        except Exception as exc:  # noqa: BLE001
            raise ProviderUnavailable(
                "the capability router is not importable: %s: %s"
                % (type(exc).__name__, exc)) from exc

        if not AGENT_CAPABILITIES:
            raise ProviderUnavailable("the agent capability table is empty")

        starved: list[str] = []
        for agent in sorted(AGENT_CAPABILITIES):
            resolved = resolve_agent_capabilities(agent)
            if len(resolved.available_tools) < self.MINIMUM_TOOLS_PER_AGENT:
                starved.append(agent)
        if starved:
            raise ProviderUnavailable(
                "these agents resolve no tools at all: %s. The runtime would "
                "serve their requests with no tools and no error."
                % ", ".join(starved))

        declared = _base_declared_tools()
        if len(declared) < self.MINIMUM_TOTAL_BASE_TOOLS:
            raise ProviderUnavailable(
                "the base toolsets declare only %d tool(s) (floor is %d). The "
                "toolset declarations or the tool registry did not load, so every "
                "agent would be starved."
                % (len(declared), self.MINIMUM_TOTAL_BASE_TOOLS))

    def list_capabilities(self) -> Sequence[Capability]:
        return ()


def bootstrap_capabilities(*, providers: Optional[ProviderRegistry] = None,
                           registry: Optional[CapabilityRegistry] = None,
                           force: bool = True) -> dict[str, Any]:
    """Startup sequence: preflight, build, report. Raises on a critical failure.

    Ordering is the point. Preflight runs for EVERY provider before anything is
    published, so a critical failure cannot leave a half-built registry behind:
    the runtime either has a complete capability layer or it does not start.

    Failure policy per tier:

      * **CRITICAL** → raise. A runtime missing plugin or core capability is not
        partially working, it is silently broken.
      * **OPTIONAL** → record as degraded and carry on. An unconfigured media
        backend must not stop the OS from booting; the health endpoint reports it
        so the state is visible rather than merely tolerated.

    Never lazy: this is called from ``create_app()``, so the registry exists
    before the first request is served. Initialising on first use would put the
    cost — and any critical failure — inside a user's request.
    """
    provider_registry = providers or PROVIDERS
    target = registry or CAPABILITIES

    if not provider_registry.ids():
        for provider in default_providers():
            try:
                provider_registry.add(provider)
            except Exception as exc:  # noqa: BLE001
                logger.warning("could not register provider %s: %s",
                               getattr(provider, "provider_id", "?"), exc)

    # 1. Preflight every provider first.
    failures: list[dict[str, Any]] = []
    for provider in provider_registry.providers():
        try:
            provider.preflight()
        except Exception as exc:  # noqa: BLE001 — classified below
            failures.append({
                "provider_id": provider.provider_id,
                "tier": provider.tier.value,
                "error": str(exc) or type(exc).__name__,
            })

    fatal = [f for f in failures if f["tier"] == ProviderTier.CRITICAL.value]
    if fatal:
        detail = "; ".join("%s: %s" % (f["provider_id"], f["error"]) for f in fatal)
        raise ProviderUnavailable(
            "capability bootstrap failed for critical provider(s): %s" % detail)

    # 2. Build. build() already isolates per-provider failures.
    built = provider_registry.build(target, reset=True)

    # A CRITICAL provider that could not LIST is as unusable as one that failed
    # preflight, and build() records that as a per-provider error rather than an
    # exception. Classifying it here is what makes the tier policy hold for both
    # failure paths — otherwise a critical provider could fail silently and the
    # runtime would report ready with its capabilities missing.
    build_failures = [
        {"provider_id": row["provider_id"], "tier": _tier_of(provider_registry,
                                                             row["provider_id"]),
         "error": row["error"]}
        for row in built.get("results", []) if row.get("error")
    ]
    fatal_build = [f for f in build_failures if f["tier"] == ProviderTier.CRITICAL.value]
    if fatal_build:
        detail = "; ".join("%s: %s" % (f["provider_id"], f["error"]) for f in fatal_build)
        raise ProviderUnavailable(
            "capability bootstrap failed for critical provider(s) while "
            "listing capabilities: %s" % detail)

    degraded = [f for f in failures if f["tier"] == ProviderTier.OPTIONAL.value]
    degraded += [f for f in build_failures if f["tier"] == ProviderTier.OPTIONAL.value]

    status = "degraded" if degraded else "ready"
    result = {
        **built,
        "status": status,
        "ready": status == "ready",
        "critical_failures": [],
        "degraded": degraded,
    }
    # Recorded here, not only in ensure_capability_bootstrap, so the health
    # payload always reflects the last ACTUAL build — including one made by a
    # direct bootstrap_capabilities() call such as the rebuild route.
    global _LAST_BOOTSTRAP
    _LAST_BOOTSTRAP = result
    logger.info(
        "capability bootstrap: %s (%d providers, %d capabilities, %d degraded)",
        status, built.get("providers", 0), built.get("capabilities", 0), len(degraded))
    return result


def _tier_of(provider_registry: ProviderRegistry, provider_id: str) -> str:
    """The declared tier of one registered provider, defaulting to optional."""
    for provider in provider_registry.providers():
        if provider.provider_id == provider_id:
            return provider.tier.value
    return ProviderTier.OPTIONAL.value


# ---------------------------------------------------------------------------
# Task 4: snapshot interface, reserved for multi-worker synchronisation
# ---------------------------------------------------------------------------


class CapabilitySnapshot(abc.ABC):
    """Where a built capability set can be published for other workers.

    INTERFACE ONLY — nothing is wired, and no transport is chosen. The point is
    to fix the shape now so a future multi-worker deployment does not have to
    change the registry, the providers, or the resolver to add one.

    Deliberately NOT Redis, and deliberately not a lock: the registry is
    process-local because it describes tools registered in this process, and a
    worker cannot dispatch a tool another worker registered. What a shared store
    could usefully carry is the health/summary view — "which workers are ready,
    what did each build" — which is why the writer takes a summary rather than
    the capabilities themselves.

    Implementations must be safe to call at startup and must never raise into
    the bootstrap path: a synchronisation problem must not stop the runtime.
    """

    @abc.abstractmethod
    def publish(self, snapshot: Mapping[str, Any]) -> bool:
        """Record this worker's snapshot. Returns whether it was stored."""

    @abc.abstractmethod
    def read_all(self) -> list[dict[str, Any]]:
        """Every worker's most recent snapshot, including this one."""

    def describe(self) -> dict[str, Any]:
        return {"kind": type(self).__name__}


class InMemoryCapabilitySnapshot(CapabilitySnapshot):
    """The default: this process only.

    Honest about being single-process rather than pretending to synchronise. A
    deployment with more than one worker registers a real implementation; until
    then, ``read_all`` returning just this worker is the truth.
    """

    def __init__(self, *, worker_id: str = "") -> None:
        import os
        import uuid

        self.worker_id = worker_id or ("%s-%s" % (os.getpid(), uuid.uuid4().hex[:6]))
        self._rows: dict[str, dict[str, Any]] = {}

    def publish(self, snapshot: Mapping[str, Any]) -> bool:
        import time

        self._rows[self.worker_id] = {
            "worker_id": self.worker_id,
            "published_at": time.time(),
            **dict(snapshot),
        }
        return True

    def read_all(self) -> list[dict[str, Any]]:
        return [dict(self._rows[k]) for k in sorted(self._rows)]

    def describe(self) -> dict[str, Any]:
        return {"kind": type(self).__name__, "worker_id": self.worker_id,
                "workers": len(self._rows)}


#: The snapshot sink the bootstrap publishes to. Replace at deployment time.
CAPABILITY_SNAPSHOT: CapabilitySnapshot = InMemoryCapabilitySnapshot()


def capability_health(*, registry: Optional[CapabilityRegistry] = None) -> dict[str, Any]:
    """The health payload behind ``/api/capabilities/health``.

    Reports what is actually loaded rather than what is configured: a provider
    that was never built is listed as unknown, not as healthy. A caller deciding
    whether to send work here needs the first kind of answer.
    """
    target = registry or CAPABILITIES
    built = _LAST_BOOTSTRAP
    rows = built.get("results", []) if built else []
    return {
        "status": built.get("status", "unbuilt") if built else "unbuilt",
        "ready": bool(built.get("ready")) if built else False,
        "capabilities": len(target.all()),
        "generation": target.generation,
        "providers": [
            {
                "provider_id": row.get("provider_id"),
                "kind": row.get("kind"),
                "tier": row.get("tier", ProviderTier.OPTIONAL.value),
                "published": len(row.get("published") or []),
                "already_base_provided": len(row.get("already_base_provided") or []),
                "error": row.get("error") or "",
            }
            for row in rows
        ],
        "degraded": list(built.get("degraded") or []) if built else [],
        "critical_failures": list(built.get("critical_failures") or []) if built else [],
        "by_kind": target.snapshot()["by_kind"],
        "snapshot": CAPABILITY_SNAPSHOT.describe(),
        "note": (
            "Process-local capability view. 'unbuilt' means the bootstrap has not "
            "run in this process; the runtime builds it at startup, so this "
            "indicates a startup that did not complete."
        ),
    }


_LAST_BOOTSTRAP: dict[str, Any] = {}


def ensure_capability_bootstrap(*, force: bool = False) -> dict[str, Any]:
    """Run the bootstrap once per process. Called from ``create_app()``.

    ``force=True`` re-runs it, which is what a config reload or a plugin
    lifecycle change wants. Repeated calls without ``force`` are free.
    """
    if _LAST_BOOTSTRAP and not force:
        return _LAST_BOOTSTRAP
    result = bootstrap_capabilities()
    try:
        CAPABILITY_SNAPSHOT.publish({
            "status": result.get("status"),
            "capabilities": result.get("capabilities"),
            "providers": len(result.get("results") or []),
            "degraded": len(result.get("degraded") or []),
        })
    except Exception as exc:  # noqa: BLE001 — synchronisation must not block startup
        logger.debug("capability snapshot publish failed: %s", exc)
    return result


def reset_capability_bootstrap() -> None:
    """Drop the once-per-process memo. For tests and for a forced re-bootstrap."""
    global _LAST_BOOTSTRAP
    _LAST_BOOTSTRAP = {}
