"""Skill permission model: declaration is not a grant.

The rule this module exists to enforce
--------------------------------------

A manifest may DECLARE that a skill wants to read files, run commands, or reach
the network. A declaration is a request. It is never permission.

That distinction is the same one the plugin framework already makes
(``CAPABILITY_REGISTRY``: "declaration ≠ grant"), and it is made here for the
same reason: if a manifest could authorise itself, then installing a skill would
be indistinguishable from handing it the machine, and the review step would be
decorative.

So installation produces a ``PermissionDecision`` with two independent inputs:

  * ``requested`` — derived from the manifest and the scanned content.
  * ``granted``   — supplied by the operator, and never inferred.

``granted`` defaults to EMPTY. A skill whose requested set is not a subset of
the granted set is refused; it is not silently narrowed, because a skill that
half-runs is harder to diagnose than one that refuses to start.

Relationship to EnterpriseToolGate
----------------------------------

This is not a second enforcement point. ``EnterpriseToolGate`` remains the only
thing that authorises a tool call, per call, with its own policy table, roles,
approvals, and audit. This module decides only whether a skill may be INSTALLED
and which capabilities the operator has acknowledged — a static, install-time
question. A skill that is installed with a capability still cannot use it
without the gate agreeing at call time.
"""

from __future__ import annotations

import dataclasses
from enum import Enum
from typing import Iterable, Mapping

__all__ = [
    "Capability",
    "ALL_CAPABILITIES",
    "HIGH_IMPACT",
    "PermissionDecision",
    "grant_all",
    "grant_none",
    "decide",
    "capabilities_from_content",
    "summarise_risk",
]


class Capability(str, Enum):
    """What a skill can be permitted to do.

    Coarse on purpose. A finer taxonomy would invite the belief that granting
    "read files under docs/" is meaningfully narrower than "read files", while
    the enforcement underneath is still path-blind in places. Coarse buckets
    that are honestly enforced beat precise ones that are not.
    """

    FILES_READ = "files:read"
    FILES_WRITE = "files:write"
    SHELL_EXECUTE = "shell:execute"
    NETWORK_EGRESS = "network:egress"
    ENV_SECRETS = "env:secrets"
    PROCESS_CONTROL = "process:control"
    SKILL_INVOKE = "skill:invoke"


ALL_CAPABILITIES: frozenset[Capability] = frozenset(Capability)

#: Capabilities that let a skill change the machine or exfiltrate. Installing one
#: with any of these is a decision the operator has to make explicitly; the
#: installer refuses to guess.
HIGH_IMPACT: frozenset[Capability] = frozenset({
    Capability.FILES_WRITE,
    Capability.SHELL_EXECUTE,
    Capability.NETWORK_EGRESS,
    Capability.ENV_SECRETS,
    Capability.PROCESS_CONTROL,
})


@dataclasses.dataclass(frozen=True)
class PermissionDecision:
    requested: frozenset[Capability]
    granted: frozenset[Capability]

    @property
    def missing(self) -> frozenset[Capability]:
        """Requested but not granted."""
        return self.requested - self.granted

    @property
    def granted_but_unused(self) -> frozenset[Capability]:
        """Granted but not requested — over-permissioning, worth surfacing."""
        return self.granted - self.requested

    @property
    def ok(self) -> bool:
        """Installable: every requested capability was granted."""
        return not self.missing

    @property
    def grants_high_impact(self) -> frozenset[Capability]:
        return self.granted & HIGH_IMPACT

    def explain(self) -> str:
        if self.ok and not self.granted_but_unused:
            return "all %d requested capabilities are granted" % len(self.requested)
        parts = []
        if self.missing:
            parts.append("missing grants: %s" % ", ".join(sorted(c.value for c in self.missing)))
        if self.granted_but_unused:
            parts.append("granted but not requested: %s"
                         % ", ".join(sorted(c.value for c in self.granted_but_unused)))
        return "; ".join(parts) or "no capabilities involved"

    def as_dict(self) -> dict:
        return {
            "requested": sorted(c.value for c in self.requested),
            "granted": sorted(c.value for c in self.granted),
            "missing": sorted(c.value for c in self.missing),
            "granted_but_unused": sorted(c.value for c in self.granted_but_unused),
            "ok": self.ok,
            "high_impact_granted": sorted(c.value for c in self.grants_high_impact),
            "explanation": self.explain(),
        }


