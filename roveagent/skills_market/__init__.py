"""Skill package lifecycle.

Scope
-----

Marketplace-grade management for skills: what a skill declares
(``manifest``), which version is which (``versions``), what it may do
(``permissions``), where it may run (``sandbox``), whether it is safe to install
(``scanner``), what is available (``registry``), and how an install proceeds
(``installer``).

Relationship to what already exists
-----------------------------------

This package does not replace the existing skill machinery and does not
duplicate its rules. It reuses:

  * ``core.skill_utils`` — ``parse_frontmatter`` / ``yaml_load``, platform and
    environment matching, discovery roots. The frontmatter parser is the single
    source of truth for the SKILL.md format.
  * ``api.plugin_security`` — ``analyze_plugin_code``, the AST capability
    analyser, for the code portion of a skill scan.
  * ``tools.framework`` — ``EnterpriseToolGate`` remains the only execution
    gate. Nothing here grants execution rights; ``permissions`` records an
    operator's decision, and the gate still makes the final call per call.

Notes on a known inconsistency (observed 2026-09-12)
----------------------------------------------------

``clisupport.agent_plugins._valid_skill_frontmatter`` requires every
``metadata`` value to be a *string*, but the shipped library contains nested,
list-valued metadata, e.g. ``metadata.roveagent.tags: [Notes, Apple]`` in
``skills_library/apple/apple-notes/SKILL.md``. That validator targets the
strict portable Agent Plugins format; the library follows the looser
in-repo convention. This package therefore enforces the Agent Skills
constraints on ``name`` and ``description`` (which both formats agree on) and
accepts structured ``metadata``, because rejecting the shipped library would be
the wrong kind of strictness. The discrepancy is recorded rather than silently
papered over.
"""

from __future__ import annotations

__all__ = [
    "versions",
    "manifest",
    "permissions",
    "sandbox",
    "scanner",
    "registry",
    "installer",
]
