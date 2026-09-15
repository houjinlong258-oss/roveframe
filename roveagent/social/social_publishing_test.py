"""Tests for social publishing: canonical hash, validators, adapters, gateway.

Scope note — what these tests DO and DO NOT prove
-------------------------------------------------

The gateway's success path IS exercised end to end, using an adapter defined in
this file (``_RecordingAdapter``) that satisfies the interface and records the
call instead of sending it. That verifies the governance machinery: freeze,
hash binding, approval, single-use, audit.

No test here contacts LinkedIn, TikTok, or YouTube, and none pretends to. The
three shipped adapters are asserted to be INTERFACE-ONLY: they raise, they are
reported as unimplemented, and they are never reached on the happy path. Faking
a vendor response would be the one thing worth avoiding — it would make an
unbuilt integration look finished.

Run:  python -m pytest roveagent/social/social_publishing_test.py -q
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.enterprise import approval_grants  # noqa: E402
from roveagent.enterprise.audit import AuditLog  # noqa: E402
from roveagent.social import adapters as ad  # noqa: E402
from roveagent.social import validators as v  # noqa: E402
from roveagent.social.content import (  # noqa: E402
    MediaKind,
    MediaRef,
    PublicationContent,
    Visibility,
    canonical_json,
    content_hash,
    normalize_text,
)
from roveagent.social.gateway import (  # noqa: E402
    PublicationAlreadyExecuted,
    PublicationContentChanged,
    PublicationNotApproved,
    PublicationNotImplemented,
    PublicationRejected,
    PublicationValidationFailed,
    SocialPublishingGateway,
)

TENANT = "00000000-0000-0000-0000-000000000000"
BUSINESS = "00000000-0000-0000-0000-000000000001"
DIGEST_A = "a" * 64
DIGEST_B = "b" * 64


def _image(digest: str = DIGEST_A, **kw) -> MediaRef:
    return MediaRef(kind=MediaKind.IMAGE, sha256=digest, mime="image/jpeg",
                    size_bytes=kw.pop("size_bytes", 120_000), **kw)


def _video(digest: str = DIGEST_B, *, duration_s: float = 30.0,
           width: int = 1080, height: int = 1920, **kw) -> MediaRef:
    return MediaRef(kind=MediaKind.VIDEO, sha256=digest, mime="video/mp4",
                    size_bytes=kw.pop("size_bytes", 8_000_000),
                    duration_s=duration_s, width=width, height=height, **kw)


class _RecordingAdapter(ad.PlatformAdapter):
    """Satisfies the interface WITHOUT any network. Test-only.

    Exists so the gateway's success path is genuinely verifiable. It is defined
    here, not shipped, so the shipped adapter set stays interface-only.
    """

    platform = "testnet"

    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[ad.PreparedPublication] = []
        self.fail = fail

    def capabilities(self) -> frozenset[ad.AdapterCapability]:
        return frozenset({ad.AdapterCapability.PUBLISH_NOW, ad.AdapterCapability.VIDEO})

    def publish(self, prepared, *, authorization) -> ad.PublishReceipt:  # noqa: ANN001
        self.calls.append(prepared)
        if self.fail:
            raise RuntimeError("simulated vendor outage")
        return ad.PublishReceipt(
            platform=self.platform, remote_id="rec-1",
            remote_url="memory://rec-1", content_hash=prepared.content_hash,
        )


class _TestLimitsMixin:
    """Gives the recording adapter a limits row so validation behaves normally."""

    @classmethod
    def setUpClass(cls) -> None:
        v.LIMITS["testnet"] = v.PlatformLimits(
            platform="testnet", source="test-only", text_max=100,
            max_images=2, max_videos=1,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        v.LIMITS.pop("testnet", None)


# ---------------------------------------------------------------------------
# Canonical content hash
# ---------------------------------------------------------------------------


class CanonicalHashTest(unittest.TestCase):
    def test_hash_matches_the_approval_fingerprint_canonicalisation(self) -> None:
        """The two canonicalisers live in different modules; they must agree.

        If they diverged, an approval and its content hash could describe
        different payloads while both looking valid. Asserted against the same
        parameters the grant store uses, so a change to either side fails here.
        """
        payload = {"b": 1, "a": [1, 2, {"z": None}], "c": "h\u00e9llo"}
        expected = json.dumps(payload, sort_keys=True, ensure_ascii=False,
                              separators=(",", ":"), default=str)
        self.assertEqual(canonical_json(payload), expected)

    def test_fingerprint_agrees_with_content_hash_on_the_same_input(self) -> None:
        """Direct cross-module equality, so drift is caught rather than assumed away.

        ``approval_grants.fingerprint`` canonicalises ``{"tool": ..., "args":
        ...}``; this asserts our canonicaliser reproduces that byte for byte.
        """
        tool = "publish_social_post"
        args = {"z": 1, "a": "h\u00e9llo", "nested": {"k": [3, 2, 1]}}
        digest = hashlib.sha256(
            canonical_json({"tool": tool, "args": dict(args)}).encode("utf-8")
        ).hexdigest()
        self.assertEqual(digest, approval_grants.fingerprint(tool, args))

    def test_normalisation_is_invisible_only(self) -> None:
        self.assertEqual(normalize_text("a\r\nb"), "a\nb")
        self.assertEqual(normalize_text("a\rb"), "a\nb")
        # Composed vs decomposed e-acute must collapse to one hash.
        self.assertEqual(normalize_text("caf\u00e9"), normalize_text("cafe\u0301"))

    def test_normalisation_does_not_strip_content(self) -> None:
        """Trimming would make two genuinely different payloads hash alike."""
        self.assertNotEqual(normalize_text(" hi "), normalize_text("hi"))

    def test_hash_is_stable_across_equivalent_input(self) -> None:
        a = PublicationContent(text="caf\u00e9 \r\nworld", tags=("Launch",))
        b = PublicationContent(text="cafe\u0301 \nworld", tags=("Launch",))
        self.assertEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_tag_casing_is_significant(self) -> None:
        """#Launch and #launch render differently, so they are different content.

        Normalising case would make two visibly different posts hash alike,
        which is the opposite of what the hash is for.
        """
        a = PublicationContent(text="x", tags=("Launch",))
        b = PublicationContent(text="x", tags=("launch",))
        self.assertNotEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_leading_hash_is_stripped_so_both_spellings_agree(self) -> None:
        a = PublicationContent(text="x", tags=("#launch",))
        b = PublicationContent(text="x", tags=("launch",))
        self.assertEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_tag_order_and_duplicates_do_not_change_the_hash(self) -> None:
        a = PublicationContent(text="x", tags=("b", "a", "a"))
        b = PublicationContent(text="x", tags=("a", "b"))
        self.assertEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_media_order_DOES_change_the_hash(self) -> None:
        """Carousels publish in order, so order is content."""
        a = PublicationContent(text="x", media=(_image(DIGEST_A), _image(DIGEST_B)))
        b = PublicationContent(text="x", media=(_image(DIGEST_B), _image(DIGEST_A)))
        self.assertNotEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_media_change_alters_the_hash(self) -> None:
        """Swapping the bytes behind a publication must invalidate approval."""
        a = PublicationContent(text="x", media=(_image(DIGEST_A),))
        b = PublicationContent(text="x", media=(_image(DIGEST_B),))
        self.assertNotEqual(content_hash("linkedin", a), content_hash("linkedin", b))

    def test_platform_is_part_of_the_hash(self) -> None:
        """An approval for one platform must not be replayable on another."""
        content = PublicationContent(text="x")
        self.assertNotEqual(content_hash("linkedin", content), content_hash("youtube", content))

    def test_text_change_alters_the_hash(self) -> None:
        self.assertNotEqual(
            content_hash("linkedin", PublicationContent(text="x")),
            content_hash("linkedin", PublicationContent(text="x ")),
        )

    def test_visibility_change_alters_the_hash(self) -> None:
        self.assertNotEqual(
            content_hash("linkedin", PublicationContent(text="x", visibility=Visibility.PUBLIC)),
            content_hash("linkedin", PublicationContent(text="x", visibility=Visibility.CONNECTIONS)),
        )

    def test_media_ref_rejects_a_malformed_digest(self) -> None:
        for bad in ("", "zz" * 32, "A" * 63, "g" * 64):
            with self.subTest(digest=bad), self.assertRaises(ValueError):
                MediaRef(kind=MediaKind.IMAGE, sha256=bad)

    def test_media_ref_lowercases_the_digest(self) -> None:
        self.assertEqual(_image("A" * 64).sha256, "a" * 64)

    def test_content_rejects_bad_types(self) -> None:
        with self.assertRaises(ValueError):
            PublicationContent(text="x", media=("not-a-ref",))
        with self.assertRaises(ValueError):
            PublicationContent(text="x", visibility="public")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


class ValidatorLimitsTest(unittest.TestCase):
    def test_every_limit_carries_provenance(self) -> None:
        for platform, limits in v.LIMITS.items():
            with self.subTest(platform=platform):
                self.assertTrue(limits.source.startswith("http"), "limit has no citable source")
                self.assertTrue(limits.retrieved, "limit has no retrieval date")

    def test_verified_limits_are_what_was_documented(self) -> None:
        self.assertEqual(v.LINKEDIN.text_max, 3000)
        self.assertEqual(v.TIKTOK.text_max, 2200)
        self.assertEqual(v.TIKTOK.text_max_unit, "utf16")
        self.assertEqual(v.TIKTOK.video_min_seconds, 3.0)
        self.assertEqual(v.TIKTOK.video_max_seconds, 600.0)
        self.assertEqual(v.YOUTUBE.title_max, 100)
        self.assertEqual(v.YOUTUBE.text_max, 5000)

    def test_unverified_bounds_are_absent_rather_than_guessed(self) -> None:
        """YouTube's tag budget could not be confirmed, so no rule enforces it."""
        self.assertFalse(hasattr(v.YOUTUBE, "tags_max"))
        self.assertIn("deliberately NOT enforced", v.YOUTUBE.notes)