def _coerce(values: Iterable[object]) -> frozenset[Capability]:
    out: set[Capability] = set()
    for value in values:
        if isinstance(value, Capability):
            out.add(value)
            continue
        text = str(value or "").strip()
        if not text:
            continue
        try:
            out.add(Capability(text))
        except ValueError as exc:
            raise ValueError(
                "unknown capability %r; known: %s"
                % (text, ", ".join(sorted(c.value for c in Capability)))
            ) from exc
    return frozenset(out)


def grant_none() -> frozenset[Capability]:
    """The default grant. Empty, and it stays empty unless an operator says otherwise."""
    return frozenset()


def grant_all() -> frozenset[Capability]:
    """Everything. For tests and for an operator explicitly opting into full trust."""
    return ALL_CAPABILITIES


def decide(
    requested: Iterable[object], granted: Iterable[object] = (),
) -> PermissionDecision:
    """Combine a request with an operator grant.

    ``granted`` is keyword-positional but never defaulted from ``requested``:
    the failure mode this module prevents is precisely that a request quietly
    becomes its own grant.
    """
    return PermissionDecision(requested=_coerce(requested), granted=_coerce(granted))


# ---------------------------------------------------------------------------
# Deriving the request from content
# ---------------------------------------------------------------------------


def capabilities_from_content(
    *, required_commands: Iterable[str] = (), required_env: Iterable[str] = (),
    detected: Iterable[object] = (), reads_files: bool = True,
) -> frozenset[Capability]:
    """Infer what a skill will want, from its manifest and its scanned content.

    Deliberately inclusive: the point of a REQUEST is to be honest about the
    maximum a skill may do, so anything ambiguous is included. Narrowing happens
    at grant time, where a human decides — not here, where a wrong answer would
    hide a capability from review.

    ``reads_files`` defaults to True because every skill reads its own SKILL.md
    and support files; requiring a grant for that would train operators to grant
    blindly, which is worse than the capability itself.
    """
    caps: set[Capability] = set()
    if reads_files:
        caps.add(Capability.FILES_READ)

    if list(required_commands):
        # A declared external command means the skill shells out.
        caps.add(Capability.SHELL_EXECUTE)

    for name in required_env:
        key = str(name or "").upper()
        if any(marker in key for marker in ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")):
            caps.add(Capability.ENV_SECRETS)
        # A non-secret environment variable (a locale, a base URL) grants no
        # capability: it does not let the skill do anything it could not do
        # already, and inventing a capability for it would inflate every
        # manifest's request list until the list stopped being read.

    for value in detected:
        text = value.value if isinstance(value, Capability) else str(value or "")
        normalised = text.strip().lower().replace("_", ":")
        if normalised in {c.value for c in Capability}:
            caps.add(Capability(normalised))
            continue
        # Map the coarse names the AST scanner emits onto capabilities.
        if "network" in normalised or "http" in normalised or "socket" in normalised:
            caps.add(Capability.NETWORK_EGRESS)
        elif "subprocess" in normalised or "shell" in normalised or "exec" in normalised:
            caps.add(Capability.SHELL_EXECUTE)
        elif "write" in normalised:
            caps.add(Capability.FILES_WRITE)
        elif "read" in normalised or "file" in normalised or "fs" in normalised:
            caps.add(Capability.FILES_READ)
        elif "secret" in normalised or "env" in normalised or "credential" in normalised:
            caps.add(Capability.ENV_SECRETS)
        elif "process" in normalised or "signal" in normalised or "kill" in normalised:
            caps.add(Capability.PROCESS_CONTROL)

    return frozenset(caps)


def summarise_risk(decision: PermissionDecision) -> str:
    """One-line human summary, for an install prompt."""
    if not decision.granted:
        return "no capabilities granted"
    high = decision.grants_high_impact
    if high:
        return "grants high-impact capabilities: %s" % ", ".join(sorted(c.value for c in high))
    return "grants: %s" % ", ".join(sorted(c.value for c in decision.granted))
