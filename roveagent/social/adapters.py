"""Platform adapter INTERFACE — no real platform is called in this build.

Why the adapters are interfaces only
------------------------------------

Publishing to LinkedIn, TikTok, or YouTube requires a registered developer
application, an OAuth grant per publishing account, and (for TikTok and
YouTube) an app review that a third party cannot shortcut. Writing the call
sites without those credentials would produce code that cannot be executed even
once — and an untestable integration is worse than an honest absence, because
it looks finished.

So this module fixes the CONTRACT and stops there:

  * ``PlatformAdapter`` declares what a real integration must provide.
  * ``prepare()`` is implemented and pure — it is fully testable and is where
    most of the platform-specific judgement lives (media selection, text
    folding, capability negotiation).
  * ``publish()`` raises ``AdapterNotImplemented``. There is no fallback, no
    stub response, and no simulated success.

The gateway's happy path is proven in tests with an injected in-memory adapter,
so the *infrastructure* is verified end to end; only the vendor calls are
absent. That distinction is deliberate and is restated in the report.

Adding a real adapter later must not require touching the gateway, the
validators, or the approval layer: implement this interface, register it, and
the existing governance applies unchanged.
"""

from __future__ import annotations

import dataclasses
from abc import ABC, abstractmethod
from enum import Enum
from typing import Any, Iterable, Mapping, Optional

from roveagent.social.content import (
    MediaKind,
    MediaRef,
    PublicationContent,
    content_hash,
)
from roveagent.social.validators import (
    PlatformLimits,
    ValidationResult,
    limits_for,
    validate,
)

__all__ = [
    "AdapterCapability",
    "AdapterNotImplemented",
    "PreparedPublication",
    "PublishReceipt",
    "PlatformAdapter",
    "LinkedInAdapter",
    "TikTokAdapter",
    "YouTubeAdapter",
    "AdapterRegistry",
    "default_registry",
]


class AdapterCapability(str, Enum):
    """What an adapter can actually do, declared rather than assumed.

    The gateway consults this instead of guessing from the platform name, so an
    adapter that cannot schedule cannot be handed a scheduled post by mistake.
    """

    PUBLISH_NOW = "publish_now"
    SCHEDULE = "schedule"
    TEXT_ONLY = "text_only"
    IMAGE = "image"
    VIDEO = "video"
    CAROUSEL = "carousel"
    NATIVE_SCHEDULING = "native_scheduling"


class AdapterNotImplemented(NotImplementedError):
    """Raised by every real-platform ``publish()`` in this build.

    Subclasses ``NotImplementedError`` so an accidental call is loud rather than
    silently swallowed by a broad ``except Exception``, while still being
    catchable specifically when a caller wants to report "publishing is not
    wired up" instead of crashing.
    """


@dataclasses.dataclass(frozen=True)
class PreparedPublication:
    """The adapter's final, platform-shaped payload — still local, never sent.

    Held separately from ``PublicationContent`` because preparation is where
    platform rules change the payload (dropping media the platform ignores,
    folding a title into the body). The ``content_hash`` is re-derived after
    preparation so a caller can see whether preparation altered what was
    approved.
    """

    platform: str
    content: PublicationContent
    content_hash: str
    warnings: tuple[str, ...] = ()
    dropped: tuple[str, ...] = ()

    @property
    def changed_by_preparation(self) -> bool:
        return bool(self.dropped)


@dataclasses.dataclass(frozen=True)
class PublishReceipt:
    """What a successful publish returns. Only a real adapter can produce one."""

    platform: str
    remote_id: str
    remote_url: str = ""
    published_at: float = 0.0
    content_hash: str = ""
    raw: Mapping[str, Any] = dataclasses.field(default_factory=dict)


class PlatformAdapter(ABC):
    """Contract every social platform integration must satisfy.

    Subclasses MUST NOT perform network I/O in ``validate`` or ``prepare``; both
    are called on paths where no approval has been granted yet, and a network
    call there would leak content before it is authorised.
    """

    #: Stable lowercase key, matching ``validators.limits_for``.
    platform: str = ""

    #: Human-readable statement of what a real integration needs. Overridden per
    #: platform so the "not implemented" error can be specific and actionable
    #: rather than a generic refusal.
    publish_requirements: str = (
        "a registered developer application, a per-account OAuth grant, and a "
        "real HTTP client"
    )

    @property
    def limits(self) -> Optional[PlatformLimits]:
        return limits_for(self.platform)

    @abstractmethod
    def capabilities(self) -> frozenset[AdapterCapability]:
        """Declare supported operations. Never inferred from the platform name."""

    def validate(self, content: PublicationContent) -> ValidationResult:
        """Pure, local content check. Delegates to the shared validator table."""
        return validate(self.platform, content)

    def prepare(self, content: PublicationContent) -> PreparedPublication:
        """Shape *content* for this platform. Pure; never performs I/O.

        The default implementation drops media the platform ignores and records
        that it did so. Adapters override to add platform-specific folding.
        """
        limits = self.limits
        kept: list[MediaRef] = []
        dropped: list[str] = []
        warnings: list[str] = []

        for ref in content.media:
            if limits is not None:
                if ref.kind is MediaKind.IMAGE and limits.max_images == 0:
                    dropped.append("image %s (platform publishes no images)" % ref.sha256[:12])
                    continue
                if ref.kind is MediaKind.VIDEO and limits.max_videos == 0:
                    dropped.append("video %s (platform publishes no video)" % ref.sha256[:12])
                    continue
            kept.append(ref)

        prepared_content = content.with_media(*kept) if len(kept) != len(content.media) else content
        if dropped:
            warnings.append(
                "%d media item(s) dropped for %s during preparation."
                % (len(dropped), self.platform)
            )

        return PreparedPublication(
            platform=self.platform,
            content=prepared_content,
            content_hash=content_hash(self.platform, prepared_content),
            warnings=tuple(warnings),
            dropped=tuple(dropped),
        )

    def publish(
        self, prepared: PreparedPublication, *, authorization: Mapping[str, Any],
    ) -> PublishReceipt:
        """Send the publication.

        This base implementation is the ONLY one in this build, and it always
        raises. A real integration overrides it — and that override is exactly
        what ``AdapterRegistry.implemented()`` detects by introspection, so the
        "can this platform publish?" answer cannot drift from the code.

        ``authorization`` carries the credential material a real integration
        needs. It is passed explicitly rather than read from ambient environment
        state so that the gateway stays the only component deciding whether a
        publish may proceed.
        """
        raise AdapterNotImplemented(
            "%s publishing is not implemented in this build. It requires %s. "
            "Content was validated and the approval path was exercised; nothing "
            "was sent." % (self.platform, self.publish_requirements)
        )


