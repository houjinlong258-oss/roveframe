"""Install policy: auto-install, require approval, or refuse.

Where this sits
---------------
``installer.py`` decides *whether an install is permissible* (scan clean, every
requested capability granted, version sane). ``write_approval.py`` decides
*whether a write must be staged for a human*. Neither answers the question the
approved design actually asks:

    a skill that only reads files installs itself; a skill that wants a shell
    waits for a person.

That mapping lives here, and only here, so it cannot drift between call sites.

Two rules that are deliberate and must not be "optimised" away
-------------------------------------------------------------
1. **Refusal outranks approval.** A ``HIGH``/``CRITICAL`` scan finding is not
   something a human can wave through from this path. The installer already
   refuses those; this module reports the refusal instead of offering it as a
   choice, so no approval flow can be written that accidentally overrides it.

2. **This policy is not configurable.** It reads no settings and no environment.
   If it consulted ``skills.write_approval``, then turning that setting off would
   silently downgrade ``SHELL_EXECUTE`` to "install itself" — the exact opposite
   of the decision this module implements. The existing gate remains the
   operator's switch for *other* skill writes; for installs, the threshold is
   the switch, and it is fixed in code.

   ``test_install_policy.py`` asserts this by parsing the module's own source.

Unknown capabilities fail closed
--------------------------------
A capability that cannot be coerced to :class:`~roveagent.skills_market.permissions.Capability`
is treated as high impact and therefore needs approval. A future capability enum
member must default to "ask a human", never to "go ahead".
"""

from __future__ import annotations

import dataclasses
from enum import Enum
from typing import Any, Iterable

from roveagent.skills_market.permissions import HIGH_IMPACT, Capability

__all__ = [
    "InstallDisposition",
    "InstallPolicyDecision",
    "decide_install_policy",
    "auto_grants",
]


class InstallDisposition(str, Enum):
    AUTO = "auto"
    NEEDS_APPROVAL = "needs_approval"
    REFUSE = "refuse"


@dataclasses.dataclass(frozen=True)
class InstallPolicyDecision:
    disposition: InstallDisposition
    reason: str
    high_impact: tuple[str, ...] = ()
    low_impact: tuple[str, ...] = ()
    unknown: tuple[str, ...] = ()
    blocking: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.disposition is not InstallDisposition.REFUSE

    @property
    def needs_approval(self) -> bool:
        return self.disposition is InstallDisposition.NEEDS_APPROVAL

    def as_dict(self) -> dict[str, Any]:
        return {
            "disposition": self.disposition.value,
            "reason": self.reason,
            "high_impact": list(self.high_impact),
            "low_impact": list(self.low_impact),
            "unknown": list(self.unknown),
            "blocking": list(self.blocking),
        }


def _coerce_capability(value: object) -> Capability | None:
    """Best-effort coercion. ``None`` means "not understood" — never "harmless"."""
    if isinstance(value, Capability):
        return value
    raw = getattr(value, "value", value)
    if isinstance(raw, str):
        for member in Capability:
            if member.value == raw or member.name == raw:
                return member
    return None


def decide_install_policy(
    *,
    requested: Iterable[object] = (),
    blocking: Iterable[str] = (),
) -> InstallPolicyDecision:
    """Decide how an install may proceed.

    Args:
        requested: the capabilities the skill asks for. Callers must pass the
            **union of declared and inferred** capabilities — passing only what
            the manifest declares would let a skill under-declare its way past
            the threshold (``permissions.capabilities_from_content`` exists for
            exactly this reason).
        blocking: human-readable descriptions of every ``HIGH``/``CRITICAL`` scan
            finding. Non-empty means refusal, not approval.
    """
    blocking_tuple = tuple(str(b) for b in blocking)
    high: list[str] = []
    low: list[str] = []
    unknown: list[str] = []

    for item in requested:
        member = _coerce_capability(item)
        if member is None:
            unknown.append(str(getattr(item, "value", item)))
        elif member in HIGH_IMPACT:
            high.append(member.value)
        else:
            low.append(member.value)

    if blocking_tuple:
        return InstallPolicyDecision(
            disposition=InstallDisposition.REFUSE,
            reason=(
                "refused: %d blocking scan finding(s); a refusal is not an approval "
                "decision" % len(blocking_tuple)
            ),
            high_impact=tuple(sorted(high)),
            low_impact=tuple(sorted(low)),
            unknown=tuple(sorted(unknown)),
            blocking=blocking_tuple,
        )

    if unknown:
        return InstallPolicyDecision(
            disposition=InstallDisposition.NEEDS_APPROVAL,
            reason=(
                "needs approval: unrecognised capability %s — an unknown capability "
                "is treated as high impact, never as harmless"
                % ", ".join(sorted(unknown))
            ),
            high_impact=tuple(sorted(high)),
            low_impact=tuple(sorted(low)),
            unknown=tuple(sorted(unknown)),
        )

    if high:
        return InstallPolicyDecision(
            disposition=InstallDisposition.NEEDS_APPROVAL,
            reason=(
                "needs approval: requests high-impact capability %s"
                % ", ".join(sorted(high))
            ),
            high_impact=tuple(sorted(high)),
            low_impact=tuple(sorted(low)),
        )

    return InstallPolicyDecision(
        disposition=InstallDisposition.AUTO,
        reason=(
            "auto-install: requests no high-impact capability"
            + (" (%s)" % ", ".join(sorted(low)) if low else " (none)")
        ),
        low_impact=tuple(sorted(low)),
    )


def auto_grants(
    decision: InstallPolicyDecision, requested: Iterable[object] = ()
) -> frozenset[Capability]:
    """The grants to apply without asking a human.

    Empty unless the disposition is ``AUTO``. This is the mechanism that stops an
    agent from granting itself ``SHELL_EXECUTE``: for anything that is not
    provably low impact, the returned grant set is empty, so the installer's own
    ``missing grants`` refusal fires and the install cannot proceed on its own.
    """
    if decision.disposition is not InstallDisposition.AUTO:
        return frozenset()
    out: set[Capability] = set()
    for item in requested:
        member = _coerce_capability(item)
        # Unknown never gets granted, even on the AUTO path (it cannot be AUTO,
        # but defending here keeps the two functions independently safe).
        if member is not None and member not in HIGH_IMPACT:
            out.add(member)
    return frozenset(out)