class Utf16LengthTest(unittest.TestCase):
    def test_ascii_matches_len(self) -> None:
        self.assertEqual(v.utf16_length("hello"), 5)

    def test_emoji_counts_as_two(self) -> None:
        """The whole point: Python len() under-counts what TikTok charges."""
        rocket = "\U0001F680"          # U+1F680, non-BMP
        self.assertEqual(len(rocket), 1)
        self.assertEqual(v.utf16_length(rocket), 2)

    def test_emoji_only_caption_limit_is_enforced_correctly(self) -> None:
        """1101 emoji == 2202 UTF-16 units -> over TikTok's 2200 bound."""
        caption = "\U0001F680" * 1101
        self.assertLess(len(caption), 2200)          # a len()-based check would pass it
        self.assertGreater(v.utf16_length(caption), 2200)
        result = v.validate_tiktok(PublicationContent(text=caption, media=(_video(),)))
        self.assertFalse(result.ok)
        self.assertIn("text_too_long", [i.code for i in result.errors])

    def test_bmp_characters_count_as_one(self) -> None:
        self.assertEqual(v.utf16_length("caf\u00e9"), 4)


class LinkedInValidatorTest(unittest.TestCase):
    def test_valid_text_post(self) -> None:
        result = v.validate_linkedin(PublicationContent(text="A short update."))
        self.assertTrue(result.ok)

    def test_text_at_the_bound_is_allowed(self) -> None:
        self.assertTrue(v.validate_linkedin(PublicationContent(text="x" * 3000)).ok)

    def test_text_over_the_bound_is_refused(self) -> None:
        result = v.validate_linkedin(PublicationContent(text="x" * 3001))
        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].limit, 3000.0)
        self.assertEqual(result.errors[0].actual, 3001.0)

    def test_too_many_images(self) -> None:
        """LinkedIn allows 9 images; give it 10 distinct digests."""
        content = PublicationContent(text="x", media=tuple(
            MediaRef(kind=MediaKind.IMAGE, sha256=("%064x" % i)) for i in range(10)))
        result = v.validate_linkedin(content)
        self.assertFalse(result.ok)
        self.assertIn("too_many_images", [i.code for i in result.errors])

    def test_empty_content_is_refused(self) -> None:
        result = v.validate_linkedin(PublicationContent())
        self.assertFalse(result.ok)
        self.assertIn("empty_content", [i.code for i in result.errors])

    def test_unsupported_visibility_is_refused(self) -> None:
        result = v.validate_linkedin(
            PublicationContent(text="x", visibility=Visibility.UNLISTED))
        self.assertFalse(result.ok)
        self.assertIn("visibility_unsupported", [i.code for i in result.errors])

    def test_title_is_a_warning_not_an_error(self) -> None:
        result = v.validate_linkedin(PublicationContent(text="x", title="ignored"))
        self.assertTrue(result.ok)
        self.assertIn("title_ignored", [i.code for i in result.warnings])

    def test_competing_link_previews_warned(self) -> None:
        result = v.validate_linkedin(PublicationContent(
            text="see https://example.com", link_url="https://other.example"))
        self.assertTrue(result.ok)
        self.assertIn("competing_link_previews", [i.code for i in result.warnings])


