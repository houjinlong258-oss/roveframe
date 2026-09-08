"""Resolve ROVEAGENT_HOME for standalone skill scripts.

Skill scripts may run outside the RoveAgent process (system Python, nix env,
CI) where ``roveagent_constants`` is not importable.  This module provides the
same ``get_roveagent_home()`` contract without requiring it on ``sys.path``.

When ``roveagent_constants`` IS available it is used directly so profile
resolution and any future enhancements are picked up automatically.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from roveagent_constants import get_roveagent_home as get_roveagent_home
except (ModuleNotFoundError, ImportError):

    def get_roveagent_home() -> Path:
        """Return the RoveAgent home directory (default: ``~/.roveagent``)."""
        val = os.environ.get("ROVEAGENT_HOME", "").strip()
        return Path(val) if val else Path.home() / ".roveagent"
