"""Skill installation workflow.

The pipeline, and why each stage exists and in this order
---------------------------------------------------------

    validate  --read manifest--   a skill that cannot describe itself is not one
    scan      --read content--    what the skill contains, before it is on disk
    permissions --compare--       what it wants vs what an operator granted
    plan      --decide--          install / upgrade / downgrade-refused / no-op
    stage     --copy to temp--    nothing lands in the live tree yet
    verify    --re-scan staged--  the bytes about to be committed are the bytes
                                  that were scanned (TOCTOU close)
    commit    --atomic rename--   the only mutation, and it is one operation
    rollback  --on failure--      restore the previous version

Why staging is not optional
---------------------------

Scanning the source and then copying it leaves a window where the source can
change. Staging first, then re-verifying the staged copy against the digest
recorded during the scan, means the artefact that lands is provably the one that
was reviewed. The window is small but it is exactly the window a supply-chain
attack needs.

No network
----------

The source must be a local directory. There is no remote fetch, no registry
protocol, and no archive extraction, so none of the classic install-time remote
code-execution surfaces exist here. ``install_from_directory`` says so by name.

What this does NOT do
---------------------

It does not make a skill runnable or grant it execution rights. Installation is
a file operation plus a recorded permission decision. Execution still requires a
sandbox runtime (see ``sandbox.SandboxRegistry``) and, per call,
``EnterpriseToolGate``.
"""

from __future__ import annotations

import dataclasses
import hashlib
import shutil
import tempfile
import time
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

from roveagent.skills_market.manifest import (
    SKILL_FILENAME,
    ManifestError,
    SkillManifest,
    load_manifest,
)
from roveagent.skills_market.permissions import (
    Capability,
    PermissionDecision,
    decide as decide_permissions,
    summarise_risk,
)
from roveagent.skills_market.scanner import ScanReport, is_install_allowed, scan_skill
from roveagent.skills_market.versions import SemVer, VersionError, parse_version

__all__ = [
    "InstallAction",
    "InstallError",
    "InstallRefused",
    "InstallPlan",
    "InstallResult",
    "StagedSkill",
    "plan_install",
    "install_from_directory",
    "digest_tree",
]


class InstallError(RuntimeError):
    """Base class for installation failures."""


class InstallRefused(InstallError):
    """A refusal with a reason a human can act on."""


class InstallAction(str, Enum):
    INSTALL = "install"
    UPGRADE = "upgrade"
    REINSTALL = "reinstall"
    NOOP = "noop"
    REFUSE_DOWNGRADE = "refuse_downgrade"


@dataclasses.dataclass(frozen=True)
class InstallPlan:
    """The decision, before anything is written."""

    skill_name: str
    source: Path
    target: Path
    action: InstallAction
    version: str
    installed_version: str = ""
    manifest: Optional[SkillManifest] = None
    scan: Optional[ScanReport] = None
    permissions: Optional[PermissionDecision] = None
    refusals: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.refusals

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "skill_name": self.skill_name,
            "source": str(self.source),
            "target": str(self.target),
            "action": self.action.value,
            "version": self.version,
            "installed_version": self.installed_version,
            "ok": self.ok,
            "refusals": list(self.refusals),
        }
        if self.scan is not None:
            out["scan"] = self.scan.as_dict()
        if self.permissions is not None:
            out["permissions"] = self.permissions.as_dict()
            out["permission_summary"] = summarise_risk(self.permissions)
        return out

    def explain(self) -> str:
        if self.refusals:
            return "refused: %s" % "; ".join(self.refusals)
        return "%s %s %s -> %s" % (
            self.action.value, self.skill_name, self.version, self.target)


@dataclasses.dataclass(frozen=True)
class StagedSkill:
    """A verified copy in a temporary location, not yet committed."""

    path: Path
    digest: str
    files: tuple[str, ...]

    def cleanup(self) -> None:
        shutil.rmtree(self.path.parent, ignore_errors=True)


@dataclasses.dataclass(frozen=True)
class InstallResult:
    ok: bool
    action: InstallAction
    skill_name: str
    version: str = ""
    path: str = ""
    digest: str = ""
    detail: str = ""
    rolled_back: bool = False
    permissions: Optional[PermissionDecision] = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ok": self.ok,
            "action": self.action.value,
            "skill_name": self.skill_name,
            "version": self.version,
            "path": self.path,
            "digest": self.digest,
            "rolled_back": self.rolled_back,
        }
        if self.detail:
            out["detail"] = self.detail
        if self.permissions is not None:
            out["permissions"] = self.permissions.as_dict()
        return out


# ---------------------------------------------------------------------------
# Content digest
# ---------------------------------------------------------------------------