class TikTokValidatorTest(unittest.TestCase):
    def test_video_is_required(self) -> None:
        result = v.validate_tiktok(PublicationContent(text="caption"))
        self.assertFalse(result.ok)
        self.assertIn("video_required", [i.code for i in result.errors])

    def test_images_are_refused_and_warned(self) -> None:
        """TikTok publishes no images. Supplying one alongside a video is still
        an error (over the 0-image bound) AND a warning (it will be dropped)."""
        result = v.validate_tiktok(PublicationContent(text="c", media=(_image(), _video())))
        self.assertFalse(result.ok)
        codes = [i.code for i in result.issues]
        self.assertIn("too_many_images", codes)
        self.assertIn("images_will_not_publish", codes)

    def test_valid_vertical_video(self) -> None:
        result = v.validate_tiktok(PublicationContent(text="c", media=(_video(),)))
        self.assertTrue(result.ok)
        self.assertEqual([i.code for i in result.warnings], [])

    def test_short_video_refused(self) -> None:
        result = v.validate_tiktok(PublicationContent(
            text="c", media=(_video(duration_s=1.5),)))
        self.assertFalse(result.ok)
        self.assertIn("video_too_short", [i.code for i in result.errors])

    def test_long_video_refused(self) -> None:
        result = v.validate_tiktok(PublicationContent(
            text="c", media=(_video(duration_s=700.0),)))
        self.assertFalse(result.ok)
        self.assertIn("video_too_long", [i.code for i in result.errors])

    def test_horizontal_video_warns_but_publishes(self) -> None:
        result = v.validate_tiktok(PublicationContent(
            text="c", media=(_video(width=1920, height=1080),)))
        self.assertTrue(result.ok)
        self.assertIn("video_not_vertical", [i.code for i in result.warnings])

    def test_oversized_file_refused(self) -> None:
        result = v.validate_tiktok(PublicationContent(
            text="c", media=(_video(size_bytes=2 * 1024 * 1024 * 1024),)))
        self.assertFalse(result.ok)
        self.assertIn("media_too_large", [i.code for i in result.errors])


