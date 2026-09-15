"""Per-platform content validators (LinkedIn / TikTok / YouTube).

Design rules
------------

1. ONLY VERIFIED LIMITS ARE ENFORCED. Every numeric bound below carries the
   source it came from and the date it was retrieved. Limits drift, so an
   unverified number is worse than no check: it either rejects valid posts or
   blesses invalid ones while looking authoritative.

   YouTube's tag budget (commonly quoted as 500 characters total) is
   deliberately NOT enforced — it could not be confirmed against a primary
   source, so it is omitted rather than guessed.

2. VALIDATION IS PURE. No network, no clock, no filesystem. The same content
   always yields the same verdict, which is what lets the gateway refuse a bad
   post before any approval is spent.

3. ERRORS AND WARNINGS ARE DIFFERENT THINGS. ``error`` blocks publication;
   ``warning`` records a judgement call (an aspect ratio the platform accepts
   but that will be letterboxed, a text that will be truncated in the feed).
   Collapsing them would either block legitimate posts or hide real problems.

Source table (retrieved 2026-09-12)
-----------------------------------

LinkedIn
  post text   <= 3000 characters
  https://www.linkedin.com/help/linkedin/answer/a528176
  https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api

TikTok
  caption     <= 2200 UTF-16 code units
  video       3 s .. 600 s
  max file    1 GB
  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
  https://zernio.com/blog/tiktok-posting-api

YouTube
  title       <= 100 characters
  description <= 5000 characters
  https://developers.google.com/youtube/v3/docs/videos
  https://typecount.com/blog/youtube-description-character-limit

The TikTok caption bound is expressed in UTF-16 code units, which is NOT the
same as Python's ``len()``: Python counts code points, so an emoji costs 1
while TikTok charges 2. ``utf16_length`` is used for that check; using ``len``
would under-count and let over-long captions through.
"""

from __future__ import annotations

import dataclasses
from enum import Enum
from typing import Mapping, Optional, Sequence

from roveagent.social.content import MediaKind, PublicationContent, Visibility

__all__ = [
    "Severity",
    "ValidationIssue",
    "ValidationResult",
    "PlatformLimits",
    "utf16_length",
    "LINKEDIN",
    "TIKTOK",
    "YOUTUBE",
    "LIMITS",
    "limits_for",
    "validate",
    "validate_linkedin",
    "validate_tiktok",
    "validate_youtube",
]

SOURCE_RETRIEVED = "2026-09-12"


class Severity(str, Enum):
    ERROR = "error"      # blocks publication
    WARNING = "warning"  # publishes, but the operator should know


@dataclasses.dataclass(frozen=True)
class ValidationIssue:
    code: str
    field: str
    message: str
    severity: Severity = Severity.ERROR
    limit: Optional[float] = None
    actual: Optional[float] = None

    def as_dict(self) -> dict:
        out = {
            "code": self.code,
            "field": self.field,
            "severity": self.severity.value,
            "message": self.message,
        }
        if self.limit is not None:
            out["limit"] = self.limit
        if self.actual is not None:
            out["actual"] = self.actual
        return out


