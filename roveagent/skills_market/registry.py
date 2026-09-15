"""Skill registry: what skills exist, at which versions, with which capabilities.

Design
------

The registry is an INDEX, not an authority. It records what is on disk and what
each skill declares. It never decides whether a skill may run — that is the
gate's job — and never decides whether it may be installed — that is the
installer's, with an operator's grant.

Discovery is read-only and defensive. A single malformed skill must not abort
indexing: it is recorded as an invalid entry with the reason, because a
marketplace that goes blank when one package is broken is worse than one that
shows the problem.

Interoperability
----------------

Directory discovery reuses ``core.skill_utils`` where it helps
(``parse_frontmatter`` via ``manifest.load_manifest``), and mirrors the layout
the existing library uses: ``<root>/<category>/<skill-name>/SKILL.md``. Both the
category level and a flat ``<root>/<skill-name>/SKILL.md`` are accepted, because
skills from different sources use both.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from roveagent.skills_market.manifest import (
    SKILL_FILENAME,
    ManifestError,
    SkillManifest,
    load_manifest,
)
from roveagent.skills_market.permissions import Capability, capabilities_from_content
from roveagent.skills_market.versions import SemVer, latest, parse_version

__all__ = [
    "SkillEntry",
    "InvalidSkill",
    "SkillRegistry",
    "discover",
]


@dataclasses.dataclass(frozen=True)
class SkillEntry:
    """One discovered skill at one path."""

    name: str
    manifest: SkillManifest
    path: Path
    category: str = ""

    @property
    def version(self) -> SemVer:
        return parse_version(self.manifest.version)

    @property
    def requested_capabilities(self) -> frozenset[Capability]:
        """What this skill will want, derived from its manifest.

        Derived rather than trusted: a manifest that under-declares still gets
        the capabilities its declared commands imply, because
        ``capabilities_from_content`` adds SHELL_EXECUTE for any declared
        command.
        """
        return capabilities_from_content(
            required_commands=self.manifest.required_commands,
            required_env=self.manifest.required_env,
            detected=(),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": self.manifest.version,
            "category": self.category,
            "path": str(self.path),
            "description": self.manifest.description,
            "tags": list(self.manifest.tags),
            "platforms": list(self.manifest.platforms),
            "requested_capabilities": sorted(c.value for c in self.requested_capabilities),
            "manifest_issues": [i.as_dict() for i in self.manifest.issues],
        }


@dataclasses.dataclass(frozen=True)
class InvalidSkill:
    """A directory that looks like a skill but could not be read."""

    path: Path
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {"path": str(self.path), "reason": self.reason}


def discover(root: Path, *, max_depth: int = 2) -> tuple[list[SkillEntry], list[InvalidSkill]]:
    """Walk *root* for SKILL.md files.

    ``max_depth`` bounds how deep a category nesting is followed, so a skill
    that happens to contain a vendored SKILL.md is not mistaken for a top-level
    skill.
    """
    base = Path(root)
    entries: list[SkillEntry] = []
    invalid: list[InvalidSkill] = []
    if not base.is_dir():
        return entries, invalid

    def _depth_of(path: Path) -> int:
        return len(path.relative_to(base).parts)

    candidates = [p for p in sorted(base.rglob(SKILL_FILENAME)) if p.is_file()]
    for skill_md in candidates:
        directory = skill_md.parent
        depth = _depth_of(directory)
        if depth > max_depth:
            continue
        try:
            manifest = load_manifest(directory)
        except ManifestError as exc:
            invalid.append(InvalidSkill(path=directory, reason=str(exc)))
            continue
        category = ""
        rel = directory.relative_to(base)
        if len(rel.parts) > 1:
            category = rel.parts[0]
        entries.append(SkillEntry(name=manifest.name, manifest=manifest,
                                  path=directory, category=category))
    return entries, invalid


class SkillRegistry:
    """In-memory index over one or more roots."""

    def __init__(self) -> None:
        self._entries: dict[str, list[SkillEntry]] = {}
        self._invalid: list[InvalidSkill] = []
        self._roots: list[Path] = []

    # -- building ------------------------------------------------------

    def index(self, root: Path, *, max_depth: int = 2) -> tuple[int, int]:
        """Index *root*. Returns ``(added, invalid)``. Idempotent per path."""
        base = Path(root)
        if base in self._roots:
            return 0, 0
        entries, invalid = discover(base, max_depth=max_depth)
        for entry in entries:
            self.add(entry)
        self._invalid.extend(invalid)
        self._roots.append(base)
        return len(entries), len(invalid)

    def add(self, entry: SkillEntry) -> None:
        bucket = self._entries.setdefault(entry.name, [])
        for index, existing in enumerate(bucket):
            if existing.path == entry.path:
                bucket[index] = entry
                return
        bucket.append(entry)

    # -- querying ------------------------------------------------------

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._entries))

    def __len__(self) -> int:
        return sum(len(v) for v in self._entries.values())

    def versions(self, name: str) -> tuple[SemVer, ...]:
        key = str(name or "").strip().lower()
        return tuple(sorted(e.version for e in self._entries.get(key, ())))

    def latest(self, name: str, *, include_prerelease: bool = False) -> Optional[SkillEntry]:
        """Newest entry for *name*, or None."""
        key = str(name or "").strip().lower()
        bucket = self._entries.get(key)
        if not bucket:
            return None
        if include_prerelease:
            pool = bucket
        else:
            pool = [e for e in bucket if not e.version.is_prerelease] or []
            if not pool:
                return None
        return max(pool, key=lambda e: e.version)

    def get(self, name: str, version: Optional[str] = None) -> Optional[SkillEntry]:
        key = str(name or "").strip().lower()
        if version is None:
            return self.latest(key)
        wanted = parse_version(version)
        for entry in self._entries.get(key, ()):
            if entry.version == wanted:
                return entry
        return None

    def all(self) -> tuple[SkillEntry, ...]:
        return tuple(
            entry for name in sorted(self._entries) for entry in
            sorted(self._entries[name], key=lambda e: e.version)
        )

    def by_category(self, category: str) -> tuple[SkillEntry, ...]:
        wanted = str(category or "").strip()
        return tuple(e for e in self.all() if e.category == wanted)

    def with_capability(self, capability: object) -> tuple[SkillEntry, ...]:
        """Skills that would REQUEST *capability*. A request is not a grant."""
        target = capability if isinstance(capability, Capability) else Capability(str(capability))
        return tuple(e for e in self.all() if target in e.requested_capabilities)

    def with_tag(self, tag: str) -> tuple[SkillEntry, ...]:
        wanted = str(tag or "").strip().lower()
        return tuple(
            e for e in self.all()
            if any(t.lower() == wanted for t in e.manifest.tags)
        )

    def invalid(self) -> tuple[InvalidSkill, ...]:
        return tuple(self._invalid)

    def stats(self) -> dict[str, Any]:
        entries = self.all()
        return {
            "skills": len(self._entries),
            "versions": len(entries),
            "roots": [str(r) for r in self._roots],
            "invalid": len(self._invalid),
            "categories": sorted({e.category for e in entries if e.category}),
        }

    def describe(self) -> list[dict[str, Any]]:
        return [e.as_dict() for e in self.all()]