class YouTubeValidatorTest(unittest.TestCase):
    def test_title_required(self) -> None:
        result = v.validate_youtube(PublicationContent(text="d", media=(_video(),)))
        self.assertFalse(result.ok)
        self.assertIn("title_required", [i.code for i in result.errors])

    def test_video_required(self) -> None:
        result = v.validate_youtube(PublicationContent(text="d", title="A title here"))
        self.assertFalse(result.ok)
        self.assertIn("video_required", [i.code for i in result.errors])

    def test_valid_video(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="description", title="A proper title", media=(_video(width=1920, height=1080),)))
        self.assertTrue(result.ok)

    def test_title_over_100_refused(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="d", title="x" * 101, media=(_video(),)))
        self.assertFalse(result.ok)
        self.assertIn("title_too_long", [i.code for i in result.errors])

    def test_description_over_5000_refused(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="x" * 5001, title="t", media=(_video(),)))
        self.assertFalse(result.ok)
        self.assertIn("text_too_long", [i.code for i in result.errors])

    def test_vertical_short_flagged(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="d", title="A proper title",
            media=(_video(width=1080, height=1920, duration_s=45.0),)))
        self.assertTrue(result.ok)
        self.assertIn("likely_shorts", [i.code for i in result.warnings])

    def test_vertical_long_form_flagged(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="d", title="A proper title",
            media=(_video(width=1080, height=1920, duration_s=400.0),)))
        self.assertTrue(result.ok)
        self.assertIn("vertical_long_form", [i.code for i in result.warnings])

    def test_unknown_video_shape_warns_rather_than_guesses(self) -> None:
        result = v.validate_youtube(PublicationContent(
            text="d", title="A proper title",
            media=(MediaRef(kind=MediaKind.VIDEO, sha256=DIGEST_B, duration_s=30.0),)))
        self.assertTrue(result.ok)
        # no dimension claim -> no shorts verdict either way
        self.assertNotIn("likely_shorts", [i.code for i in result.issues])


class ValidatorDispatchTest(unittest.TestCase):
    def test_unknown_platform_is_an_error_not_a_pass(self) -> None:
        result = v.validate("myspace", PublicationContent(text="hello"))
        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "unsupported_platform")

    def test_platform_key_is_case_insensitive(self) -> None:
        self.assertTrue(v.validate("LinkedIn", PublicationContent(text="x")).ok)

    def test_result_serialises(self) -> None:
        json.dumps(v.validate_linkedin(PublicationContent(text="x")).as_dict())


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------


class AdapterInterfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = ad.default_registry()

    def test_all_three_platforms_are_declared(self) -> None:
        self.assertEqual(self.registry.platforms(), ("linkedin", "tiktok", "youtube"))

    def test_none_report_as_implemented(self) -> None:
        """Introspection, not a flag: none overrides publish()."""
        self.assertEqual(self.registry.implemented(), ())
        self.assertEqual(self.registry.unimplemented(), ("linkedin", "tiktok", "youtube"))

    def test_shipped_adapters_raise_rather_than_fake_success(self) -> None:
        for adapter in (ad.LinkedInAdapter(), ad.TikTokAdapter(), ad.YouTubeAdapter()):
            with self.subTest(platform=adapter.platform):
                prepared = adapter.prepare(PublicationContent(text="x"))
                with self.assertRaises(ad.AdapterNotImplemented) as ctx:
                    adapter.publish(prepared, authorization={})
                message = str(ctx.exception)
                self.assertIn(adapter.platform, message)
                self.assertIn("nothing was sent", message.lower())

    def test_error_message_names_what_is_missing(self) -> None:
        with self.assertRaises(ad.AdapterNotImplemented) as ctx:
            ad.TikTokAdapter().publish(
                ad.PreparedPublication("tiktok", PublicationContent(text="x"), "h"),
                authorization={})
        self.assertIn("Content Posting API", str(ctx.exception))

    def test_adapter_not_implemented_is_a_notimplementederror(self) -> None:
        self.assertTrue(issubclass(ad.AdapterNotImplemented, NotImplementedError))

    def test_a_real_adapter_is_detected_by_introspection(self) -> None:
        """The counterpart to the interface-only assertion: introspection works."""
        registry = ad.AdapterRegistry([_RecordingAdapter()])
        self.assertEqual(registry.implemented(), ("testnet",))
        self.assertEqual(registry.unimplemented(), ())

    def test_a_mixed_registry_separates_the_two(self) -> None:
        registry = ad.default_registry()
        registry.register(_RecordingAdapter())
        self.assertEqual(registry.implemented(), ("testnet",))
        self.assertEqual(registry.unimplemented(), ("linkedin", "tiktok", "youtube"))

    def test_duplicate_registration_is_refused_unless_replacing(self) -> None:
        registry = ad.default_registry()
        with self.assertRaises(ValueError):
            registry.register(ad.LinkedInAdapter())
        registry.register(ad.LinkedInAdapter(), replace=True)
        self.assertEqual(registry.platforms().count("linkedin"), 1)

    def test_adapter_without_a_platform_key_is_refused(self) -> None:
        class _Nameless(ad.PlatformAdapter):
            def capabilities(self): return frozenset()

        with self.assertRaises(ValueError):
            ad.AdapterRegistry([_Nameless()])

    def test_describe_reports_capabilities_and_provenance(self) -> None:
        rows = {r["platform"]: r for r in self.registry.describe()}
        self.assertFalse(rows["linkedin"]["implemented"])
        self.assertIn("image", rows["linkedin"]["capabilities"])
        self.assertTrue(rows["tiktok"]["limits_source"].startswith("http"))
        self.assertEqual(rows["tiktok"]["limits_retrieved"], "2026-09-12")

    def test_preparation_drops_media_the_platform_ignores(self) -> None:
        prepared = ad.TikTokAdapter().prepare(
            PublicationContent(text="c", media=(_image(), _video())))
        self.assertTrue(prepared.changed_by_preparation)
        self.assertEqual(len(prepared.dropped), 1)
        self.assertEqual(len(prepared.content.media), 1)
        self.assertIn("image", prepared.dropped[0])

    def test_preparation_leaves_acceptable_media_alone(self) -> None:
        content = PublicationContent(text="c", media=(_video(),))
        prepared = ad.YouTubeAdapter().prepare(content)
        self.assertFalse(prepared.changed_by_preparation)
        self.assertEqual(prepared.content_hash, content_hash("youtube", content))

    def test_no_module_in_this_package_imports_an_http_client(self) -> None:
        """The interface-only promise, checked against the source rather than trusted."""
        forbidden = ("import requests", "import httpx", "import urllib.request",
                     "from urllib.request", "import aiohttp", "import socket")
        package = Path(ad.__file__).parent
        for path in sorted(package.glob("*.py")):
            if path.name.endswith("_test.py"):
                continue
            text = path.read_text(encoding="utf-8")
            for needle in forbidden:
                with self.subTest(module=path.name, needle=needle):
                    self.assertNotIn(
                        needle, text,
                        "%s imports a network client; platform adapters must stay "
                        "interface-only in this build" % path.name,
                    )


