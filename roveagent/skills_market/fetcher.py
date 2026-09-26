"""Fetch a skill from a git host into quarantine. **Never installs.**

Scope
-----
This module does exactly one thing: turn a git identifier into a frozen local
directory plus a provenance record. It deliberately stops there.

Why the split
-------------
``installer.py`` states an invariant in its own words::

    No network
    ----------
    The source must be a local directory. There is no remote fetch, no registry
    protocol, and no archive extraction, so none of the classic install-time
    remote code-execution surfaces exist here.

and it already closes a time-of-check window::

    Scanning the source and then copying it leaves a window where the source can
    change. Staging first, then re-verifying the staged copy against the digest
    recorded during the scan, means the artefact that lands is provably the one
    that was reviewed.

Adding "download then install" in one step would reopen exactly that window, and
adding ``httpx``/``subprocess`` to ``installer.py`` would delete its stated
property. So the capability is added *here* instead, as a separate step whose
output is an ordinary local directory. The installer stays network-free and
unchanged, and it remains the only thing that writes into the skill library.

Fetch is therefore not a privilege escalation: a fetched repository is inert
until ``installer.install_from_directory`` (scan → permission decision →
digest re-verify) accepts it, and per the approved design a skill asking for a
``HIGH_IMPACT`` capability still needs an explicit operator decision.

What this module defends against
--------------------------------
* **Wrong transport.** Only ``https://`` and ``ssh://`` (including scp-like
  ``user@host:path``) are accepted. ``http://`` and ``file://`` are refused.
* **Hanging the agent.** ``noninteractive_git_env()`` (reused, not reimplemented)
  sets ``GIT_TERMINAL_PROMPT=0`` / ``GCM_INTERACTIVE=Never``; ``GIT_ASKPASS`` is
  cleared and ssh runs with ``BatchMode=yes``. An unknown host key fails loudly
  instead of prompting — fail-closed, at the cost of needing a host key present.
* **Unbounded disk.** The tree is walked with the byte cap applied *during* the
  walk, so an oversized repository is refused without first being fully measured.
* **Path escape.** The ``#subdir`` fragment is resolved through the existing
  ``plugins_cmd._resolve_subdir_within``, which rejects anything leaving the clone.
* **Leftover state.** Every refusal path removes the quarantine directory. A
  refusal leaves no artefact behind for a later step to pick up by accident.

Reused rather than reimplemented: ``_resolve_git_url``, ``_resolve_subdir_within``,
``_resolve_git_executable`` (``clisupport/plugins_cmd.py``),
``noninteractive_git_env`` (``clisupport/_subprocess_compat.py``), and
``digest_tree`` (``skills_market/installer.py``).
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from roveagent.skills_market.installer import digest_tree

__all__ = [
    "FetchError",
    "FetchRefused",
    "FetchLimits",
    "FetchedSkill",
    "GitRunner",
    "SCHEME_PREFIXES",
    "SCP_LIKE",
    "DEFAULT_LIMITS",
    "fetch_skill",
]

#: Transports accepted for an agent-initiated fetch.
#: ``http://`` is excluded (unauthenticated, trivially MITM-able) and ``file://``
#: is excluded because a local source is what a *human* install uses — the agent
#: must not be able to reach filesystem paths through the fetch path.
SCHEME_PREFIXES: tuple[str, ...] = ("https://", "ssh://")

#: ``git@github.com:owner/repo.git`` — scp-like syntax, no scheme.
SCP_LIKE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]")


class FetchError(RuntimeError):
    """Base class for fetch failures."""


class FetchRefused(FetchError):
    """A refusal with a reason a human (or the agent) can act on."""


@dataclasses.dataclass(frozen=True)
class FetchLimits:
    """Hard caps. Defaults are deliberately small: a skill is prose plus a little code."""

    max_bytes: int = 32 * 1024 * 1024
    max_files: int = 5000
    timeout_seconds: int = 120


DEFAULT_LIMITS = FetchLimits()


#: A runner takes ``(argv, cwd, timeout)`` and returns ``(returncode, stdout, stderr)``.
#: Injectable so the refusal paths can be tested with no network at all.
GitRunner = Callable[[Sequence[str], Path, int], "tuple[int, str, str]"]


def _rmtree_force(path: Path) -> None:
    """Remove a tree that contains read-only files.

    Measured (2026-09-25, the opt-in real-clone test): plain
    ``shutil.rmtree(..., ignore_errors=True)`` left the quarantine directory behind
    on Windows, because a git clone leaves ``.git/objects/**`` read-only and the
    errors were being swallowed. The fake-runner tests could never catch it — they
    create ordinary writable files. Clearing the write bit first makes the removal
    actually happen on both platforms.
    """
    for root, dirs, files in os.walk(path):  # top-down: chmod a dir before descending
        for name in dirs + files:
            try:
                os.chmod(os.path.join(root, name), stat.S_IWRITE)
            except OSError:
                pass
    shutil.rmtree(path, ignore_errors=True)


@dataclasses.dataclass(frozen=True)
class FetchedSkill:
    """A frozen copy in quarantine. Not installed, not activated, not trusted."""

    identifier: str
    url: str
    subdir: Optional[str]
    path: Path
    quarantine: Path
    commit: str
    digest: str
    files: tuple[str, ...]
    total_bytes: int
    fetched_at: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "identifier": self.identifier,
            "url": self.url,
            "subdir": self.subdir,
            "path": str(self.path),
            "commit": self.commit,
            "digest": self.digest,
            "files": list(self.files),
            "total_bytes": self.total_bytes,
            "fetched_at": self.fetched_at,
        }

    def cleanup(self) -> None:
        _rmtree_force(self.quarantine)


def _default_runner(argv: Sequence[str], cwd: Path, timeout: int) -> tuple[int, str, str]:
    """Run git non-interactively. Reuses the project's hardened env."""
    from roveagent.clisupport._subprocess_compat import noninteractive_git_env

    env = noninteractive_git_env()
    # Belt and braces on top of the shared helper: an empty askpass plus batch-mode
    # ssh means "no way to ask a human", so a private repo fails instead of hanging.
    env["GIT_ASKPASS"] = ""
    env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o BatchMode=yes"
    proc = subprocess.run(  # noqa: S603 - argv is a list, no shell
        list(argv),
        cwd=str(cwd),
        env=env,
        timeout=timeout,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def _check_transport(identifier: str, resolved_url: str) -> None:
    if not identifier.strip():
        raise FetchRefused("empty source")
    if resolved_url.startswith(SCHEME_PREFIXES) or SCP_LIKE.match(resolved_url):
        return
    scheme = resolved_url.split("://", 1)[0] + "://" if "://" in resolved_url else resolved_url
    raise FetchRefused(
        "refused transport %r: agent-initiated fetch accepts only https:// or ssh:// "
        "(local paths are a human install, not a fetch)" % scheme
    )


def _measure(root: Path, limits: FetchLimits) -> tuple[int, tuple[str, ...]]:
    """Walk the tree, refusing the moment a cap is exceeded.

    Measuring first and checking afterwards would mean materialising a number for
    a repository that is already too large; the cap is applied during the walk.

    ``.git`` **is** counted towards the byte cap. ``--depth 1`` bounds history, not
    blob size: one enormous commit still lands its packfile in ``.git``, so
    excluding ``.git`` would let a repository fill the disk while reporting a size
    comfortably under the cap. (The file *list* still excludes ``.git`` — it
    describes the skill's contents, which is a different question from disk used.)
    """
    total = 0
    files: list[str] = []
    for entry in sorted(root.rglob("*")):
        if entry.is_symlink() or not entry.is_file():
            continue
        total += entry.stat().st_size
        relative = entry.relative_to(root)
        if ".git" not in relative.parts:
            # as_posix(): the digest and the provenance record must be identical on
            # Windows and inside the Linux container, so separators are normalised
            # rather than taken from the host.
            files.append(relative.as_posix())
        if total > limits.max_bytes:
            raise FetchRefused(
                "repository exceeds the %d byte cap (aborted during the walk; "
                ".git is included)" % limits.max_bytes
            )
        if len(files) > limits.max_files:
            raise FetchRefused(
                "repository exceeds the %d file cap" % limits.max_files
            )
    return total, tuple(files)


def fetch_skill(
    identifier: str,
    *,
    quarantine_root: Optional[Path] = None,
    limits: FetchLimits = DEFAULT_LIMITS,
    runner: Optional[GitRunner] = None,
) -> FetchedSkill:
    """Clone ``identifier`` into quarantine and return a description of what landed.

    Raises :class:`FetchRefused` for anything refused; the quarantine directory is
    removed on every refusal path. This function never writes to the skill library.
    """
    # Validated before anything else: a malformed identifier must come back as a
    # refusal this module owns, not as whatever the CLI-layer parser happens to
    # raise (it raises its own error type on unusable input).
    if not identifier.strip():
        raise FetchRefused("empty source")

    # Imported lazily: pulls in the CLI layer, which the installer-facing code
    # paths should not pay for, and keeps any import cycle out of module load.
    from roveagent.clisupport import plugins_cmd

    run = runner or _default_runner
    try:
        resolved_url, subdir = plugins_cmd._resolve_git_url(identifier)
    except Exception as exc:  # noqa: BLE001 - the parser's errors are not our contract
        raise FetchRefused(
            "could not parse source %r: %s: %s" % (identifier, type(exc).__name__, exc)
        ) from exc
    _check_transport(identifier, resolved_url)

    git = plugins_cmd._resolve_git_executable()
    if git is None:
        raise FetchRefused("git executable not found on PATH")

    if quarantine_root is None:
        from roveagent.constants import get_roveagent_home

        quarantine_root = get_roveagent_home() / "skill-quarantine"

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    # The directory name is derived from the identifier, not from the repository
    # content: the content does not exist yet, and a name the caller can predict is
    # more useful when reporting a refusal.
    from hashlib import sha256

    slug = sha256(identifier.encode("utf-8")).hexdigest()[:12]
    quarantine = Path(quarantine_root) / ("%s-%s" % (slug, stamp))
    repo = quarantine / "repo"

    def _cleanup() -> None:
        _rmtree_force(quarantine)

    try:
        quarantine.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise FetchRefused("quarantine directory already exists: %s" % quarantine) from None

    try:
        # --depth 1 --single-branch: one commit, no history. Hooks are not a vector
        # here — a fresh clone configures no hooks — so no hooksPath override is
        # passed (it would be platform-dependent and buys nothing).
        rc, _out, err = run(
            [git, "clone", "--depth", "1", "--no-tags", "--single-branch",
             "--quiet", resolved_url, str(repo)],
            quarantine,
            limits.timeout_seconds,
        )
        if rc != 0:
            raise FetchRefused("git clone failed (exit %d): %s" % (rc, err.strip()[:400]))

        rc, out, err = run([git, "rev-parse", "HEAD"], repo, limits.timeout_seconds)
        if rc != 0:
            raise FetchRefused("git rev-parse failed (exit %d): %s" % (rc, err.strip()[:400]))
        commit = out.strip()

        target = repo
        if subdir:
            # Reused: rejects anything that escapes the clone.
            target = plugins_cmd._resolve_subdir_within(repo, subdir)

        total_bytes, files = _measure(target, limits)
        if not files:
            raise FetchRefused("nothing to fetch: the resolved directory is empty")

        digest, digest_files = digest_tree(target)
        result = FetchedSkill(
            identifier=identifier,
            url=resolved_url,
            subdir=subdir,
            path=target,
            quarantine=quarantine,
            commit=commit,
            digest=digest,
            files=files,
            total_bytes=total_bytes,
            fetched_at=time.time(),
        )
        # Provenance lives beside the clone, never inside it: writing into the
        # skill directory would change the digest the installer is about to verify.
        (quarantine / "provenance.json").write_text(
            json.dumps(
                {
                    "identifier": identifier,
                    "url": resolved_url,
                    "subdir": subdir,
                    "commit": commit,
                    "digest": digest,
                    "digest_files": list(digest_files),
                    "total_bytes": total_bytes,
                    "fetched_at": result.fetched_at,
                    "limits": dataclasses.asdict(limits),
                    "note": "quarantined only; not installed, not activated",
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        return result
    except subprocess.TimeoutExpired as exc:
        _cleanup()
        raise FetchRefused("git timed out after %ss: %s" % (limits.timeout_seconds, exc)) from None
    except FetchRefused:
        _cleanup()
        raise
    except Exception as exc:  # noqa: BLE001 - any unexpected failure must not leave state
        _cleanup()
        raise FetchRefused("fetch failed: %s: %s" % (type(exc).__name__, exc)) from exc
