"""Resolve ROVEAGENT_HOME for standalone skill scripts.

Skill scripts may run outside the RoveAgent process (e.g. system Python,
nix env, CI) where ``roveagent_constants`` is not importable.  This module
provides the same ``get_roveagent_home()`` and ``display_roveagent_home()``
contracts as ``roveagent_constants`` without requiring it on ``sys.path``.

When ``roveagent_constants`` IS available it is used directly so that any
future enhancements (profile resolution, Docker detection, etc.) are
picked up automatically.  The fallback path replicates the core logic
from ``roveagent_constants.py`` using only the stdlib.

All scripts under ``google-workspace/scripts/`` should import from here
instead of duplicating the ``ROVEAGENT_HOME = Path(os.getenv(...))`` pattern.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from roveagent_constants import display_roveagent_home as display_roveagent_home
    from roveagent_constants import get_roveagent_home as get_roveagent_home
except (ModuleNotFoundError, ImportError):

    def get_roveagent_home() -> Path:
        """Return the RoveAgent home directory (default: ~/.roveagent).

        Mirrors ``roveagent_constants.get_roveagent_home()``."""
        val = os.environ.get("ROVEAGENT_HOME", "").strip()
        return Path(val) if val else Path.home() / ".roveagent"

    def display_roveagent_home() -> str:
        """Return a user-friendly ``~/``-shortened display string.

        Mirrors ``roveagent_constants.display_roveagent_home()``."""
        home = get_roveagent_home()
        try:
            return "~/" + home.relative_to(Path.home()).as_posix()
        except ValueError:
            return str(home)
