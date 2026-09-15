"""Social publishing gateway: freeze -> approve -> publish exactly once.

What this gateway guarantees, and why each guarantee matters
------------------------------------------------------------

1. WHAT WAS APPROVED IS WHAT GETS PUBLISHED.
   The request carries a canonical content hash that covers the platform, the
   normalised text, and every media asset's content digest. Execution
   re-derives the hash and refuses on any mismatch. Without this, anything able
   to mutate the post between approval and dispatch silently inherits the
   approval.

2. ONE APPROVAL PUBLISHES AT MOST ONCE.
   Two independent replay vectors are closed, using the existing grant store
   rather than a new one:

     * ``claim_resolution`` — the resume callback for one (invocation,
       execution) pair can be claimed once. A duplicate callback returns
       ``claimed: False`` instead of re-running the tool.
     * ``consume_grant`` — the atomic consume of the matching grant. A second
       consumer with the same fingerprint and request id can never reuse it.

   Belt and braces on purpose: they fail independently and guard different
   entry points.

3. NOTHING IS SENT BEFORE AUTHORISATION.
   ``freeze`` and ``authorize`` are pure bookkeeping. ``publish`` validates
   content first, then consumes the grant, and only then reaches an adapter.
   Validation before consumption matters: a post that cannot be published
   should not burn its approval.

4. EVERY STEP IS AUDITED.
   freeze / approve / reject / start / success / failure / replay-blocked are
   each written to the append-only per-tenant audit log, so the trail shows
   what was attempted even when the outcome was a refusal.

What this gateway does NOT do
-----------------------------

It does not call a social platform. In this build every real adapter raises
``AdapterNotImplemented``; the success path is exercised in tests with an
injected in-memory adapter. The gateway itself is complete and verified.

Why the policy pack lives here
------------------------------

``SOCIAL_PUBLISH_POLICIES`` is not merged into
``tools.framework.DEFAULT_POLICIES``. Publishing has no working adapter, so a
default row would govern a tool that cannot run — a dead row, which is the same
defect removed from the process policies in Phase 1. ``EnterpriseToolGate``
prepends caller-supplied policies, so a deployment that enables publishing
passes this pack and gets the intended governance with no change to the default
table. A test asserts the pack is ordered and non-shadowed so it still works
when prepended.
"""

from __future__ import annotations

import dataclasses
import secrets
import time
import uuid
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from roveagent.enterprise import approval_grants
from roveagent.enterprise.audit import AuditEvent, AuditLog
from roveagent.social.adapters import (
    AdapterNotImplemented,
    AdapterRegistry,
    PreparedPublication,
    PublishReceipt,
    default_registry,
)
from roveagent.social.content import (
    PublicationContent,
    content_envelope,
    content_hash,
)
from roveagent.social.validators import ValidationResult, validate

__all__ = [
    "PublicationError",
    "PublicationNotApproved",
    "PublicationAlreadyExecuted",
    "PublicationContentChanged",
    "PublicationRejected",
    "PublicationValidationFailed",
    "PublicationNotImplemented",
    "PublicationOutcome",
    "PublicationRequest",
    "SocialPublishingGateway",
    "SOCIAL_PUBLISH_POLICIES",
]


class PublicationError(RuntimeError):
    """Base class for every refusal this gateway can produce."""


class PublicationNotApproved(PublicationError):
    """No matching approved grant exists (never approved, or expired)."""


class PublicationAlreadyExecuted(PublicationError):
    """The grant was already consumed. Retrying cannot publish twice."""


class PublicationContentChanged(PublicationError):
    """The content hash no longer matches the frozen one."""


class PublicationRejected(PublicationError):
    """The approver declined."""


class PublicationValidationFailed(PublicationError):
    """Content violates the target platform's rules."""

    def __init__(self, result: ValidationResult) -> None:
        self.result = result
        super().__init__(result.summary())


class PublicationNotImplemented(PublicationError):
    """The adapter is an interface only; nothing was sent."""


