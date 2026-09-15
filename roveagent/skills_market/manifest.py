"""Skill manifest: what a skill declares about itself.

The SKILL.md frontmatter is the format, and ``core.skill_utils.parse_frontmatter``
is the parser. This module does not re-implement YAML handling; it turns the
parsed mapping into a typed, validated object so that everything downstream
(registry, installer, scanner, permissions) works against one shape instead of
re-reading loose dicts.

Validation policy
-----------------

Two classes of field:

  * Fatal (``ManifestError``) — ``name``, ``description``, ``version``. These
    are load-bearing: ``name`` must match the directory or discovery and
    installation disagree about identity; ``description`` is what a model reads
    to decide whether to use the skill, so an empty one makes it unusable;
    ``version`` drives upgrade decisions.
  * Advisory (``ManifestIssue``) — everything else, including unknown
    frontmatter keys. An unrecognised key is recorded, not rejected: the format
    is expected to grow, and a marketplace that refuses to read a skill because
    it carries a newer optional field would be useless.

Constraints on ``name`` and ``description`` come from the Agent Skills rules in
``clisupport.agent_plugins._valid_skill_frontmatter`` and are duplicated here as
constants rather than imported, because that function validates a different
(portable plugin) object and importing it would couple two formats. A test
asserts the two agree on the fields they share.
"""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path
from typing import Any, Mapping, Optional

from roveagent.core.skill_utils import parse_frontmatter
from roveagent.skills_market.versions import SemVer, VersionError, parse_version

__all__ = [
    "ManifestError",
    "ManifestIssue",
    "SkillManifest",
    "SKILL_FILENAME",
    "SKILL_NAME_RE",
    "MAX_DESCRIPTION_LENGTH",
    "load_manifest",
]

SKILL_FILENAME = "SKILL.md"

#: Agent Skills name rule: lowercase alphanumeric segments separated by single
#: hyphens, no leading/trailing/double hyphen. Kept identical to
#: ``agent_plugins._SKILL_NAME_RE``.
SKILL_NAME_RE = re.compile(r"^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$")

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MAX_COMPATIBILITY_LENGTH = 500


class ManifestError(ValueError):
    """A fatal, structural problem: the skill cannot be treated as a skill."""


@dataclasses.dataclass(frozen=True)
class ManifestIssue:
    """A non-fatal observation about the manifest."""

    code: str
    field: str
    message: str

    def as_dict(self) -> dict:
        return {"code": self.code, "field": self.field, "message": self.message}


def _as_str_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,) if value.strip() else ()
    if isinstance(value, (list, tuple, set, frozenset)):
        return tuple(str(v).strip() for v in value if str(v).strip())
    return (str(value).strip(),) if str(value).strip() else ()


