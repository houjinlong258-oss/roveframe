"""Semantic version parsing, comparison, and constraint matching.

Why not a dependency
--------------------

Version comparison is small, and the project forbids new dependencies. Writing
it here also lets the rules be explicit: a malformed version must be a loud
error rather than something coerced into 0.0.0, because silently treating
"latest" as "oldest" would install the wrong skill.

Supported syntax
----------------

    MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]

Prerelease and build metadata follow SemVer 2.0.0 §9-§11:

  * A prerelease ranks BELOW the release it precedes: 1.0.0-rc.1 < 1.0.0.
  * Numeric prerelease identifiers compare numerically, so 1.0.0-rc.2 >
    1.0.0-rc.10 would be WRONG — the correct answer is rc.2 < rc.10. This is
    the classic trap and is handled explicitly.
  * Build metadata is ignored for precedence (SemVer §10), but preserved so it
    survives a round trip.

Constraint syntax is deliberately narrow — caret, tilde, comparison, and exact
— so an unsupported operator fails loudly instead of being misread as
"anything".
"""

from __future__ import annotations

import dataclasses
import re
from typing import Iterable, Optional, Sequence

__all__ = [
    "VersionError",
    "SemVer",
    "Constraint",
    "parse_version",
    "latest",
    "satisfies",
    "select_version",
]

_SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9]\d*)"
    r"\.(?P<minor>0|[1-9]\d*)"
    r"\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z.-]+))?"
    r"(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)


class VersionError(ValueError):
    """Raised for a malformed version or constraint.

    Deliberately not swallowed anywhere in this package: a bad version string
    means the caller does not know what it is asking for, and guessing would
    install something unintended.
    """


@dataclasses.dataclass(frozen=True, order=False)
class SemVer:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...] = ()
    build: str = ""

    @classmethod
    def parse(cls, value: str) -> "SemVer":
        if not isinstance(value, str):
            raise VersionError("version must be a string, got %s" % type(value).__name__)
        match = _SEMVER_RE.match(value.strip())
        if match is None:
            raise VersionError(
                "not a semantic version: %r (expected MAJOR.MINOR.PATCH)"
                % (value,)
            )
        pre = match.group("pre") or ""
        parts = tuple(p for p in pre.split(".") if p != "") if pre else ()
        return cls(
            major=int(match.group("major")),
            minor=int(match.group("minor")),
            patch=int(match.group("patch")),
            prerelease=parts,
            build=match.group("build") or "",
        )

    def __str__(self) -> str:
        base = "%d.%d.%d" % (self.major, self.minor, self.patch)
        if self.prerelease:
            base += "-" + ".".join(self.prerelease)
        if self.build:
            base += "+" + self.build
        return base

    @property
    def release(self) -> tuple[int, int, int]:
        return (self.major, self.minor, self.patch)

    @property
    def is_prerelease(self) -> bool:
        return bool(self.prerelease)

    def _precedence(self) -> tuple:
        """Sort key implementing SemVer §11 precedence.

        ``(release, prerelease_rank, prerelease_key)``. ``prerelease_rank`` is 0
        for a prerelease and 1 for a release, which is what makes 1.0.0-rc.1
        sort below 1.0.0. ``prerelease_key`` encodes each identifier so numeric
        ones compare numerically and shorter sets rank lower (1.0.0-rc <
        1.0.0-rc.1).
        """
        if not self.prerelease:
            return (self.release, 1, ())
        key = []
        for identifier in self.prerelease:
            if identifier.isdigit():
                # 0-pad so that numeric identifiers compare numerically even
                # though a tuple of mixed types cannot.
                key.append((0, int(identifier), ""))
            else:
                key.append((1, 0, identifier))
        return (self.release, 0, tuple(key))

    def __lt__(self, other: "SemVer") -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        return self._precedence() < other._precedence()

    def __le__(self, other: "SemVer") -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        return self._precedence() <= other._precedence()

    def __gt__(self, other: "SemVer") -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        return self._precedence() > other._precedence()

    def __ge__(self, other: "SemVer") -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        return self._precedence() >= other._precedence()

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        # Build metadata is excluded from precedence (SemVer §10), so it is
        # excluded from ordering equality too; comparing it here would make
        # `==` and `<`/`>` disagree.
        return self._precedence() == other._precedence()

    def __hash__(self) -> int:
        return hash(self._precedence())

    def same_release_as(self, other: "SemVer") -> bool:
        """Compare ignoring prerelease and build — i.e. 1.2.3 vs 1.2.3-rc.1."""
        return self.release == other.release


def parse_version(value: object) -> SemVer:
    """Accept a SemVer or a string; raise VersionError otherwise."""
    if isinstance(value, SemVer):
        return value
    if isinstance(value, str):
        return SemVer.parse(value)
    raise VersionError("version must be a string or SemVer, got %s" % type(value).__name__)