@dataclasses.dataclass(frozen=True)
class PublicationRequest:
    """A frozen, hashable publishing intent.

    ``invocation_id`` identifies one approval cycle; ``execution_id``
    identifies one attempt to act on it. Both are required, because the
    single-use guarantee is keyed on the pair.
    """

    platform: str
    content: PublicationContent
    tenant_id: str
    business_id: str
    agent: str = ""
    user_id: str = ""
    role: str = ""
    request_id: str = ""
    invocation_id: str = ""
    execution_id: str = ""
    frozen_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.platform.strip():
            raise ValueError("platform is required")
        if not self.tenant_id or not self.business_id:
            raise ValueError("tenant_id and business_id are required")
        if not self.invocation_id:
            raise ValueError("invocation_id is required")
        if not self.execution_id:
            raise ValueError("execution_id is required")
        if not self.frozen_at:
            object.__setattr__(self, "frozen_at", time.time())

    @property
    def platform_key(self) -> str:
        return self.platform.strip().lower()

    @property
    def content_hash(self) -> str:
        return content_hash(self.platform_key, self.content)

    @property
    def tool_name(self) -> str:
        """The tool this publication is published under, for the grant store."""
        return "publish_social_post"

    def grant_args(self) -> dict[str, Any]:
        """Exactly the mapping the approval fingerprint is taken over.

        Uses the same canonical envelope as ``content_hash`` so the approval and
        the content hash can never describe different payloads.
        """
        envelope = content_envelope(self.platform_key, self.content)
        return {
            **envelope,
            "tenant_id": self.tenant_id,
            "business_id": self.business_id,
            "invocation_id": self.invocation_id,
            "execution_id": self.execution_id,
        }

    @property
    def approval_fingerprint(self) -> str:
        """Canonical hash from the existing grant store, not a parallel one."""
        return approval_grants.fingerprint(self.tool_name, self.grant_args())


@dataclasses.dataclass(frozen=True)
class PublicationOutcome:
    ok: bool
    status: str
    platform: str
    content_hash: str
    detail: str = ""
    receipt: Optional[PublishReceipt] = None
    validation: Optional[ValidationResult] = None
    prepared: Optional[PreparedPublication] = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ok": self.ok,
            "status": self.status,
            "platform": self.platform,
            "content_hash": self.content_hash,
        }
        if self.detail:
            out["detail"] = self.detail
        if self.validation is not None:
            out["validation"] = self.validation.as_dict()
        if self.prepared is not None:
            out["prepared"] = {
                "content_hash": self.prepared.content_hash,
                "dropped": list(self.prepared.dropped),
                "warnings": list(self.prepared.warnings),
            }
        if self.receipt is not None:
            out["receipt"] = {
                "remote_id": self.receipt.remote_id,
                "remote_url": self.receipt.remote_url,
                "content_hash": self.receipt.content_hash,
            }
        return out