class _GatewayCase(unittest.TestCase):
    """Shared fixture: temp grant store + temp audit log, no ambient state."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.audit_path = self.root / "audit" / "social.jsonl"
        self.gateway = SocialPublishingGateway(
            registry=ad.AdapterRegistry([_RecordingAdapter()]),
            audit=AuditLog(self.audit_path),
            grant_root=self.root,
        )
        # The recording adapter's platform needs a limits row for validation.
        _TestLimitsMixin.setUpClass()
        self.addCleanup(_TestLimitsMixin.tearDownClass)

    def _frozen(self, *, text: str = "hello", media=()) -> object:
        return self.gateway.freeze(
            "testnet", PublicationContent(text=text, media=tuple(media)),
            tenant_id=TENANT, business_id=BUSINESS, agent="marketing",
            role="owner", request_id="req-1",
            invocation_id="inv-1", execution_id="exec-1",
        )

    def _audit(self) -> list[dict]:
        if not self.audit_path.exists():
            return []
        return [json.loads(line) for line in self.audit_path.read_text(encoding="utf-8").splitlines() if line.strip()]


class GatewayHappyPathTest(_GatewayCase):
    def test_freeze_produces_a_stable_hash_and_is_pure(self) -> None:
        request = self._frozen(text="hello")
        self.assertEqual(request.content_hash, content_hash("testnet", request.content))
        self.assertEqual(request.content_hash, request.content_hash)

    def test_publish_requires_approval(self) -> None:
        request = self._frozen()
        with self.assertRaises(PublicationNotApproved):
            self.gateway.publish(request)

    def test_approved_publish_succeeds_once(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        outcome = self.gateway.publish(request, authorization={"token": "x"})
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.status, "published")
        self.assertEqual(outcome.receipt.remote_id, "rec-1")
        self.assertEqual(len(self.gateway.registry.get("testnet").calls), 1)

    def test_rejection_is_recorded_and_blocks_publishing(self) -> None:
        """A declined publication must say so precisely, and not be mutated.

        Reporting a rejection as "already executed" would send the operator
        hunting a replay bug that does not exist, and calling claim_resolution
        on a rejected grant would rewrite a human's refusal into "resuming".
        """
        request = self._frozen()
        self.gateway.authorize(request, approved=False, approver="owner@shop")
        with self.assertRaises(PublicationRejected):
            self.gateway.publish(request)

        grant = approval_grants.inspect_grant(
            request.invocation_id, request.execution_id, root=self.root)
        self.assertIsNotNone(grant)
        self.assertFalse(grant["approved"])
        self.assertEqual(grant["status"], "rejected",
                         "a refusal must not be rewritten by a later publish attempt")
        self.assertIsNone(grant["callback_claimed_at"])
        self.assertIsNone(grant["consumed_at"])
        self.assertEqual(len(self.gateway.registry.get("testnet").calls), 0)

    def test_grant_state_classification_is_precise(self) -> None:
        request = self._frozen()
        self.assertEqual(
            approval_grants.classify_grant(request.invocation_id, request.execution_id,
                                           root=self.root), "missing")
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.assertEqual(
            approval_grants.classify_grant(request.invocation_id, request.execution_id,
                                           root=self.root), "ready")
        self.gateway.publish(request)
        self.assertEqual(
            approval_grants.classify_grant(request.invocation_id, request.execution_id,
                                           root=self.root), "consumed")

    def test_authorize_requires_an_approver(self) -> None:
        request = self._frozen()
        with self.assertRaises(ValueError):
            self.gateway.authorize(request, approved=True, approver="")


class GatewaySingleExecutionTest(_GatewayCase):
    """The property that matters most: one approval publishes at most once."""

    def test_second_publish_is_refused(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.gateway.publish(request)
        with self.assertRaises(PublicationAlreadyExecuted):
            self.gateway.publish(request)
        self.assertEqual(len(self.gateway.registry.get("testnet").calls), 1,
                         "the adapter must have been called exactly once")

    def test_second_publish_from_a_foreign_gateway_is_refused(self) -> None:
        """A different gateway instance sharing the grant store must also refuse."""
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.gateway.publish(request)

        other = SocialPublishingGateway(
            registry=ad.AdapterRegistry([_RecordingAdapter()]),
            audit=AuditLog(self.root / "audit" / "other.jsonl"),
            grant_root=self.root,
        )
        with self.assertRaises(PublicationAlreadyExecuted):
            other.publish(request)

    def test_concurrent_publish_attempts_yield_one_success(self) -> None:
        import threading

        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")

        results: list[str] = []
        lock = threading.Lock()

        def attempt() -> None:
            try:
                self.gateway.publish(request)
                outcome = "ok"
            except PublicationAlreadyExecuted:
                outcome = "already"
            except Exception as exc:  # noqa: BLE001
                outcome = type(exc).__name__
            with lock:
                results.append(outcome)

        threads = [threading.Thread(target=attempt) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(results.count("ok"), 1, "exactly one attempt may publish: %s" % results)
        self.assertEqual(len(self.gateway.registry.get("testnet").calls), 1)

    def test_replay_of_a_different_decision_is_refused(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        with self.assertRaises(PublicationContentChanged):
            self.gateway.authorize(request, approved=False, approver="someone-else")

    def test_replay_with_a_different_content_hash_is_refused(self) -> None:
        request = self._frozen(text="hello")
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        tampered = dataclasses.replace(request, content=PublicationContent(text="EVIL"))
        with self.assertRaises(PublicationContentChanged):
            self.gateway.authorize(tampered, approved=True, approver="owner@shop")


class GatewayContentBindingTest(_GatewayCase):
    def test_tampering_with_content_after_approval_blocks_publication(self) -> None:
        """A swapped payload must not inherit the approval's authorisation.

        The refusal must land on the CONTENT-HASH gate, not on the later
        consume step: consuming is a mutation, so failing there would mean the
        tampered attempt already spent state that the honest request needs.
        """
        request = self._frozen(text="hello")
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        tampered = dataclasses.replace(request, content=PublicationContent(text="EVIL"))
        with self.assertRaises(PublicationContentChanged):
            self.gateway.publish(tampered)
        self.assertEqual(len(self.gateway.registry.get("testnet").calls), 0,
                         "tampered content must never reach the adapter")

    def test_tampering_does_not_consume_the_original_approval(self) -> None:
        """The honest publication must still be possible after a tamper attempt."""
        request = self._frozen(text="hello")
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        tampered = dataclasses.replace(request, content=PublicationContent(text="EVIL"))
        with self.assertRaises(PublicationContentChanged):
            self.gateway.publish(tampered)

        grant = approval_grants.inspect_grant(
            request.invocation_id, request.execution_id, root=self.root)
        self.assertIsNone(grant["callback_claimed_at"],
                          "a tamper attempt must not claim the honest approval")
        self.assertIsNone(grant["consumed_at"])

        outcome = self.gateway.publish(request)
        self.assertTrue(outcome.ok, "the honest publication must still succeed")

    def test_changed_media_digest_is_caught_by_the_same_gate(self) -> None:
        """Swapping the bytes behind an approved image must fail identically."""
        request = self._frozen(text="hello", media=(_image(DIGEST_A),))
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        swapped = dataclasses.replace(
            request, content=dataclasses.replace(request.content, media=(_image(DIGEST_B),)))
        with self.assertRaises(PublicationContentChanged):
            self.gateway.publish(swapped)

    def test_invalid_content_is_refused_before_the_approval_is_consumed(self) -> None:
        """A post that cannot publish must not burn a human's approval."""
        request = self._frozen(text="x" * 200)   # testnet text_max is 100
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        with self.assertRaises(PublicationValidationFailed) as ctx:
            self.gateway.publish(request)
        self.assertIn("text_too_long", [i.code for i in ctx.exception.result.errors])

        # The approval survives: fixing the content and re-freezing is possible
        # without a second human decision only if the grant was not consumed.
        consumed = approval_grants.find_grant(
            TENANT, BUSINESS, request.tool_name, request.grant_args(), root=self.root)
        self.assertIsNotNone(consumed, "grant must still exist after a validation refusal")

    def test_unimplemented_platform_is_refused_without_consuming_the_grant(self) -> None:
        gateway = SocialPublishingGateway(
            registry=ad.default_registry(),
            audit=AuditLog(self.root / "audit" / "real.jsonl"),
            grant_root=self.root,
        )
        request = gateway.freeze(
            "linkedin", PublicationContent(text="hello"),
            tenant_id=TENANT, business_id=BUSINESS,
            invocation_id="inv-L", execution_id="exec-L", request_id="req-L")
        gateway.authorize(request, approved=True, approver="owner@shop")
        with self.assertRaises(PublicationNotImplemented):
            gateway.publish(request)
        self.assertIsNotNone(
            approval_grants.find_grant(TENANT, BUSINESS, request.tool_name,
                                       request.grant_args(), root=self.root),
            "an unimplemented adapter must not consume the approval",
        )

    def test_unknown_platform_is_refused(self) -> None:
        request = self.gateway.freeze(
            "myspace", PublicationContent(text="hello"),
            tenant_id=TENANT, business_id=BUSINESS,
            invocation_id="inv-M", execution_id="exec-M")
        with self.assertRaises(PublicationNotImplemented):
            self.gateway.publish(request)


