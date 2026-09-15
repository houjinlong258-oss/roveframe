"""Skill security scanner.

Reuses rather than reinvents
----------------------------

Code analysis delegates to ``api.plugin_security.analyze_plugin_code``, the AST
capability analyser written for plugins. A second AST walker would be a second
set of blind spots, and the two would drift.

What this module adds is the part a Python AST cannot see: a skill's primary
payload is its SKILL.md — prose a model is instructed to follow. That is an
instruction channel, and it is where a malicious skill does its work. Static
analysis of ``.py`` files misses it entirely.

Threats covered
---------------

  prompt_injection       text that tries to override the operator's or system's
                         instructions, or to exfiltrate the conversation
  invisible_text         zero-width, bidi-override, and tag characters, used to
                         hide instructions from a human reviewer
  encoded_payload        long base64/hex blobs, a common way to smuggle an
                         instruction past review
  credential_access      reading env vars or files that look like secrets
  network_egress         outbound calls, including the shell forms that evade
                         an import scan
  destructive_command    rm -rf, mkfs, dd, fork bombs, curl|sh
  path_escape            references outside the skill directory
  unlisted_prerequisite  a shell command the manifest never declared, so the
                         operator's prerequisite review was bypassed

Honesty about strength
----------------------

This is a heuristic screen, not a proof. ``enforce`` defaults to False: findings
are recorded and returned but do not block installation, because a false
positive that blocks a legitimate skill trains operators to disable the check.

A skill is one ``import re`` away from any pattern here. The scanner's value is
catching carelessness and cheap attacks, and making the review step informed.
"""

from __future__ import annotations

import dataclasses
import re
import unicodedata
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from roveagent.skills_market.manifest import SKILL_FILENAME, SkillManifest

__all__ = [
    "Severity",
    "Finding",
    "ScanReport",
    "scan_skill",
    "scan_text",
    "is_install_allowed",
]


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    HIGH = "high"
    CRITICAL = "critical"


#: Severities that would block an install when enforcement is on.
BLOCKING: frozenset[Severity] = frozenset({Severity.HIGH, Severity.CRITICAL})


@dataclasses.dataclass(frozen=True)
class Finding:
    code: str
    severity: Severity
    message: str
    evidence: str = ""
    where: str = ""

    def as_dict(self) -> dict[str, Any]:
        out = {"code": self.code, "severity": self.severity.value, "message": self.message}
        if self.evidence:
            out["evidence"] = self.evidence[:200]
        if self.where:
            out["where"] = self.where
        return out


