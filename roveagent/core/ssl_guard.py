"""Preventive SSL CA certificate checks for RoveAgent Agent.

This module catches broken CA bundle paths before OpenAI/httpx turns them into
opaque ``FileNotFoundError: [Errno 2] No such file or directory`` failures.
"""

from __future__ import annotations

import logging
import os
import ssl
import threading
from pathlib import Path

from roveagent.core.errors import SSLConfigurationError

logger = logging.getLogger(__name__)

_CA_BUNDLE_ENV_VARS = (
    "ROVEAGENT_CA_BUNDLE",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
)

_SKIP_VALUES = {"1", "true", "yes", "on"}

# ---------------------------------------------------------------------------
# Phase 11 / Task 3 — successful CA-bundle validation is memoized.
#
# Loading a CA bundle means building a full SSL context and parsing every
# X.509 certificate in it. Measured on the reference machine: ~0.4 s per
# bundle, and TWO bundles are validated per call on a host that exports e.g.
# CURL_CA_BUNDLE. Because verify_ca_bundle() ran from AIAgent.__init__, that
# cost was paid on every single agent build — measured at 780 ms/init, 66% of
# a 1174 ms production-shaped agent_build.
#
# The bundles are static files. An unchanged file that already loaded
# successfully cannot start failing, so the verdict is cached against
# (resolved path, st_mtime_ns, st_size, require_substantial). Replacing,
# truncating or touching the file changes the key and forces a fresh parse.
#
# What is deliberately NOT skipped: the existence, is-a-file and minimum-size
# checks still run on every call, so a deleted or truncated bundle is still
# rejected immediately. Only the expensive re-parse of an unchanged, known-good
# bundle is skipped. Failed validations are never cached.
# ---------------------------------------------------------------------------
_VALIDATED_BUNDLES: dict = {}
_VALIDATED_BUNDLES_LOCK = threading.Lock()
_VALIDATED_BUNDLES_MAX = 32


def _remember_validated_bundle(cache_key) -> None:
    if cache_key is None:
        return
    with _VALIDATED_BUNDLES_LOCK:
        if len(_VALIDATED_BUNDLES) >= _VALIDATED_BUNDLES_MAX:
            _VALIDATED_BUNDLES.pop(next(iter(_VALIDATED_BUNDLES)))
        _VALIDATED_BUNDLES[cache_key] = True


def _already_validated(cache_key) -> bool:
    if cache_key is None:
        return False
    with _VALIDATED_BUNDLES_LOCK:
        return cache_key in _VALIDATED_BUNDLES


def clear_ca_bundle_cache() -> None:
    """Drop memoized CA-bundle validation verdicts (tests / doctor --fix)."""
    with _VALIDATED_BUNDLES_LOCK:
        _VALIDATED_BUNDLES.clear()


def _skip_ssl_guard_enabled() -> bool:
    return os.getenv("ROVEAGENT_SKIP_SSL_GUARD", "").strip().lower() in _SKIP_VALUES


def _repair_hint() -> str:
    return (
        "Repair: run `roveagent doctor --fix` (auto-reinstalls certifi), or "
        "manually: python -m pip install --force-reinstall certifi openai httpx\n"
        "If you configured a custom corporate CA bundle, fix or unset the "
        "broken CA bundle environment variable."
    )


def _ssl_err(message: str) -> SSLConfigurationError:
    """Create a consistent, user-actionable SSL configuration error."""
    return SSLConfigurationError(f"{message}\n{_repair_hint()}")


def _validate_bundle_path(label: str, value: str, *, require_substantial: bool = False) -> None:
    path = Path(value).expanduser()
    if not path.exists():
        raise _ssl_err(f"{label} points to a missing CA bundle: {value}")
    if not path.is_file():
        raise _ssl_err(f"{label} does not point to a CA bundle file: {value}")
    if require_substantial and path.stat().st_size < 1024:
        raise _ssl_err(f"{label} at {value} appears corrupted (too small)")

    # Cheap identity of the exact file we are about to validate. Any content
    # change that matters moves mtime_ns and/or size, invalidating the memo.
    try:
        _stat = path.stat()
        cache_key = (str(path), _stat.st_mtime_ns, _stat.st_size, require_substantial)
    except OSError:
        cache_key = None

    if _already_validated(cache_key):
        return

    try:
        ctx = ssl.create_default_context(cafile=str(path))
    except Exception as exc:
        raise _ssl_err(f"{label} CA bundle at {value} cannot be loaded: {exc}") from exc
    try:
        loaded_certs = ctx.get_ca_certs()
    except NotImplementedError:
        # truststore-backed SSLContext (Windows OS trust store) doesn't
        # implement get_ca_certs(); bundle was already validated above.
        _remember_validated_bundle(cache_key)
        return
    if not loaded_certs:
        raise _ssl_err(f"{label} CA bundle at {value} did not load any certificates")
    _remember_validated_bundle(cache_key)


def verify_ca_bundle() -> None:
    """Verify configured and bundled CA certificates are present and loadable.

    Raises:
        SSLConfigurationError: If an explicit CA-bundle environment variable
            points at a bad path, or if certifi's bundled ``cacert.pem`` is
            missing/corrupt.
    """
    if _skip_ssl_guard_enabled():
        logger.debug("SSL CA bundle guard skipped via ROVEAGENT_SKIP_SSL_GUARD")
        return

    for env_var in _CA_BUNDLE_ENV_VARS:
        value = os.getenv(env_var)
        if value:
            _validate_bundle_path(env_var, value)

    try:
        import certifi
    except Exception as exc:
        raise _ssl_err(f"certifi is not importable: {exc}") from exc

    ca_bundle = str(certifi.where())
    _validate_bundle_path("certifi", ca_bundle, require_substantial=True)


def verify_ca_bundle_with_fallback() -> None:
    """Backward-compatible wrapper for older call sites.

    The old PR name mentioned a platform fallback, but allowing startup with a
    broken certifi bundle still leaves httpx/OpenAI and requests call sites
    failing later. Keep the wrapper name but enforce the same check.
    """
    verify_ca_bundle()