# ---------------------------------------------------------------------------
# Concrete adapters. They declare capabilities and requirements; NONE of them
# overrides publish(), so all three report as unimplemented by introspection.
# ---------------------------------------------------------------------------


class LinkedInAdapter(PlatformAdapter):
    platform = "linkedin"
    publish_requirements = (
        "a registered LinkedIn app, the w_member_social (or organization) scope, "
        "and a per-account OAuth grant"
    )

    def capabilities(self) -> frozenset[AdapterCapability]:
        return frozenset({
            AdapterCapability.PUBLISH_NOW,
            AdapterCapability.TEXT_ONLY,
            AdapterCapability.IMAGE,
            AdapterCapability.VIDEO,
        })


class TikTokAdapter(PlatformAdapter):
    platform = "tiktok"
    publish_requirements = (
        "an approved TikTok developer app carrying the Content Posting API "
        "product, plus a per-account OAuth grant with the video.publish scope"
    )

    def capabilities(self) -> frozenset[AdapterCapability]:
        return frozenset({
            AdapterCapability.PUBLISH_NOW,
            AdapterCapability.VIDEO,
        })


class YouTubeAdapter(PlatformAdapter):
    platform = "youtube"
    publish_requirements = (
        "an OAuth client with the youtube.upload scope and a videos.insert quota "
        "allocation"
    )

    def capabilities(self) -> frozenset[AdapterCapability]:
        return frozenset({
            AdapterCapability.PUBLISH_NOW,
            AdapterCapability.VIDEO,
        })


class AdapterRegistry:
    """Maps platform keys to adapters.

    Registration is explicit. There is no dynamic import and no plugin
    auto-discovery here: an adapter that can publish must be added by a
    deliberate code change, which keeps the set of things able to post
    auditable from the source tree alone.
    """

    def __init__(self, adapters: Iterable[PlatformAdapter] = ()) -> None:
        self._adapters: dict[str, PlatformAdapter] = {}
        for adapter in adapters:
            self.register(adapter)

    def register(self, adapter: PlatformAdapter, *, replace: bool = False) -> None:
        key = str(getattr(adapter, "platform", "") or "").strip().lower()
        if not key:
            raise ValueError("adapter.platform must be a non-empty string")
        if key in self._adapters and not replace:
            raise ValueError("an adapter for %r is already registered" % key)
        self._adapters[key] = adapter

    def get(self, platform: str) -> Optional[PlatformAdapter]:
        return self._adapters.get(str(platform or "").strip().lower())

    def platforms(self) -> tuple[str, ...]:
        return tuple(sorted(self._adapters))

    def implemented(self) -> tuple[str, ...]:
        """Platforms whose ``publish`` is a real integration.

        Determined by introspection rather than a hand-maintained flag, so the
        answer cannot drift from the code: an adapter that does not override
        ``PlatformAdapter.publish`` inherits the raising default and therefore
        reports as NOT implemented, automatically.
        """
        return tuple(
            key for key, adapter in sorted(self._adapters.items())
            if type(adapter).publish is not PlatformAdapter.publish
        )

    def unimplemented(self) -> tuple[str, ...]:
        return tuple(p for p in self.platforms() if p not in self.implemented())

    def describe(self) -> list[dict[str, Any]]:
        rows = []
        for key in self.platforms():
            adapter = self._adapters[key]
            limits = adapter.limits
            rows.append({
                "platform": key,
                "implemented": key in self.implemented(),
                "capabilities": sorted(c.value for c in adapter.capabilities()),
                "limits_source": getattr(limits, "source", ""),
                "limits_retrieved": getattr(limits, "retrieved", ""),
            })
        return rows


def default_registry() -> AdapterRegistry:
    """The three declared adapters, none of which can publish yet."""
    return AdapterRegistry([LinkedInAdapter(), TikTokAdapter(), YouTubeAdapter()])
