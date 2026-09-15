"""Canonical content hash for social publications.

Why a content hash exists
-------------------------

An approval is a promise about SPECIFIC bytes. If the promise is bound to
"publish the marketing post" rather than to the exact text and media, then
anything that can mutate the post between approval and execution silently
hijacks the approval. The content hash closes that gap: the approval records
the hash, execution re-derives it, and a mismatch is a hard refusal.

Two properties matter, and they pull in opposite directions:

  * STABILITY — the same logical content must always hash the same, or honest
    retries look like tampering. Achieved by normalising Unicode (NFC) and line
    endings before hashing.
  * SENSITIVITY — any change that alters what a reader sees must change the
    hash. So normalisation is deliberately narrow: it performs only the
    transformations that are provably invisible, and it never strips content.

Media is identified by CONTENT DIGEST, never by path or URL. A path-based
reference would let a file be swapped between approval and execution while the
hash stayed constant — precisely the attack the hash is meant to stop.

The canonicalisation here mirrors ``enterprise.approval_grants.fingerprint``
exactly (``sort_keys=True``, ``ensure_ascii=False``, ``separators=(",", ":")``,
``default=str``) so that a content hash and an approval fingerprint cannot
disagree about the same bytes. That equality is asserted by a test rather than
assumed, because the two live in different modules and could drift.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import unicodedata
from enum import Enum
from typing import Any, Iterable, Mapping, Optional, Sequence

__all__ = [
    "MediaKind",
    "Visibility",
    "MediaRef",
    "PublicationContent",
    "canonical_json",
    "normalize_text",
    "content_hash",
    "content_envelope",
]


class MediaKind(str, Enum):
    IMAGE = "image"
    VIDEO = "video"


class Visibility(str, Enum):
    """Who may see the published item.

    Constrained to an allowlist rather than a free string: visibility is part
    of the content hash, and an unconstrained field invites typos that would
    silently produce a different (or invalid) publication.
    """

    PUBLIC = "public"
    CONNECTIONS = "connections"
    PRIVATE = "private"
    UNLISTED = "unlisted"


@dataclasses.dataclass(frozen=True)
class MediaRef:
    """A reference to one media asset, identified by its content digest.

    ``sha256`` is the hex digest of the asset BYTES. Paths and URLs are
    deliberately not part of the identity: the same bytes must hash the same
    wherever they live, and different bytes must never collide just because a
    path was reused.
    """

    kind: MediaKind
    sha256: str
    mime: str = ""
    size_bytes: int = 0
    width: Optional[int] = None
    height: Optional[int] = None
    duration_s: Optional[float] = None
    alt_text: str = ""

    def __post_init__(self) -> None:
        digest = (self.sha256 or "").strip().lower()
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError(
                "MediaRef.sha256 must be a 64-character lowercase hex digest of "
                "the asset bytes; got %r" % (self.sha256,)
            )
        object.__setattr__(self, "sha256", digest)
        if self.size_bytes < 0:
            raise ValueError("MediaRef.size_bytes must not be negative")
        if self.duration_s is not None and self.duration_s < 0:
            raise ValueError("MediaRef.duration_s must not be negative")

    @property
    def aspect_ratio(self) -> Optional[float]:
        if not self.width or not self.height:
            return None
        return self.width / self.height

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "sha256": self.sha256,
            "mime": self.mime,
            "size_bytes": self.size_bytes,
            "width": self.width,
            "height": self.height,
            "duration_s": self.duration_s,
            "alt_text": normalize_text(self.alt_text),
        }


def normalize_text(value: str) -> str:
    """Apply only the transformations that are invisible to a reader.

    NFC composition and CRLF/CR -> LF. Nothing else: this function must never
    become a licence to silently rewrite content the user approved. Leading and
    trailing whitespace is preserved on purpose — trimming it would make two
    genuinely different payloads collapse to one hash.
    """
    if not value:
        return ""
    return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))


def canonical_json(value: Any) -> str:
    """Canonical JSON, byte-identical to the approval-fingerprint input.

    Kept in lockstep with ``enterprise.approval_grants.fingerprint`` by an
    explicit test; a divergence would let an approval and its content hash
    describe different payloads.
    """
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), default=str,
    )


def _as_sequence(value: Any) -> Sequence[Any]:
    if value is None:
        return ()
    if isinstance(value, (str, bytes, bytearray)):
        return (value,)
    if isinstance(value, (list, tuple, set, frozenset)):
        return tuple(value)
    return (value,)


@dataclasses.dataclass(frozen=True)
class PublicationContent:
    """Everything that determines what a reader will see.

    Order is significant for ``media`` — carousels publish in order — so it is
    preserved exactly as given. ``tags`` is de-duplicated and sorted because
    tag order carries no meaning on any target platform, and treating two
    orderings of the same tags as different content would reject honest retries.
    """

    text: str = ""
    title: str = ""
    media: tuple[MediaRef, ...] = ()
    visibility: Visibility = Visibility.PUBLIC
    language: str = ""
    tags: tuple[str, ...] = ()
    link_url: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "media", tuple(_as_sequence(self.media)))
        raw_tags: Iterable[Any] = _as_sequence(self.tags)
        cleaned = {
            normalize_text(str(t)).strip().lstrip("#")
            for t in raw_tags
            if str(t).strip()
        }
        object.__setattr__(self, "tags", tuple(sorted(cleaned)))
        if not isinstance(self.visibility, Visibility):
            raise ValueError(
                "visibility must be a Visibility value; got %r" % (self.visibility,)
            )
        for index, item in enumerate(self.media):
            if not isinstance(item, MediaRef):
                raise ValueError(
                    "media[%d] must be a MediaRef; got %s" % (index, type(item).__name__)
                )

    # -- derived views -------------------------------------------------
    @property
    def images(self) -> tuple[MediaRef, ...]:
        return tuple(m for m in self.media if m.kind is MediaKind.IMAGE)

    @property
    def videos(self) -> tuple[MediaRef, ...]:
        return tuple(m for m in self.media if m.kind is MediaKind.VIDEO)

    @property
    def is_empty(self) -> bool:
        return not (self.text.strip() or self.title.strip() or self.media)

    def as_dict(self) -> dict[str, Any]:
        """The canonical mapping that is hashed. Order-stable by construction."""
        return {
            "text": normalize_text(self.text),
            "title": normalize_text(self.title),
            "media": [m.as_dict() for m in self.media],
            "visibility": self.visibility.value,
            "language": normalize_text(self.language),
            "tags": list(self.tags),
            "link_url": normalize_text(self.link_url),
        }

    def with_media(self, *media: MediaRef) -> "PublicationContent":
        """Return a copy with the media list replaced (used by adapters/tests)."""
        return dataclasses.replace(self, media=tuple(media))


def content_envelope(platform: str, content: PublicationContent) -> dict[str, Any]:
    """The mapping an approval is bound to.

    Platform is included because the same text publishes differently on
    different platforms (truncation, media rules), so an approval for one must
    not be replayable against another.
    """
    return {"platform": str(platform or "").strip().lower(), "content": content.as_dict()}


def content_hash(platform: str, content: PublicationContent) -> str:
    """sha256 over the canonical envelope. This is the anti-tamper anchor."""
    if not isinstance(content, PublicationContent):
        raise TypeError("content must be a PublicationContent")
    canonical = canonical_json(content_envelope(platform, content))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
