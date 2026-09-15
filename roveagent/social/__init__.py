"""Social publishing infrastructure (Phase 6-A).

Scope of this package
---------------------

Governance and content-correctness for outbound social posts. It provides the
parts that must be right BEFORE any platform integration exists:

  content.py     canonical content hash — what exactly was approved
  validators.py  per-platform content rules, with cited limits
  adapters.py    platform adapter INTERFACE (no real API calls in this build)
  gateway.py     freeze -> approve -> publish-once, with audit

What this package deliberately does NOT do
------------------------------------------

It never calls a social platform. Every concrete adapter's ``publish()``
raises :class:`~roveagent.social.adapters.AdapterNotImplemented`, and the test
suite asserts that no module here imports an HTTP client. Wiring a real
platform requires OAuth credentials and app review, so it is a deployment
decision, not a code-only change.

Relationship to the existing security boundary
----------------------------------------------

The gateway does not introduce a second permission system. It reuses, unchanged:

  * ``enterprise.approval_grants`` — canonical fingerprint + atomic single-use
    consumption of an approved decision
  * ``enterprise.audit``            — append-only per-tenant audit trail
  * ``tools.framework``             — EnterpriseToolGate policy rows

The publish policy pack lives here (``gateway.SOCIAL_PUBLISH_POLICIES``) rather
than in ``DEFAULT_POLICIES`` because publishing is not enabled in this build:
adding rows for a tool that cannot execute would put dead rows in the default
table. ``EnterpriseToolGate(policies=...)`` prepends caller policies, which is
the designed extension point — see that class's ``__init__``.
"""

from __future__ import annotations

__all__ = [
    "content",
    "validators",
    "adapters",
    "gateway",
]