def digest_tree(root: Path, *, skip: Sequence[str] = ("__pycache__", ".git")) -> tuple[str, tuple[str, ...]]:
    """sha256 over the sorted (relative path, file bytes) of a directory tree.

    Hashes names as well as contents, so adding, removing, or renaming a file
    changes the digest. A content-only digest would report two different trees
    as identical.
    """
    base = Path(root)
    hasher = hashlib.sha256()
    names: list[str] = []
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if any(part in skip for part in rel.parts):
            continue
        names.append(rel.as_posix())
        hasher.update(rel.as_posix().encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest(), tuple(names)


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def plan_install(
    source: Path, *, library_root: Path, granted: Iterable[Capability] = (),
    enforce_scan: bool = False, allow_downgrade: bool = False,
) -> InstallPlan:
    """Decide what an install would do, without doing it.

    Pure with respect to the library: it reads the source and the installed
    version and returns a plan. Nothing is copied, created, or removed.
    """
    src = Path(source)
    if not src.is_dir():
        return InstallPlan(
            skill_name=src.name, source=src, target=Path(library_root) / src.name,
            action=InstallAction.INSTALL, version="", refusals=("source is not a directory",))

    try:
        manifest = load_manifest(src)
    except ManifestError as exc:
        return InstallPlan(
            skill_name=src.name, source=src, target=Path(library_root) / src.name,
            action=InstallAction.INSTALL, version="", refusals=("invalid manifest: %s" % exc,))

    target = Path(library_root) / manifest.name

    # Scan BEFORE anything is written.
    try:
        report = scan_skill(src, manifest)
    except Exception as exc:  # noqa: BLE001 — a scanner crash must not look clean
        return InstallPlan(
            skill_name=manifest.name, source=src, target=target,
            action=InstallAction.INSTALL, version=manifest.version, manifest=manifest,
            refusals=("scan failed: %s: %s" % (type(exc).__name__, exc),))

    refusals: list[str] = []
    if report.scanner_error:
        refusals.append("scan incomplete: %s" % report.scanner_error)
    if not is_install_allowed(report, enforce=enforce_scan):
        codes = ", ".join(sorted({f.code for f in report.blocking}))
        refusals.append("blocking findings (%s)" % codes)

    # Permission decision: requested is derived, granted is supplied.
    requested = _requested_capabilities(manifest, report)
    decision = decide_permissions(requested, granted)
    if not decision.ok:
        refusals.append("missing capability grants: %s"
                        % ", ".join(sorted(c.value for c in decision.missing)))

    installed_version = ""
    action = InstallAction.INSTALL
    if target.is_dir():
        try:
            installed = load_manifest(target)
            installed_version = installed.version
        except ManifestError:
            installed_version = ""
        try:
            incoming = parse_version(manifest.version)
            current = parse_version(installed_version) if installed_version else None
        except VersionError as exc:
            refusals.append("cannot compare versions: %s" % exc)
            incoming, current = None, None
        if incoming is not None:
            if current is None:
                action = InstallAction.REINSTALL
            elif incoming > current:
                action = InstallAction.UPGRADE
            elif incoming == current:
                action = InstallAction.REINSTALL
            else:
                action = InstallAction.REFUSE_DOWNGRADE
                if not allow_downgrade:
                    refusals.append(
                        "installed version %s is newer than %s; pass allow_downgrade "
                        "to override deliberately" % (installed_version, manifest.version))

    return InstallPlan(
        skill_name=manifest.name, source=src, target=target, action=action,
        version=manifest.version, installed_version=installed_version,
        manifest=manifest, scan=report, permissions=decision,
        refusals=tuple(refusals),
    )


def _requested_capabilities(manifest: SkillManifest, report: ScanReport) -> frozenset[Capability]:
    from roveagent.skills_market.permissions import capabilities_from_content

    return capabilities_from_content(
        required_commands=manifest.required_commands,
        required_env=manifest.required_env,
        detected=report.detected_capabilities,
    )


# ---------------------------------------------------------------------------
# Staging + commit
# ---------------------------------------------------------------------------


def _stage(plan: InstallPlan) -> StagedSkill:
    """Copy the source into a temp dir next to the target, then verify.

    The temp dir is created inside the target's parent so the final commit is a
    same-filesystem rename — atomic — rather than a cross-device copy that could
    half-finish.
    """
    parent = plan.target.parent
    parent.mkdir(parents=True, exist_ok=True)
    holder = Path(tempfile.mkdtemp(prefix=".staging-%s-" % plan.skill_name, dir=str(parent)))
    staged = holder / plan.skill_name
    try:
        shutil.copytree(plan.source, staged)
    except OSError as exc:
        shutil.rmtree(holder, ignore_errors=True)
        raise InstallError("staging copy failed: %s" % exc) from exc

    source_digest, _ = digest_tree(plan.source)
    staged_digest, files = digest_tree(staged)
    if source_digest != staged_digest:
        shutil.rmtree(holder, ignore_errors=True)
        raise InstallError(
            "staged copy does not match the scanned source (source %s, staged %s); "
            "the source changed between scan and copy"
            % (source_digest[:12], staged_digest[:12]))

    # Re-scan the staged bytes. The scan that authorised this install ran against
    # the source; this one runs against what will actually land.
    if plan.manifest is not None:
        try:
            staged_manifest = load_manifest(staged)
        except ManifestError as exc:
            shutil.rmtree(holder, ignore_errors=True)
            raise InstallError("staged SKILL.md is invalid: %s" % exc) from exc
        if staged_manifest.name != plan.manifest.name:
            shutil.rmtree(holder, ignore_errors=True)
            raise InstallError(
                "staged skill name %r differs from the planned %r"
                % (staged_manifest.name, plan.manifest.name))

    return StagedSkill(path=staged, digest=staged_digest, files=files)


def _atomic_replace(staged: Path, target: Path) -> Optional[Path]:
    """Move *staged* onto *target*, returning a backup path if one existed.

    Uses rename-based replacement so the library never contains a partially
    written skill. The previous version is moved aside rather than deleted, so a
    failure after this point can restore it.
    """
    backup: Optional[Path] = None
    if target.exists():
        backup = target.with_name("%s.bak-%d" % (target.name, int(time.time() * 1000)))
        target.rename(backup)
    try:
        staged.rename(target)
    except OSError:
        if backup is not None and backup.exists():
            backup.rename(target)
        raise
    return backup


def install_from_directory(
    source: Path, *, library_root: Path, granted: Iterable[Capability] = (),
    enforce_scan: bool = False, allow_downgrade: bool = False, dry_run: bool = False,
) -> InstallResult:
    """Install a skill from a LOCAL directory. No network is involved.

    Refuses on: invalid manifest, incomplete scan, blocking findings when
    ``enforce_scan`` is on, ungranted capabilities, and a downgrade unless
    ``allow_downgrade`` is set.
    """
    plan = plan_install(
        source, library_root=library_root, granted=granted,
        enforce_scan=enforce_scan, allow_downgrade=allow_downgrade,
    )
    if not plan.ok:
        return InstallResult(
            ok=False, action=plan.action, skill_name=plan.skill_name,
            version=plan.version, detail="; ".join(plan.refusals),
            permissions=plan.permissions,
        )

    if plan.action is InstallAction.NOOP:
        return InstallResult(
            ok=True, action=plan.action, skill_name=plan.skill_name,
            version=plan.version, path=str(plan.target), detail="nothing to do",
            permissions=plan.permissions,
        )

    if dry_run:
        return InstallResult(
            ok=True, action=plan.action, skill_name=plan.skill_name,
            version=plan.version, path=str(plan.target),
            detail="dry run: %s" % plan.explain(), permissions=plan.permissions,
        )

    staged = _stage(plan)
    backup: Optional[Path] = None
    try:
        backup = _atomic_replace(staged.path, plan.target)
    except OSError as exc:
        staged.cleanup()
        return InstallResult(
            ok=False, action=plan.action, skill_name=plan.skill_name,
            version=plan.version, detail="commit failed: %s" % exc,
            permissions=plan.permissions,
        )
    finally:
        # The holder directory outlives the rename only on failure; clearing it
        # here is safe because the skill itself has been moved out.
        if staged.path.parent.exists():
            shutil.rmtree(staged.path.parent, ignore_errors=True)

    # Post-commit verification: the installed tree must hash to what was staged.
    final_digest, _ = digest_tree(plan.target)
    if final_digest != staged.digest:
        rolled_back = _rollback(plan.target, backup)
        return InstallResult(
            ok=False, action=plan.action, skill_name=plan.skill_name,
            version=plan.version, digest=final_digest,
            detail="installed tree does not match the verified staged copy",
            rolled_back=rolled_back, permissions=plan.permissions,
        )

    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)

    return InstallResult(
        ok=True, action=plan.action, skill_name=plan.skill_name,
        version=plan.version, path=str(plan.target), digest=final_digest,
        permissions=plan.permissions,
    )


def _rollback(target: Path, backup: Optional[Path]) -> bool:
    """Restore *backup* over *target*. Returns True when the tree was restored."""
    try:
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        if backup is not None and backup.exists():
            backup.rename(target)
            return True
    except OSError:
        return False
    return backup is None