@dataclasses.dataclass(frozen=True)
class ScanReport:
    skill_name: str
    findings: tuple[Finding, ...] = ()
    files_examined: tuple[str, ...] = ()
    detected_capabilities: tuple[str, ...] = ()
    scanner_error: str = ""

    @property
    def blocking(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity in BLOCKING)

    @property
    def by_severity(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for finding in self.findings:
            counts[finding.severity.value] = counts.get(finding.severity.value, 0) + 1
        return counts

    @property
    def ok(self) -> bool:
        """No blocking findings, and the scan actually ran."""
        return not self.blocking and not self.scanner_error

    def summary(self) -> str:
        if self.scanner_error:
            return "%s: scan incomplete (%s)" % (self.skill_name, self.scanner_error)
        counts = self.by_severity
        if not counts:
            return "%s: no findings" % self.skill_name
        return "%s: %s" % (
            self.skill_name,
            ", ".join("%d %s" % (n, sev) for sev, n in sorted(counts.items())),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "skill_name": self.skill_name,
            "ok": self.ok,
            "summary": self.summary(),
            "counts": self.by_severity,
            "findings": [f.as_dict() for f in self.findings],
            "files_examined": list(self.files_examined),
            "detected_capabilities": list(self.detected_capabilities),
            "scanner_error": self.scanner_error,
        }


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

_INJECTION_PATTERNS: tuple[tuple[str, Severity, str], ...] = (
    (r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions",
     Severity.CRITICAL, "instruction-override phrasing"),
    (r"disregard\s+(?:all\s+)?(?:previous|prior|the\s+above)",
     Severity.CRITICAL, "instruction-override phrasing"),
    (r"you\s+are\s+now\s+(?:a|an|in)\b", Severity.HIGH, "role-reassignment phrasing"),
    (r"new\s+(?:system\s+)?instructions?\s*:", Severity.HIGH, "injected system instruction"),
    (r"(?:reveal|print|output|repeat)\s+(?:your\s+)?(?:system\s+)?prompt",
     Severity.HIGH, "attempt to extract the system prompt"),
    (r"(?:send|post|upload|exfiltrate)\s+(?:the\s+)?(?:conversation|chat|messages|context)",
     Severity.CRITICAL, "attempt to exfiltrate conversation context"),
    (r"do\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+(?:user|operator|owner)",
     Severity.HIGH, "instruction to conceal activity from the operator"),
    (r"\bapproval\s+(?:is\s+)?(?:not\s+)?(?:needed|required)\b.*\b(?:delete|drop|rm|deploy)",
     Severity.CRITICAL, "attempt to waive approval for a destructive action"),
)

_INVISIBLE_RANGES: tuple[tuple[int, int, str], ...] = (
    (0x200B, 0x200F, "zero-width / bidi mark"),
    (0x202A, 0x202E, "bidi override"),
    (0x2060, 0x2064, "invisible operator"),
    (0xFEFF, 0xFEFF, "zero-width no-break space"),
    (0xE0000, 0xE007F, "Unicode tag character"),
)

_DESTRUCTIVE_PATTERNS: tuple[tuple[str, Severity, str], ...] = (
    (r"\brm\s+-[a-zA-Z]*[rf]", Severity.CRITICAL, "recursive/forced delete"),
    (r"\bmkfs(?:\.\w+)?\b", Severity.CRITICAL, "filesystem format"),
    (r"\bdd\s+if=", Severity.HIGH, "raw device write"),
    (r":\(\)\s*\{.*\}\s*;\s*:", Severity.CRITICAL, "fork bomb"),
    (r"\bcurl\b[^|\n]*\|\s*(?:ba)?sh", Severity.CRITICAL, "pipe remote content into a shell"),
    (r"\bwget\b[^|\n]*\|\s*(?:ba)?sh", Severity.CRITICAL, "pipe remote content into a shell"),
    (r"\bchmod\s+(?:-R\s+)?777\b", Severity.HIGH, "world-writable permissions"),
    (r"\b(?:shutdown|reboot|halt|poweroff)\b", Severity.HIGH, "host power control"),
    (r"\bgit\s+push\s+.*--force\b", Severity.HIGH, "forced history rewrite"),
)

_NETWORK_PATTERNS: tuple[tuple[str, Severity, str], ...] = (
    (r"\b(?:curl|wget|nc|ncat|telnet)\s", Severity.WARNING, "shell network client"),
    (r"https?://(?!\S*\.(?:example|invalid|local)\b)\S+", Severity.INFO, "outbound URL reference"),
    (r"\bsocket\s*\.\s*(?:socket|create_connection)", Severity.HIGH, "raw socket use"),
)

_SECRET_PATTERNS: tuple[tuple[str, Severity, str], ...] = (
    (r"\$\{?[A-Z_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*\}?",
     Severity.HIGH, "reads a credential-shaped environment variable"),
    (r"(?:^|[/\\.])(?:\.env|id_rsa|id_ed25519|\.aws/credentials|\.netrc|\.git-credentials)\b",
     Severity.HIGH, "references a credential file"),
    (r"\bprintenv\b|\benv\s*\|\s*grep\b", Severity.WARNING, "dumps the environment"),
    (r"\bkeyring\b|\bcredential[-_ ]?store\b", Severity.WARNING, "credential store access"),
)

_ENCODED_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")
_HEX_BLOB_RE = re.compile(r"\b(?:[0-9a-fA-F]{2}){100,}\b")
_BASE64_DATA_URI_RE = re.compile(r"data:[a-z]+/[a-z0-9.+-]+;base64,", re.I)

#: Shell constructs that evade an argument-level scan.
_SHELL_CONSTRUCTS: tuple[tuple[str, Severity, str], ...] = (
    (r"\$\([^)]*\)", Severity.WARNING, "command substitution"),
    (r"`[^`]+`", Severity.WARNING, "backtick command substitution"),
    (r"\beval\b", Severity.HIGH, "eval of dynamic content"),
    (r"\bbase64\s+-d\b|\bbase64\s+--decode\b", Severity.HIGH, "decodes a payload at runtime"),
    (r"\bexec\s+\d|<\s*\(\s*curl", Severity.HIGH, "exec from a network source"),
)


def _scan_text_for(
    text: str, where: str, patterns: Sequence[tuple[str, Severity, str]],
    *, code: str,
) -> list[Finding]:
    out: list[Finding] = []
    for pattern, severity, description in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE | re.MULTILINE):
            snippet = match.group(0).strip()
            out.append(Finding(
                code=code, severity=severity,
                message=description, evidence=snippet, where=where,
            ))
            break  # one finding per pattern per file keeps the report readable
    return out