# ---------------------------------------------------------------------------
# Constraints
# ---------------------------------------------------------------------------

_CARET_RE = re.compile(r"^\^(?P<v>.+)$")
_TILDE_RE = re.compile(r"^~(?P<v>.+)$")
_OP_RE = re.compile(r"^(?P<op>>=|<=|==|=|>|<)(?P<v>.+)$")


@dataclasses.dataclass(frozen=True)
class Constraint:
    """One version predicate.

    ``operator`` is one of ``exact``, ``>``, ``>=``, ``<``, ``<=``, ``caret``,
    ``tilde``. Caret and tilde follow the widely used npm/Cargo reading:

      * ``^1.2.3``  >= 1.2.3 and < 2.0.0
      * ``^0.2.3``  >= 0.2.3 and < 0.3.0   (0.x: the minor is the breaking part)
      * ``^0.0.3``  >= 0.0.3 and < 0.0.4   (0.0.x: the patch is breaking)
      * ``~1.2.3``  >= 1.2.3 and < 1.3.0
    """

    raw: str
    operator: str
    version: SemVer

    @classmethod
    def parse(cls, value: str) -> "Constraint":
        if not isinstance(value, str) or not value.strip():
            raise VersionError("constraint must be a non-empty string")
        text = value.strip()

        caret = _CARET_RE.match(text)
        if caret:
            return cls(text, "caret", SemVer.parse(caret.group("v")))

        tilde = _TILDE_RE.match(text)
        if tilde:
            return cls(text, "tilde", SemVer.parse(tilde.group("v")))

        op = _OP_RE.match(text)
        if op:
            symbol = op.group("op")
            operator = "exact" if symbol in ("=", "==") else symbol
            return cls(text, operator, SemVer.parse(op.group("v")))

        # Bare version -> exact.
        return cls(text, "exact", SemVer.parse(text))

    def _upper_exclusive(self) -> Optional[SemVer]:
        v = self.version
        if self.operator == "caret":
            if v.major > 0:
                return SemVer(v.major + 1, 0, 0)
            if v.minor > 0:
                return SemVer(0, v.minor + 1, 0)
            return SemVer(0, 0, v.patch + 1)
        if self.operator == "tilde":
            return SemVer(v.major, v.minor + 1, 0)
        return None

    def matches(self, candidate: SemVer, *, allow_prerelease: bool = False) -> bool:
        if candidate.is_prerelease and not allow_prerelease and self.operator != "exact":
            # A prerelease only satisfies a constraint that names one, or an
            # exact match. Otherwise `>=1.0.0` would silently accept `2.0.0-rc1`
            # over a stable release.
            if not self.version.is_prerelease:
                return False

        if self.operator == "exact":
            return candidate.same_release_as(self.version) and (
                bool(candidate.prerelease) == bool(self.version.prerelease)
                and candidate.prerelease == self.version.prerelease
            )
        if self.operator == ">":
            return candidate > self.version
        if self.operator == ">=":
            return candidate >= self.version
        if self.operator == "<":
            return candidate < self.version
        if self.operator == "<=":
            return candidate <= self.version

        upper = self._upper_exclusive()
        assert upper is not None  # caret/tilde always produce a bound
        return candidate >= self.version and candidate < upper

    def __str__(self) -> str:
        return self.raw


def satisfies(version: object, constraint: str, *, allow_prerelease: bool = False) -> bool:
    """True when *version* meets *constraint*."""
    return Constraint.parse(constraint).matches(
        parse_version(version), allow_prerelease=allow_prerelease)


def latest(versions: Iterable[object], *, include_prerelease: bool = False) -> Optional[SemVer]:
    """Highest version, or None for an empty input.

    Prereleases are excluded by default: "latest" in an install path must not
    silently mean "latest release candidate".
    """
    parsed = [parse_version(v) for v in versions]
    if not include_prerelease:
        parsed = [p for p in parsed if not p.is_prerelease]
    if not parsed:
        return None
    return max(parsed)


def select_version(
    versions: Sequence[object], constraint: Optional[str] = None, *,
    include_prerelease: bool = False, allow_downgrade: bool = True,
    installed: Optional[object] = None,
) -> Optional[SemVer]:
    """Pick the best version satisfying *constraint*.

    Returns None when nothing matches — never falls back to an arbitrary
    version, because "no satisfying version" and "here is a version" must not be
    confusable by a caller about to write to disk.
    """
    candidates = [parse_version(v) for v in versions]
    if constraint:
        parsed_constraint = Constraint.parse(constraint)
        candidates = [
            c for c in candidates
            if parsed_constraint.matches(c, allow_prerelease=include_prerelease)
        ]
    if not include_prerelease:
        candidates = [c for c in candidates if not c.is_prerelease]
    if not candidates:
        return None

    best = max(candidates)
    if installed is not None and not allow_downgrade:
        current = parse_version(installed)
        if best < current:
            return None
    return best