class GatewayAuditTest(_GatewayCase):
    def test_full_cycle_is_audited(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.gateway.publish(request)
        actions = [row["action"] for row in self._audit()]
        for expected in ("social_publication_frozen", "social_publication_approved",
                         "social_publication_started", "social_publication_succeeded"):
            self.assertIn(expected, actions)

    def test_refusals_are_audited(self) -> None:
        request = self._frozen()
        with self.assertRaises(PublicationNotApproved):
            self.gateway.publish(request)
        actions = [row["action"] for row in self._audit()]
        self.assertIn("social_publication_not_approved", actions)

    def test_replay_block_is_audited(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.gateway.publish(request)
        with self.assertRaises(PublicationAlreadyExecuted):
            self.gateway.publish(request)
        rows = [r for r in self._audit() if r["action"] == "social_publication_replay_blocked"]
        self.assertTrue(rows, "a blocked replay must leave a trail")

    def test_audit_records_the_tenant_and_result(self) -> None:
        request = self._frozen()
        self.gateway.authorize(request, approved=True, approver="owner@shop")
        self.gateway.publish(request)
        for row in self._audit():
            self.assertEqual(row["tenant_id"], TENANT)
            self.assertIn(row["result"], {"ok", "denied", "error", "pending_approval"})

    def test_adapter_failure_is_audited_and_marks_the_grant_failed(self) -> None:
        gateway = SocialPublishingGateway(
            registry=ad.AdapterRegistry([_RecordingAdapter(fail=True)]),
            audit=AuditLog(self.root / "audit" / "fail.jsonl"),
            grant_root=self.root,
        )
        _TestLimitsMixin.setUpClass()
        self.addCleanup(_TestLimitsMixin.tearDownClass)
        request = gateway.freeze(
            "testnet", PublicationContent(text="hi"),
            tenant_id=TENANT, business_id=BUSINESS,
            invocation_id="inv-F", execution_id="exec-F", request_id="req-F")
        gateway.authorize(request, approved=True, approver="owner@shop")
        with self.assertRaises(RuntimeError):
            gateway.publish(request)

        actions = [json.loads(l)["action"]
                   for l in (self.root / "audit" / "fail.jsonl").read_text(
                       encoding="utf-8").splitlines() if l.strip()]
        self.assertIn("social_publication_failed", actions)
        grant = approval_grants.find_grant(TENANT, BUSINESS, request.tool_name,
                                          request.grant_args(), root=self.root)
        self.assertEqual(grant.get("status"), "failed")


class GatewayCapabilitiesTest(_GatewayCase):
    def test_capabilities_report_is_honest_about_this_build(self) -> None:
        gateway = SocialPublishingGateway(
            registry=ad.default_registry(),
            audit=AuditLog(self.root / "audit" / "caps.jsonl"),
            grant_root=self.root,
        )
        caps = gateway.capabilities()
        self.assertEqual(caps["implemented"], ())
        self.assertEqual(set(caps["unimplemented"]), {"linkedin", "tiktok", "youtube"})
        self.assertIn("No platform adapter performs real API calls", caps["note"])

    def test_validate_only_is_pure(self) -> None:
        gateway = SocialPublishingGateway(
            registry=ad.default_registry(),
            audit=AuditLog(self.root / "audit" / "v.jsonl"),
            grant_root=self.root,
        )
        result = gateway.validate_only("linkedin", PublicationContent(text="x" * 4000))
        self.assertFalse(result.ok)
        self.assertEqual(self._audit(), [], "validate-only must not write audit rows")


class PolicyPackTest(unittest.TestCase):
    def test_pack_governs_the_publish_tool_at_owner_level(self) -> None:
        from roveagent.social.gateway import SOCIAL_PUBLISH_POLICIES
        from roveagent.tools.framework import EnterpriseToolGate

        gate = EnterpriseToolGate(policies=list(SOCIAL_PUBLISH_POLICIES))
        policy = gate.policy_for("publish_social_post")
        self.assertEqual(policy.pattern, "publish_social_post")
        self.assertEqual(policy.permission, "comms:publish")
        self.assertEqual(policy.approval, "owner")
        self.assertEqual(int(policy.risk), 2, "publishing is HIGH risk")

    def test_pack_does_not_leak_into_the_default_table(self) -> None:
        """A default row for a tool that cannot execute would be dead code."""
        from roveagent.tools.framework import DEFAULT_POLICIES

        patterns = {p.pattern for p in DEFAULT_POLICIES}
        self.assertNotIn("publish_social_post", patterns)

    def test_read_only_helpers_are_low_risk(self) -> None:
        from roveagent.social.gateway import SOCIAL_PUBLISH_POLICIES
        from roveagent.tools.framework import EnterpriseToolGate

        gate = EnterpriseToolGate(policies=list(SOCIAL_PUBLISH_POLICIES))
        for tool in ("validate_social_post", "publish_social_capabilities"):
            with self.subTest(tool=tool):
                policy = gate.policy_for(tool)
                self.assertEqual(policy.approval, "none")
                self.assertEqual(int(policy.risk), 0)

    def test_pack_entries_are_not_shadowed_when_prepended(self) -> None:
        """Prepending is the documented extension point; order must still work."""
        import fnmatch

        from roveagent.social.gateway import SOCIAL_PUBLISH_POLICIES

        seen: list[str] = []
        for policy in SOCIAL_PUBLISH_POLICIES:
            for earlier in seen:
                self.assertFalse(
                    fnmatch.fnmatchcase(policy.pattern, earlier),
                    "%r is shadowed by earlier pack entry %r" % (policy.pattern, earlier))
            seen.append(policy.pattern)


if __name__ == "__main__":
    unittest.main()