class SocialPublishingGateway:
    """Governance wrapper around a set of platform adapters.

    The gateway is the only component permitted to decide that a publish may
    proceed. Adapters cannot be reached without passing through it, because the
    gateway is what holds the approval state.
    """

    def __init__(
        self,
        *,
        registry: Optional[AdapterRegistry] = None,
        audit: Optional[AuditLog] = None,
        audit_root: Optional[Path] = None,
        grant_root: Optional[Path] = None,
    ) -> None:
        self.registry = registry or default_registry()
        if audit is not None:
            self.audit = audit
        else:
            root = Path(audit_root) if audit_root else _default_root()
            self.audit = AuditLog(root / "audit" / "social_publishing.jsonl")
        self._grant_root = grant_root

    # -- audit helpers -------------------------------------------------

    def _record(self, request: Optional[PublicationRequest], action: str, result: str,
                detail: str = "", *, tenant_id: str = "", agent: str = "") -> AuditEvent:
        event = AuditEvent(
            tenant_id=tenant_id or (request.tenant_id if request else ""),
            agent=agent or (request.agent if request else "") or "social_gateway",
            action=action,
            detail=detail,
            result=result,
        )
        try:
            self.audit.record(event)
        except OSError:
            # An audit failure must not silently swallow the operation, but it
            # also must not turn a refusal into a different refusal. The failure
            # is surfaced through the returned event id being empty.
            event.event_id = ""
        return event

    # -- 1. freeze -----------------------------------------------------

    def freeze(
        self, platform: str, content: PublicationContent, *,
        tenant_id: str, business_id: str, agent: str = "", user_id: str = "",
        role: str = "", request_id: str = "", invocation_id: str = "",
        execution_id: str = "",
    ) -> PublicationRequest:
        """Bind a publication intent to hashes. Pure — nothing is sent or stored."""
        request = PublicationRequest(
            platform=platform, content=content, tenant_id=tenant_id,
            business_id=business_id, agent=agent, user_id=user_id, role=role,
            request_id=request_id or uuid.uuid4().hex,
            invocation_id=invocation_id or uuid.uuid4().hex,
            execution_id=execution_id or uuid.uuid4().hex,
        )
        self._record(
            request, "social_publication_frozen", "pending_approval",
            "%s %s hash=%s" % (request.platform_key, request.invocation_id[:8],
                               request.content_hash[:12]),
        )
        return request

    # -- 2. authorise --------------------------------------------------

    def authorize(
        self, request: PublicationRequest, *, approved: bool, approver: str = "",
        audit_event_id: str = "",
    ) -> dict[str, Any]:
        """Record the approval decision for this immutable invocation.

        Delegates to ``approval_grants.record_grant``, which rejects a replay
        whose fields differ from the frozen decision.
        """
        if not approver:
            raise ValueError("approver is required to authorise a publication")
        try:
            grant = approval_grants.record_grant(
                tenant_id=request.tenant_id, business_id=request.business_id,
                tool=request.tool_name, args=request.grant_args(),
                approved=approved, approver=approver,
                audit_event_id=audit_event_id, invocation_id=request.invocation_id,
                execution_id=request.execution_id, request_id=request.request_id,
                root=self._grant_root,
            )
        except ValueError as exc:
            self._record(request, "social_publication_replay_blocked", "denied", str(exc))
            raise PublicationContentChanged(str(exc)) from exc

        self._record(
            request, "social_publication_approved" if approved else "social_publication_rejected",
            "ok" if approved else "denied",
            "%s by %s" % (request.platform_key, approver), agent=approver,
        )
        return grant

    # -- 3. publish once ----------------------------------------------

    def publish(
        self, request: PublicationRequest, *, authorization: Optional[Mapping[str, Any]] = None,
    ) -> PublicationOutcome:
        """Publish exactly once, or refuse with a precise reason.

        Refusal reasons, in the order they are checked:

          * unsupported / unimplemented platform  -> PublicationNotImplemented
          * content invalid for the platform      -> PublicationValidationFailed
          * no approved grant (or expired)        -> PublicationNotApproved
          * grant already consumed                -> PublicationAlreadyExecuted
          * adapter still an interface            -> PublicationNotImplemented
        """
        platform = request.platform_key
        adapter = self.registry.get(platform)
        if adapter is None:
            detail = "no adapter registered for platform %r" % platform
            self._record(request, "social_publication_refused", "denied", detail)
            raise PublicationNotImplemented(detail)

        # Validate BEFORE consuming: an unpublishable post must not burn its
        # approval, or a validation bug would force a fresh human decision.
        validation = adapter.validate(request.content)
        if not validation.ok:
            self._record(
                request, "social_publication_invalid", "denied",
                "%s: %s" % (platform, "; ".join(i.code for i in validation.errors)),
            )
            raise PublicationValidationFailed(validation)

        if platform not in self.registry.implemented():
            detail = (
                "the %s adapter defines the interface only; no platform API is "
                "called in this build" % platform
            )
            self._record(request, "social_publication_unimplemented", "denied", detail)
            raise PublicationNotImplemented(detail)

        # Classify the grant BEFORE touching it. consume_grant/claim_resolution
        # both MUTATE on success, and claim_resolution mutates any grant it
        # finds — including a rejected one, which would rewrite the record of a
        # human's refusal into "resuming". Reading first means a refusal is
        # explained precisely and leaves the audit trail intact.
        #
        # The fingerprint is checked HERE, before any mutation, and not left to
        # consume_grant. Guarding only at consume time still let a tampered
        # payload claim the invocation first: the claim of the honest approval
        # was then burned by the tampered attempt, so the legitimate
        # publication could never happen. Binding the content hash to the
        # earliest possible gate is what keeps a tamper attempt harmless
        # instead of merely unsuccessful.
        grant = approval_grants.inspect_grant(
            request.invocation_id, request.execution_id, root=self._grant_root,
        )
        if grant is None:
            self._record(request, "social_publication_not_approved", "denied",
                         "no grant for invocation %s" % request.invocation_id[:8])
            raise PublicationNotApproved(
                "no approval was ever recorded for invocation %s / execution %s"
                % (request.invocation_id, request.execution_id)
            )

        frozen_fingerprint = str(grant.get("fingerprint") or "")
        actual_fingerprint = request.approval_fingerprint
        if not secrets.compare_digest(frozen_fingerprint, actual_fingerprint):
            self._record(
                request, "social_publication_content_changed", "denied",
                "content hash %s does not match the frozen %s"
                % (actual_fingerprint[:12], frozen_fingerprint[:12]),
            )
            raise PublicationContentChanged(
                "the content does not match what was approved (approved %s..., "
                "offered %s...); re-freeze and obtain a new approval"
                % (frozen_fingerprint[:12], actual_fingerprint[:12])
            )

        state = approval_grants.classify_grant(
            request.invocation_id, request.execution_id, root=self._grant_root,
        )
        if state == "rejected":
            self._record(request, "social_publication_rejected", "denied",
                         "the approver declined this publication")
            raise PublicationRejected(
                "the approver declined this publication; a new decision is required"
            )
        if state == "expired":
            self._record(request, "social_publication_expired", "denied",
                         "the approval grant expired")
            raise PublicationNotApproved(
                "the approval grant expired before execution; re-freeze and "
                "re-approve the content"
            )
        if state in ("consumed", "claimed"):
            self._record(request, "social_publication_replay_blocked", "denied",
                         "grant already %s" % state)
            raise PublicationAlreadyExecuted(
                "this approval was already executed (%s); one approval publishes "
                "at most once" % state
            )
        if state != "ready":
            # Unknown/diagnostic-only state: refuse rather than assume it is fine.
            self._record(request, "social_publication_not_approved", "denied",
                         "grant state %r is not executable" % state)
            raise PublicationNotApproved(
                "the approval grant is not in an executable state (%s)" % state
            )

        # Replay gate 1 — invocation-level claim (duplicate resume callback).
        try:
            claim = approval_grants.claim_resolution(
                request.invocation_id, request.execution_id, root=self._grant_root,
            )
        except KeyError as exc:
            self._record(request, "social_publication_not_approved", "denied", str(exc))
            raise PublicationNotApproved(str(exc)) from exc
        if not claim.get("claimed"):
            self._record(
                request, "social_publication_replay_blocked", "denied",
                "invocation already claimed (status=%s)" % claim.get("status"),
            )
            raise PublicationAlreadyExecuted(
                "this invocation was already claimed; a second execution cannot "
                "publish twice"
            )

        # Replay gate 2 — atomic consume. The classification above and this
        # consume are not atomic together, so a concurrent publisher can still
        # win the race here; that is exactly what this gate exists to catch.
        consumed = approval_grants.consume_grant(
            request.tenant_id, request.business_id, request.tool_name,
            request.grant_args(), request_id=request.request_id, root=self._grant_root,
        )
        if consumed is None:
            self._record(
                request, "social_publication_replay_blocked", "denied",
                "lost the consume race (already used, not approved, or expired)",
            )
            raise PublicationAlreadyExecuted(
                "no consumable approval grant: it was already used, was never "
                "approved, or has expired"
            )

        self._record(request, "social_publication_started", "ok", platform)

        try:
            prepared = adapter.prepare(request.content)
        except Exception as exc:  # noqa: BLE001 — preparation is local and pure
            self._finish(request, result=None, error="%s: %s" % (type(exc).__name__, exc))
            self._record(request, "social_publication_failed", "error", "prepare failed: %s" % exc)
            raise

        try:
            receipt = adapter.publish(prepared, authorization=dict(authorization or {}))
        except AdapterNotImplemented as exc:
            self._finish(request, result=None, error=str(exc))
            self._record(request, "social_publication_not_implemented", "error", str(exc))
            raise PublicationNotImplemented(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 — a real adapter may fail any number of ways
            self._finish(request, result=None, error="%s: %s" % (type(exc).__name__, exc))
            self._record(request, "social_publication_failed", "error",
                         "%s: %s" % (type(exc).__name__, exc))
            raise

        self._finish(request, result={"remote_id": receipt.remote_id,
                                      "content_hash": receipt.content_hash}, error="")
        self._record(
            request, "social_publication_succeeded", "ok",
            "%s remote_id=%s" % (platform, receipt.remote_id or "(none)"),
        )
        return PublicationOutcome(
            ok=True, status="published", platform=platform,
            content_hash=request.content_hash, receipt=receipt,
            validation=validation, prepared=prepared,
        )

    def _finish(self, request: PublicationRequest, *, result: Any, error: str) -> None:
        try:
            approval_grants.complete_grant(
                request.invocation_id, request.execution_id,
                result=result, error=error, root=self._grant_root,
            )
        except KeyError:
            # The grant vanished between consume and complete. The publish
            # already happened or already failed; recording the gap is the
            # honest response rather than raising over the real outcome.
            self._record(request, "social_publication_grant_missing", "error",
                         "grant disappeared before completion could be recorded")

    # -- read-only helpers --------------------------------------------

    def capabilities(self) -> dict[str, Any]:
        """What publishing can actually do right now. Safe to expose to an agent."""
        return {
            "platforms": self.registry.platforms(),
            "implemented": self.registry.implemented(),
            "unimplemented": self.registry.unimplemented(),
            "adapters": self.registry.describe(),
            "note": (
                "No platform adapter performs real API calls in this build. "
                "Content validation and the approval path are fully functional."
            ),
        }

    def validate_only(self, platform: str, content: PublicationContent) -> ValidationResult:
        """Validate without freezing, approving, or publishing. Pure and free."""
        return validate(platform, content)


def _default_root() -> Path:
    import os

    return Path(
        os.environ.get("ROVEAGENT_ROOT")
        or os.environ.get("ROVEAGENT_HOME")
        or Path.home() / ".roveagent"
    )


# ---------------------------------------------------------------------------
# Opt-in gate policy pack
# ---------------------------------------------------------------------------
# Prepended by a deployment that enables real publishing:
#
#     from roveagent.tools.framework import EnterpriseToolGate
#     from roveagent.social.gateway import SOCIAL_PUBLISH_POLICIES
#     gate = EnterpriseToolGate(policies=list(SOCIAL_PUBLISH_POLICIES))
#
# Not merged into DEFAULT_POLICIES: with no working adapter, a default row would
# govern a tool that cannot execute — a dead row.
def _build_policies() -> tuple:
    from roveagent.tools.framework import ApprovalPolicy, RiskLevel, ToolPolicy

    return (
        # Real outbound publishing is irreversible and public: owner approval,
        # matching send_customer_recovery_campaign rather than the generic
        # send_* row (which is manager-level).
        ToolPolicy("publish_social_post", "comms:publish",
                   RiskLevel.HIGH, ApprovalPolicy.OWNER),
        # Read-only capability probe and local content validation.
        ToolPolicy("publish_social_capabilities", "comms:read",
                   RiskLevel.LOW, ApprovalPolicy.NONE),
        ToolPolicy("validate_social_post", "comms:read",
                   RiskLevel.LOW, ApprovalPolicy.NONE),
    )


SOCIAL_PUBLISH_POLICIES: tuple = _build_policies()