def _metadata_block(frontmatter: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = frontmatter.get("metadata")
    return metadata if isinstance(metadata, Mapping) else {}


@dataclasses.dataclass(frozen=True)
class SkillManifest:
    """Typed view of one SKILL.md frontmatter block."""

    name: str
    description: str
    version: str = "0.0.0"
    author: str = ""
    license: str = ""
    platforms: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    related_skills: tuple[str, ...] = ()
    required_commands: tuple[str, ...] = ()
    required_env: tuple[str, ...] = ()
    allowed_tools: str = ""
    compatibility: str = ""
    metadata: Mapping[str, Any] = dataclasses.field(default_factory=dict)
    issues: tuple[ManifestIssue, ...] = ()
    source_path: str = ""

    # -- construction --------------------------------------------------

    @classmethod
    def from_frontmatter(
        cls, frontmatter: Mapping[str, Any], *, directory_name: str = "",
        source_path: str = "",
    ) -> "SkillManifest":
        """Build from a parsed frontmatter mapping. Raises on fatal problems."""
        if not isinstance(frontmatter, Mapping):
            raise ManifestError("frontmatter must be a mapping")

        issues: list[ManifestIssue] = []

        name = frontmatter.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ManifestError("frontmatter must declare a non-empty 'name'")
        name = name.strip()
        if directory_name and name != directory_name:
            raise ManifestError(
                "frontmatter name %r does not match directory %r; discovery and "
                "installation would disagree about this skill's identity"
                % (name, directory_name)
            )
        if not 1 <= len(name) <= MAX_NAME_LENGTH:
            raise ManifestError(
                "name must be 1..%d characters, got %d" % (MAX_NAME_LENGTH, len(name)))
        if SKILL_NAME_RE.fullmatch(name) is None:
            raise ManifestError(
                "name %r must be lowercase alphanumeric segments separated by "
                "single hyphens (e.g. apple-notes)" % name
            )

        description = frontmatter.get("description")
        if not isinstance(description, str) or not description.strip():
            raise ManifestError(
                "frontmatter must declare a non-empty 'description'; it is what a "
                "model reads when deciding whether to use the skill"
            )
        description = description.strip()
        if len(description) > MAX_DESCRIPTION_LENGTH:
            raise ManifestError(
                "description must be at most %d characters, got %d"
                % (MAX_DESCRIPTION_LENGTH, len(description))
            )

        raw_version = frontmatter.get("version", "0.0.0")
        version = str(raw_version).strip() or "0.0.0"
        try:
            parse_version(version)
        except VersionError as exc:
            raise ManifestError("version is not valid: %s" % exc) from exc

        author = frontmatter.get("author")
        if author is not None and not isinstance(author, str):
            issues.append(ManifestIssue("author_not_string", "author",
                                        "author should be a string; it was ignored"))
            author = ""
        license_value = frontmatter.get("license")
        if license_value is not None and not isinstance(license_value, str):
            issues.append(ManifestIssue("license_not_string", "license",
                                        "license should be a string; it was ignored"))
            license_value = ""

        compatibility = frontmatter.get("compatibility")
        if compatibility is not None:
            if not isinstance(compatibility, str) or not 1 <= len(compatibility) <= MAX_COMPATIBILITY_LENGTH:
                issues.append(ManifestIssue(
                    "compatibility_invalid", "compatibility",
                    "compatibility should be a string of 1..%d characters; it was "
                    "ignored" % MAX_COMPATIBILITY_LENGTH))
                compatibility = ""

        allowed = frontmatter.get("allowed-tools")
        if allowed is not None and not isinstance(allowed, str):
            issues.append(ManifestIssue(
                "allowed_tools_not_string", "allowed-tools",
                "allowed-tools should be a string of tool matchers; it was ignored"))
            allowed = ""

        metadata = _metadata_block(frontmatter)
        roveagent_meta = metadata.get("roveagent")
        roveagent_meta = roveagent_meta if isinstance(roveagent_meta, Mapping) else {}

        tags = _as_str_tuple(roveagent_meta.get("tags")) or _as_str_tuple(frontmatter.get("tags"))
        related = (_as_str_tuple(roveagent_meta.get("related_skills"))
                   or _as_str_tuple(frontmatter.get("related_skills")))

        prerequisites = frontmatter.get("prerequisites")
        prerequisites = prerequisites if isinstance(prerequisites, Mapping) else {}
        required_commands = _as_str_tuple(prerequisites.get("commands"))
        required_env = _as_str_tuple(prerequisites.get("env"))

        known = {
            "name", "description", "version", "author", "license", "platforms",
            "tags", "related_skills", "metadata", "prerequisites",
            "allowed-tools", "compatibility",
        }
        for key in sorted(set(frontmatter) - known):
            issues.append(ManifestIssue(
                "unknown_field", str(key),
                "unrecognised frontmatter field %r was preserved but is not "
                "interpreted" % key,
            ))

        return cls(
            name=name,
            description=description,
            version=version,
            author=str(author or ""),
            license=str(license_value or ""),
            platforms=_as_str_tuple(frontmatter.get("platforms")),
            tags=tags,
            related_skills=related,
            required_commands=required_commands,
            required_env=required_env,
            allowed_tools=str(allowed or ""),
            compatibility=str(compatibility or ""),
            metadata=dict(metadata),
            issues=tuple(issues),
            source_path=source_path,
        )

    # -- derived -------------------------------------------------------

    @property
    def semver(self) -> SemVer:
        return parse_version(self.version)

    @property
    def requires_external_commands(self) -> bool:
        """True when the skill shells out to binaries that must be present."""
        return bool(self.required_commands)

    @property
    def declares_tool_restrictions(self) -> bool:
        return bool(self.allowed_tools.strip())

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "license": self.license,
            "platforms": list(self.platforms),
            "tags": list(self.tags),
            "related_skills": list(self.related_skills),
            "required_commands": list(self.required_commands),
            "required_env": list(self.required_env),
            "allowed_tools": self.allowed_tools,
            "compatibility": self.compatibility,
            "issues": [i.as_dict() for i in self.issues],
            "source_path": self.source_path,
        }


def load_manifest(skill_dir: Path) -> SkillManifest:
    """Read and validate ``<skill_dir>/SKILL.md``.

    ``parse_frontmatter`` is used unmodified, so the frontmatter contract stays
    owned by ``core.skill_utils`` and every other consumer of SKILL.md keeps
    agreeing with this one.
    """
    directory = Path(skill_dir)
    skill_md = directory / SKILL_FILENAME
    if not skill_md.is_file():
        raise ManifestError("no %s in %s" % (SKILL_FILENAME, directory))
    try:
        text = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ManifestError("cannot read %s: %s" % (skill_md, exc)) from exc

    try:
        frontmatter, _body = parse_frontmatter(text)
    except Exception as exc:  # noqa: BLE001 — the shared parser raises its own types
        raise ManifestError("invalid frontmatter in %s: %s" % (skill_md, exc)) from exc

    return SkillManifest.from_frontmatter(
        frontmatter, directory_name=directory.name, source_path=str(skill_md))