def scan_text(text: str, *, where: str = "<text>") -> tuple[Finding, ...]:
    """Scan a single block of text. Pure; used for SKILL.md and for tests."""
    findings: list[Finding] = []

    findings += _scan_text_for(text, where, _INJECTION_PATTERNS, code="prompt_injection")

    # Invisible characters: catch them by codepoint rather than by regex so the
    # range table stays the single source of truth.
    seen_invisible: set[str] = set()
    for char in text:
        point = ord(char)
        for low, high, label in _INVISIBLE_RANGES:
            if low <= point <= high:
                if label not in seen_invisible:
                    seen_invisible.add(label)
                    findings.append(Finding(
                        code="invisible_text", severity=Severity.CRITICAL,
                        message="contains %s (U+%04X); text a human reviewer cannot "
                                "see" % (label, point),
                        evidence=repr(char), where=where,
                    ))
                break

    # Unicode confusables: a Cyrillic 'а' in "rm -rf" defeats a naive pattern.
    if any(unicodedata.name(c, "").startswith(("CYRILLIC", "GREEK")) for c in text
           if not c.isascii() and c.isalpha()):
        findings.append(Finding(
            code="confusable_script", severity=Severity.WARNING,
            message="mixes non-Latin letters into Latin text; a common way to make "
                    "a command look like something else",
            where=where,
        ))

    for regex, label in ((_ENCODED_BLOB_RE, "base64-looking"), (_HEX_BLOB_RE, "hex-looking")):
        match = regex.search(text)
        if match:
            findings.append(Finding(
                code="encoded_payload", severity=Severity.WARNING,
                message="contains a long %s blob (%d chars); encoded payloads hide "
                        "instructions from review" % (label, len(match.group(0))),
                evidence=match.group(0)[:60] + "...", where=where,
            ))
    if _BASE64_DATA_URI_RE.search(text):
        findings.append(Finding(
            code="embedded_media", severity=Severity.INFO,
            message="embeds a base64 data URI; check the payload is what it claims",
            where=where,
        ))

    findings += _scan_text_for(text, where, _DESTRUCTIVE_PATTERNS, code="destructive_command")
    findings += _scan_text_for(text, where, _NETWORK_PATTERNS, code="network_egress")
    findings += _scan_text_for(text, where, _SECRET_PATTERNS, code="credential_access")
    findings += _scan_text_for(text, where, _SHELL_CONSTRUCTS, code="shell_construct")

    # Path escapes: ../ chains that leave the skill directory.
    for match in re.finditer(r"(?:\.\./){2,}", text):
        findings.append(Finding(
            code="path_escape", severity=Severity.HIGH,
            message="references paths several levels outside the skill directory",
            evidence=match.group(0), where=where,
        ))
        break

    return tuple(findings)