@dataclasses.dataclass(frozen=True)
class ValidationResult:
    platform: str
    issues: tuple[ValidationIssue, ...] = ()

    @property
    def errors(self) -> tuple[ValidationIssue, ...]:
        return tuple(i for i in self.issues if i.severity is Severity.ERROR)

    @property
    def warnings(self) -> tuple[ValidationIssue, ...]:
        return tuple(i for i in self.issues if i.severity is Severity.WARNING)

    @property
    def ok(self) -> bool:
        """Publishable. Warnings do not block."""
        return not self.errors

    def summary(self) -> str:
        if self.ok and not self.warnings:
            return "%s: content is valid" % self.platform
        parts = []
        if self.errors:
            parts.append("%d error(s)" % len(self.errors))
        if self.warnings:
            parts.append("%d warning(s)" % len(self.warnings))
        return "%s: %s" % (self.platform, ", ".join(parts))

    def as_dict(self) -> dict:
        return {
            "platform": self.platform,
            "ok": self.ok,
            "issues": [i.as_dict() for i in self.issues],
        }


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, which is what TikTok's API counts.

    Python's ``len`` counts code points; a non-BMP character (most emoji) is
    one code point but two UTF-16 units. Encoding to UTF-16 with
    ``surrogatepass`` and halving the byte count is the exact measure.
    """
    if not text:
        return 0
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


@dataclasses.dataclass(frozen=True)
class PlatformLimits:
    """Declared limits for one platform, each field carrying its provenance.

    ``source`` and ``retrieved`` are required rather than optional: a limit
    with no provenance is indistinguishable from a guess, and this module's
    whole value rests on the numbers being checkable.
    """

    platform: str
    source: str
    retrieved: str = SOURCE_RETRIEVED
    text_max: Optional[int] = None
    text_max_unit: str = "characters"
    title_max: Optional[int] = None
    title_required: bool = False
    media_required: Optional[MediaKind] = None
    max_images: Optional[int] = None
    max_videos: Optional[int] = None
    video_min_seconds: Optional[float] = None
    video_max_seconds: Optional[float] = None
    max_media_bytes: Optional[int] = None
    allowed_visibilities: tuple[Visibility, ...] = (
        Visibility.PUBLIC, Visibility.CONNECTIONS, Visibility.PRIVATE, Visibility.UNLISTED,
    )
    notes: str = ""


# ---------------------------------------------------------------------------
# Verified limit tables
# ---------------------------------------------------------------------------

LINKEDIN = PlatformLimits(
    platform="linkedin",
    source=(
        "https://www.linkedin.com/help/linkedin/answer/a528176 ; "
        "https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api"
    ),
    text_max=3000,
    text_max_unit="characters",
    media_required=None,
    max_images=9,
    max_videos=1,
    allowed_visibilities=(Visibility.PUBLIC, Visibility.CONNECTIONS),
    notes="Text-only posts are valid; the 3000-character bound is the UGC Post text limit.",
)

TIKTOK = PlatformLimits(
    platform="tiktok",
    source=(
        "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post ; "
        "https://zernio.com/blog/tiktok-posting-api"
    ),
    text_max=2200,
    text_max_unit="utf16",
    media_required=MediaKind.VIDEO,
    max_images=0,
    max_videos=1,
    video_min_seconds=3.0,
    video_max_seconds=600.0,
    max_media_bytes=1 * 1024 * 1024 * 1024,
    allowed_visibilities=(Visibility.PUBLIC, Visibility.PRIVATE),
    notes="Caption bound is 2200 UTF-16 code units. A video is mandatory for direct post.",
)

YOUTUBE = PlatformLimits(
    platform="youtube",
    source=(
        "https://developers.google.com/youtube/v3/docs/videos ; "
        "https://typecount.com/blog/youtube-description-character-limit"
    ),
    text_max=5000,          # description
    text_max_unit="characters",
    title_max=100,
    title_required=True,
    media_required=MediaKind.VIDEO,
    max_images=0,
    max_videos=1,
    allowed_visibilities=(Visibility.PUBLIC, Visibility.UNLISTED, Visibility.PRIVATE),
    notes=(
        "Tag budget deliberately NOT enforced: the commonly quoted 500-character "
        "total could not be confirmed against a primary source, and an unverified "
        "bound is worse than none."
    ),
)

LIMITS: Mapping[str, PlatformLimits] = {
    LINKEDIN.platform: LINKEDIN,
    TIKTOK.platform: TIKTOK,
    YOUTUBE.platform: YOUTUBE,
}

SUPPORTED_PLATFORMS: tuple[str, ...] = tuple(sorted(LIMITS))


def limits_for(platform: str) -> Optional[PlatformLimits]:
    return LIMITS.get(str(platform or "").strip().lower())


# ---------------------------------------------------------------------------
# Generic validation driven by a PlatformLimits row
# ---------------------------------------------------------------------------


def _measure(text: str, unit: str) -> int:
    return utf16_length(text) if unit == "utf16" else len(text)


def _check_common(limits: PlatformLimits, content: PublicationContent) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    if content.is_empty:
        issues.append(ValidationIssue(
            "empty_content", "content",
            "Nothing to publish: text, title, and media are all empty.",
        ))

    if limits.text_max is not None:
        actual = _measure(content.text, limits.text_max_unit)
        if actual > limits.text_max:
            issues.append(ValidationIssue(
                "text_too_long", "text",
                "%s allows at most %d %s in the post text; this is %d."
                % (limits.platform, limits.text_max, limits.text_max_unit, actual),
                Severity.ERROR, float(limits.text_max), float(actual),
            ))

    if limits.title_max is not None:
        actual = len(content.title)
        if actual > limits.title_max:
            issues.append(ValidationIssue(
                "title_too_long", "title",
                "%s allows at most %d characters in the title; this is %d."
                % (limits.platform, limits.title_max, actual),
                Severity.ERROR, float(limits.title_max), float(actual),
            ))
    if limits.title_required and not content.title.strip():
        issues.append(ValidationIssue(
            "title_required", "title",
            "%s requires a title." % limits.platform,
        ))
    if not limits.title_required and content.title.strip():
        issues.append(ValidationIssue(
            "title_ignored", "title",
            "%s has no title field; the title will not be published. "
            "Fold it into the post text instead." % limits.platform,
            Severity.WARNING,
        ))

    images = content.images
    videos = content.videos

    if limits.max_images is not None and len(images) > limits.max_images:
        issues.append(ValidationIssue(
            "too_many_images", "media",
            "%s allows at most %d image(s); this post has %d."
            % (limits.platform, limits.max_images, len(images)),
            Severity.ERROR, float(limits.max_images), float(len(images)),
        ))
    if limits.max_videos is not None and len(videos) > limits.max_videos:
        issues.append(ValidationIssue(
            "too_many_videos", "media",
            "%s allows at most %d video(s); this post has %d."
            % (limits.platform, limits.max_videos, len(videos)),
            Severity.ERROR, float(limits.max_videos), float(len(videos)),
        ))

    if limits.media_required is MediaKind.VIDEO and not videos:
        issues.append(ValidationIssue(
            "video_required", "media",
            "%s requires a video; this post has none." % limits.platform,
        ))
    if limits.media_required is MediaKind.IMAGE and not images:
        issues.append(ValidationIssue(
            "image_required", "media",
            "%s requires an image; this post has none." % limits.platform,
        ))

    if limits.max_images == 0 and images:
        issues.append(ValidationIssue(
            "images_will_not_publish", "media",
            "%s publishes no images; the %d image(s) would be dropped."
            % (limits.platform, len(images)),
            Severity.WARNING,
        ))
    if limits.max_videos == 0 and videos:
        issues.append(ValidationIssue(
            "videos_will_not_publish", "media",
            "%s publishes no video; the %d video(s) would be dropped."
            % (limits.platform, len(videos)),
            Severity.WARNING,
        ))

    for index, video in enumerate(videos):
        if video.duration_s is None:
            issues.append(ValidationIssue(
                "video_duration_unknown", "media[%d].duration_s" % index,
                "Video duration is not declared, so the %s duration bounds "
                "cannot be verified." % limits.platform,
                Severity.WARNING,
            ))
            continue
        if limits.video_min_seconds is not None and video.duration_s < limits.video_min_seconds:
            issues.append(ValidationIssue(
                "video_too_short", "media[%d].duration_s" % index,
                "%s requires at least %.0f s of video; this is %.1f s."
                % (limits.platform, limits.video_min_seconds, video.duration_s),
                Severity.ERROR, limits.video_min_seconds, video.duration_s,
            ))
        if limits.video_max_seconds is not None and video.duration_s > limits.video_max_seconds:
            issues.append(ValidationIssue(
                "video_too_long", "media[%d].duration_s" % index,
                "%s allows at most %.0f s of video; this is %.1f s."
                % (limits.platform, limits.video_max_seconds, video.duration_s),
                Severity.ERROR, limits.video_max_seconds, video.duration_s,
            ))

    if limits.max_media_bytes is not None:
        for index, ref in enumerate(content.media):
            if ref.size_bytes and ref.size_bytes > limits.max_media_bytes:
                issues.append(ValidationIssue(
                    "media_too_large", "media[%d].size_bytes" % index,
                    "%s allows at most %d bytes per asset; this is %d."
                    % (limits.platform, limits.max_media_bytes, ref.size_bytes),
                    Severity.ERROR, float(limits.max_media_bytes), float(ref.size_bytes),
                ))

    if content.visibility not in limits.allowed_visibilities:
        issues.append(ValidationIssue(
            "visibility_unsupported", "visibility",
            "%s does not support visibility %r; choose one of %s."
            % (
                limits.platform,
                content.visibility.value,
                ", ".join(v.value for v in limits.allowed_visibilities),
            ),
        ))

    return issues


# ---------------------------------------------------------------------------
# Platform-specific rules that a shared table cannot express
# ---------------------------------------------------------------------------


def validate_linkedin(content: PublicationContent) -> ValidationResult:
    issues = _check_common(LINKEDIN, content)

    # LinkedIn renders a link preview from the first URL; a separately supplied
    # link_url alongside in-text URLs produces two competing previews.
    if content.link_url and "http" in content.text.lower():
        issues.append(ValidationIssue(
            "competing_link_previews", "link_url",
            "Both link_url and an in-text URL are present; LinkedIn will render "
            "only one preview. Remove one to control which appears.",
            Severity.WARNING,
        ))

    # The feed truncates around 210 characters behind "see more".
    if len(content.text) > 210 and not content.text.lstrip().startswith(("#", "http")):
        issues.append(ValidationIssue(
            "feed_truncation", "text",
            "LinkedIn truncates the feed view near 210 characters; put the hook "
            "first if the opening matters.",
            Severity.WARNING, 210.0, float(len(content.text)),
        ))

    return ValidationResult(LINKEDIN.platform, tuple(issues))


def validate_tiktok(content: PublicationContent) -> ValidationResult:
    issues = list(_check_common(TIKTOK, content))

    # TikTok is a vertical-first surface: 9:16 is 0.5625. Non-vertical video
    # still publishes but is letterboxed or cropped, which is worth flagging
    # rather than blocking.
    for index, video in enumerate(content.videos):
        ratio = video.aspect_ratio
        if ratio is None:
            issues.append(ValidationIssue(
                "video_aspect_unknown", "media[%d]" % index,
                "Video dimensions are not declared; TikTok expects 1080x1920 (9:16) "
                "and cannot be checked without them.",
                Severity.WARNING,
            ))
            continue
        if abs(ratio - (9 / 16)) > 0.02:
            issues.append(ValidationIssue(
                "video_not_vertical", "media[%d]" % index,
                "TikTok's recommended ratio is 9:16 (0.5625); this video is %.3f, "
                "so it will be letterboxed or cropped." % ratio,
                Severity.WARNING, 9 / 16, ratio,
            ))

    # A caption with no text at all is legal but forfeits all discovery.
    if not content.text.strip():
        issues.append(ValidationIssue(
            "caption_empty", "text",
            "The caption is empty. TikTok allows this, but the post gets no "
            "searchable text or hashtags.",
            Severity.WARNING,
        ))

    return ValidationResult(TIKTOK.platform, tuple(issues))


def validate_youtube(content: PublicationContent) -> ValidationResult:
    issues = list(_check_common(YOUTUBE, content))

    # YouTube treats a vertical video of <= 180 s as a Short. This is advisory:
    # classification is YouTube's decision, not ours.
    for index, video in enumerate(content.videos):
        ratio = video.aspect_ratio
        duration = video.duration_s
        if ratio is not None and duration is not None:
            vertical = ratio < 1.0
            if vertical and duration <= 180.0:
                issues.append(ValidationIssue(
                    "likely_shorts", "media[%d]" % index,
                    "Vertical video of %.0f s is likely to be classified as a Short."
                    % duration,
                    Severity.WARNING,
                ))
            elif vertical and duration > 180.0:
                issues.append(ValidationIssue(
                    "vertical_long_form", "media[%d]" % index,
                    "Vertical video of %.0f s exceeds the Shorts window; it will "
                    "publish as a regular video, where vertical framing is often "
                    "cropped in the player." % duration,
                    Severity.WARNING,
                ))

    # The title is the single strongest ranking signal; an empty-ish title
    # wastes it. Enforced separately from title_required so the message can say
    # why rather than just "required".
    if content.title.strip() and len(content.title.strip()) < 10:
        issues.append(ValidationIssue(
            "title_very_short", "title",
            "The title is only %d characters; YouTube surfaces it prominently in "
            "search and recommendations." % len(content.title.strip()),
            Severity.WARNING, 10.0, float(len(content.title.strip())),
        ))

    return ValidationResult(YOUTUBE.platform, tuple(issues))


_VALIDATORS = {
    LINKEDIN.platform: validate_linkedin,
    TIKTOK.platform: validate_tiktok,
    YOUTUBE.platform: validate_youtube,
}


def validate(platform: str, content: PublicationContent) -> ValidationResult:
    """Validate *content* for *platform*.

    Three cases, in this order:

    1. A platform with a bespoke validator runs it (LinkedIn / TikTok / YouTube).
    2. A platform that has a :class:`PlatformLimits` row but no bespoke rules
       runs the shared generic checks. This is what makes adding a platform a
       data change rather than a code change, and it keeps a newly declared
       platform from silently skipping every check.
    3. An unknown platform is an ERROR rather than a pass: accepting content for
       a platform whose rules are unknown would make the validator decorative.
    """
    key = str(platform or "").strip().lower()
    validator = _VALIDATORS.get(key)
    if validator is not None:
        return validator(content)

    limits = LIMITS.get(key)
    if limits is not None:
        return ValidationResult(key, tuple(_check_common(limits, content)))

    return ValidationResult(key or "(none)", (
        ValidationIssue(
            "unsupported_platform", "platform",
            "No content rules are defined for platform %r; supported: %s."
            % (platform, ", ".join(SUPPORTED_PLATFORMS)),
        ),
    ))
