"""Durable, business-scoped, single-use approval execution grants."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Mapping, Optional

GRANT_TTL_S = 3600
_lock = threading.Lock()


def _root() -> Path:
    return Path(os.environ.get("ROVEAGENT_ROOT")
                or os.environ.get("ROVEAGENT_HOME")
                or Path.home() / ".roveagent")


def _path(root: Optional[Path] = None) -> Path:
    directory = (root or _root()) / "approvals"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "grants.json"


def fingerprint(tool: str, args: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        {"tool": tool, "args": dict(args)}, sort_keys=True,
        ensure_ascii=False, separators=(",", ":"), default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _load(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _save(path: Path, grants: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(grants[-500:], ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def record_grant(
    *, tenant_id: str, business_id: str, tool: str, args: Mapping[str, Any],
    approved: bool, approver: str = "", audit_event_id: str = "",
    invocation_id: str = "", execution_id: str = "", request_id: str = "",
    root: Optional[Path] = None,
) -> dict[str, Any]:
    """Record a decision exactly once for one immutable invocation."""
    if not invocation_id:
        raise ValueError("invocation_id is required")
    fp = fingerprint(tool, args)
    with _lock:
        path = _path(root)
        grants = _load(path)
        for existing in reversed(grants):
            if existing.get("invocation_id") != invocation_id:
                continue
            immutable = (
                existing.get("tenant_id") == tenant_id
                and existing.get("business_id") == business_id
                and existing.get("tool") == tool
                and existing.get("fingerprint") == fp
                and bool(existing.get("approved")) == approved
                and existing.get("execution_id", "") == execution_id
            )
            if not immutable:
                raise ValueError("approval invocation replay does not match frozen decision")
            return {**existing, "created": False}

        grant = {
            "tenant_id": tenant_id,
            "business_id": business_id,
            "tool": tool,
            "fingerprint": fp,
            "approved": approved,
            "approver": approver,
            "audit_event_id": audit_event_id,
            "invocation_id": invocation_id,
            "execution_id": execution_id,
            "request_id": request_id,
            "status": "ready" if approved else "rejected",
            "created_at": time.time(),
            "consumed_at": None,
            "callback_claimed_at": None,
            "completed_at": None,
            "result": None,
        }
        grants.append(grant)
        _save(path, grants)
        return {**grant, "created": True}


def claim_resolution(
    invocation_id: str, execution_id: str, *, root: Optional[Path] = None,
) -> dict[str, Any]:
    """Claim the signed callback before entering middleware (duplicate-safe)."""
    with _lock:
        path = _path(root)
        grants = _load(path)
        for index in range(len(grants) - 1, -1, -1):
            grant = grants[index]
            if (grant.get("invocation_id") == invocation_id
                    and grant.get("execution_id") == execution_id):
                if grant.get("callback_claimed_at") is not None:
                    return {**grant, "claimed": False}
                grant["callback_claimed_at"] = time.time()
                grant["status"] = "resuming"
                grants[index] = grant
                _save(path, grants)
                return {**grant, "claimed": True}
    raise KeyError("approval execution grant not found")


def consume_grant(
    tenant_id: str, business_id: str, tool: str, args: Mapping[str, Any],
    *, request_id: str, root: Optional[Path] = None,
) -> Optional[dict[str, Any]]:
    """Atomically consume one matching grant; a second caller can never reuse it."""
    fp = fingerprint(tool, args)
    now = time.time()
    with _lock:
        path = _path(root)
        grants = _load(path)
        for index in range(len(grants) - 1, -1, -1):
            grant = grants[index]
            if (grant.get("tenant_id") == tenant_id
                    and grant.get("business_id") == business_id
                    and grant.get("fingerprint") == fp
                    and grant.get("request_id") == request_id
                    and grant.get("approved")
                    and grant.get("consumed_at") is None
                    and now - float(grant.get("created_at", 0)) <= GRANT_TTL_S):
                grant["consumed_at"] = now
                grant["status"] = "executing"
                grants[index] = grant
                _save(path, grants)
                return dict(grant)
    return None


def complete_grant(
    invocation_id: str, execution_id: str, *, result: Any = None,
    error: str = "", root: Optional[Path] = None,
) -> dict[str, Any]:
    with _lock:
        path = _path(root)
        grants = _load(path)
        for index in range(len(grants) - 1, -1, -1):
            grant = grants[index]
            if (grant.get("invocation_id") == invocation_id
                    and grant.get("execution_id") == execution_id):
                grant["status"] = "failed" if error else "executed"
                grant["completed_at"] = time.time()
                grant["result"] = result
                grant["error"] = error
                grants[index] = grant
                _save(path, grants)
                return dict(grant)
    raise KeyError("approval execution grant not found")


def find_grant(
    tenant_id: str, business_id: str, tool: str, args: Mapping[str, Any],
    *, root: Optional[Path] = None,
) -> Optional[dict[str, Any]]:
    """Read-only compatibility lookup; execution must use ``consume_grant``."""
    fp = fingerprint(tool, args)
    now = time.time()
    with _lock:
        grants = _load(_path(root))
    for grant in reversed(grants):
        if (grant.get("tenant_id") == tenant_id
                and grant.get("business_id") == business_id
                and grant.get("fingerprint") == fp
                and grant.get("approved")
                and now - float(grant.get("created_at", 0)) <= GRANT_TTL_S):
            return grant
    return None


def inspect_grant(
    invocation_id: str, execution_id: str, *, root: Optional[Path] = None,
) -> Optional[dict[str, Any]]:
    """Read-only snapshot of one grant, for DIAGNOSIS ONLY.

    ``find_grant`` answers "is there a usable grant?" and collapses every
    unusable case — absent, rejected, expired, already consumed — into a single
    ``None``. Callers that must explain a refusal to a human need to tell those
    apart, because the right remedy differs completely: a rejection needs a new
    decision, an expiry needs a re-freeze, a consumed grant is a replay attempt.

    This function holds the lock, reads, and returns a copy. It never mutates,
    never claims, and must never be used to decide whether execution may
    proceed — ``consume_grant`` remains the sole authority for that. Kept
    deliberately separate so no caller can mistake diagnosis for enforcement.
    """
    with _lock:
        grants = _load(_path(root))
    for index in range(len(grants) - 1, -1, -1):
        grant = grants[index]
        if (grant.get("invocation_id") == invocation_id
                and grant.get("execution_id") == execution_id):
            return dict(grant)
    return None


def classify_grant(
    invocation_id: str, execution_id: str, *, root: Optional[Path] = None,
) -> str:
    """Diagnostic label for one grant: ``ready``/``rejected``/``consumed``/
    ``claimed``/``expired``/``missing``.

    Reporting only. ``consume_grant`` decides; this explains. Unknown extra
    states fall through to ``consumed`` rather than ``ready`` so a caller can
    never be told a doubtful grant is fine.
    """
    grant = inspect_grant(invocation_id, execution_id, root=root)
    if grant is None:
        return "missing"
    if not grant.get("approved"):
        return "rejected"
    if grant.get("consumed_at") is not None:
        return "consumed"
    if grant.get("callback_claimed_at") is not None:
        return "claimed"
    age = time.time() - float(grant.get("created_at", 0) or 0)
    if age > GRANT_TTL_S:
        return "expired"
    return "ready"