def _iter_skill_files(skill_dir: Path, *, limit: int = 200) -> Iterable[Path]:
    count = 0
    for path in sorted(skill_dir.rglob("*")):
        if count >= limit:
            return
        if not path.is_file():
            continue
        if "__pycache__" in path.parts or ".git" in path.parts:
            continue
        yield path
        count += 1


def scan_skill(
    skill_dir: Path, manifest: Optional[SkillManifest] = None,
) -> ScanReport:
    """Scan a skill directory: prose payload, support files, and code.

    Code analysis is delegated to ``api.plugin_security.analyze_plugin_code`` so
    there is exactly one AST capability analyser in the codebase.
    """
    directory = Path(skill_dir)
    if not directory.is_dir():
        return ScanReport(skill_name=directory.name,
                          scanner_error="%s is not a directory" % directory)

    findings: list[Finding] = []
    examined: list[str] = []

    skill_md = directory / SKILL_FILENAME
    body = ""
    if skill_md.is_file():
        try:
            body = skill_md.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            return ScanReport(skill_name=directory.name,
                              scanner_error="cannot read SKILL.md: %s" % exc)
        examined.append(SKILL_FILENAME)
        findings += list(scan_text(body, where=SKILL_FILENAME))

    # Support files: markdown and text can also carry instructions.
    for path in _iter_skill_files(directory):
        rel = str(path.relative_to(directory))
        if rel == SKILL_FILENAME:
            continue
        if path.suffix.lower() in (".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml"):
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            examined.append(rel)
            findings += list(scan_text(text, where=rel))

    # Prerequisite honesty: a shell command used but never declared bypasses the
    # operator's prerequisite review.
    if manifest is not None and manifest.required_commands:
        declared = {c.split()[0] for c in manifest.required_commands if c.strip()}
    elif manifest is not None:
        declared = set()
    else:
        declared = set()
    if manifest is not None:
        for match in re.finditer(r"^\s*(?:sudo\s+)?([a-z][a-z0-9_.+-]{1,30})\s+-",
                                 body, re.IGNORECASE | re.MULTILINE):
            command = match.group(1).lower()
            if command in {"the", "and", "for", "with", "this", "that", "your", "use"}:
                continue
            if command not in declared:
                findings.append(Finding(
                    code="unlisted_prerequisite", severity=Severity.INFO,
                    message="invokes %r in an example but the manifest declares no "
                            "such prerequisite" % command,
                    evidence=match.group(0).strip(), where=SKILL_FILENAME,
                ))

    # Code capabilities, via the shared analyser.
    detected: list[str] = []
    try:
        from roveagent.api.plugin_security import analyze_plugin_code

        caps = analyze_plugin_code(directory)
        detected = sorted(str(c) for c in caps)
        for capability in detected:
            findings.append(Finding(
                code="code_capability", severity=Severity.INFO,
                message="the skill's code uses %s" % capability,
                where="<code>",
            ))
    except ImportError as exc:
        # The analyser is optional to import; its absence must not be reported
        # as a clean scan, or a missing module would look like a safe skill.
        return ScanReport(
            skill_name=directory.name,
            findings=tuple(findings),
            files_examined=tuple(examined),
            detected_capabilities=(),
            scanner_error="code analyser unavailable: %s" % exc,
        )
    except SyntaxError as exc:
        # A skill containing unparseable Python is itself worth flagging.
        findings.append(Finding(
            code="unparseable_code", severity=Severity.WARNING,
            message="a Python file could not be parsed: %s" % exc,
            where="<code>",
        ))

    return ScanReport(
        skill_name=manifest.name if manifest else directory.name,
        findings=tuple(findings),
        files_examined=tuple(examined),
        detected_capabilities=tuple(detected),
    )


def is_install_allowed(report: ScanReport, *, enforce: bool = False) -> bool:
    """Whether an install may proceed.

    ``enforce`` defaults to False: findings are advisory unless a deployment
    opts in. The scan result is always returned either way, so a non-enforcing
    install is still an INFORMED install.
    """
    if report.scanner_error:
        return False
    if not enforce:
        return True
    return report.ok
