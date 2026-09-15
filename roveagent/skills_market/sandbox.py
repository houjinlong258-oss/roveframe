"""Sandbox runtime interface — and a default that refuses to run anything.

The requirement this answers
----------------------------

Plugins and skills must not be able to break the host. The user's constraint is
explicit: a broken plugin must not affect the main system, the way an MCP server
crash does not take down its client.

What that means in practice
---------------------------

Isolation is a property of a RUNTIME, not of an interface. Declaring
``SandboxRuntime`` creates no isolation by itself. So this module does two
things and is honest about the gap between them:

  * It fixes the contract every isolation backend must satisfy
    (``SandboxRuntime``), so a Docker/gVisor/firejail/remote backend can be
    added without touching callers.
  * It ships ``UnavailableSandbox`` as the DEFAULT, which refuses every request.
    That is the fail-closed choice: with no isolation backend configured,
    executing untrusted skill code in-process would be silently granting it the
    host. Refusing is the only honest default.

``InProcessSandbox`` is provided for skills that have already been reviewed and
trusted, and it says so in its own name and its ``trust_level``. It performs no
isolation, and anything running under it must not be described as sandboxed.

This mirrors the existing environment backends (``tools/environments/``:
docker, daytona, modal, singularity, ssh, vercel_sandbox) — several of which are
unavailable on a typical machine. Those serve *agent* command execution. This
interface serves *skill* execution and is deliberately separate, because the
trust question differs: an agent command is proposed by a model under the gate,
whereas a skill is third-party code.
"""

from __future__ import annotations

import dataclasses
import time
import uuid
from abc import ABC, abstractmethod
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

__all__ = [
    "TrustLevel",
    "SandboxError",
    "SandboxUnavailable",
    "SandboxRequest",
    "SandboxResult",
    "SandboxRuntime",
    "SandboxRegistry",
    "default_registry",
]


class TrustLevel(str, Enum):
    """How much isolation a runtime actually provides. Claimed, then verifiable."""

    NONE = "none"            # runs in the host process; no isolation at all
    PROCESS = "process"      # separate process, same kernel/namespace
    CONTAINER = "container"  # namespaces + cgroup limits
    MICROVM = "microvm"      # separate kernel
    REMOTE = "remote"        # different machine


class SandboxError(RuntimeError):
    """Base class for sandbox refusals and failures."""


class SandboxUnavailable(SandboxError):
    """No runtime can serve this request. Fail closed rather than run unsandboxed.

    Raised by :class:`UnavailableSandbox` and by
    :meth:`SandboxRegistry.select` when nothing suitable is registered. Callers
    must treat it as a hard refusal, not as a signal to fall back to in-process
    execution — that fallback is exactly the failure this design prevents.
    """


@dataclasses.dataclass(frozen=True)
class SandboxRequest:
    """One unit of work a skill wants performed."""

    skill_name: str
    command: Sequence[str] = ()
    working_dir: Optional[str] = None
    env: Mapping[str, str] = dataclasses.field(default_factory=dict)
    timeout_s: float = 60.0
    network: bool = False
    writable_paths: Sequence[str] = ()
    request_id: str = ""

    def __post_init__(self) -> None:
        if not self.skill_name.strip():
            raise ValueError("skill_name is required")
        if not self.command:
            raise ValueError("command must be a non-empty argv sequence")
        if isinstance(self.command, str):
            raise ValueError(
                "command must be an argv sequence, not a shell string; passing a "
                "string would require a shell and lose argument boundaries"
            )
        if self.timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        if not self.request_id:
            object.__setattr__(self, "request_id", uuid.uuid4().hex)

    @property
    def argv(self) -> tuple[str, ...]:
        return tuple(str(a) for a in self.command)


@dataclasses.dataclass(frozen=True)
class SandboxResult:
    ok: bool
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    duration_s: float = 0.0
    trust_level: TrustLevel = TrustLevel.NONE
    truncated: bool = False
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_s": round(self.duration_s, 4),
            "trust_level": self.trust_level.value,
            "truncated": self.truncated,
            "detail": self.detail,
        }


class SandboxRuntime(ABC):
    """Contract for an isolation backend.

    Implementations must be explicit about two things, because both are easy to
    overstate: :meth:`trust_level` (what isolation is actually provided) and
    :meth:`is_available` (whether it can run here at all). A runtime that is
    registered but unavailable must report so rather than fail at execution
    time, where the failure would look like a skill bug.
    """

    name: str = ""

    @abstractmethod
    def trust_level(self) -> TrustLevel:
        """The isolation this backend ACTUALLY provides."""

    @abstractmethod
    def is_available(self) -> bool:
        """Whether this backend can run on this host right now. Must be cheap."""

    @abstractmethod
    def run(self, request: SandboxRequest) -> SandboxResult:
        """Execute *request* under this backend's isolation."""

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trust_level": self.trust_level().value,
            "available": self.is_available(),
        }


class SandboxRegistry:
    """Ordered set of runtimes; selects the strongest available one.

    Selection is by trust level (strongest first) and never by registration
    order, so adding a backend cannot accidentally downgrade isolation.
    """

    _ORDER = {
        TrustLevel.REMOTE: 4,
        TrustLevel.MICROVM: 3,
        TrustLevel.CONTAINER: 2,
        TrustLevel.PROCESS: 1,
        TrustLevel.NONE: 0,
    }

    def __init__(self, runtimes: Sequence[SandboxRuntime] = ()) -> None:
        self._runtimes: list[SandboxRuntime] = list(runtimes)

    def register(self, runtime: SandboxRuntime) -> None:
        if not getattr(runtime, "name", ""):
            raise ValueError("sandbox runtime must declare a non-empty name")
        self._runtimes.append(runtime)

    def runtimes(self) -> tuple[SandboxRuntime, ...]:
        """All registered runtimes, strongest isolation first."""
        return tuple(sorted(
            self._runtimes,
            key=lambda r: self._ORDER.get(r.trust_level(), -1),
            reverse=True,
        ))

    def available(self) -> tuple[SandboxRuntime, ...]:
        return tuple(r for r in self.runtimes() if r.is_available())

    def select(self, *, minimum: TrustLevel = TrustLevel.CONTAINER) -> SandboxRuntime:
        """Strongest available runtime meeting *minimum*, or raise.

        Default minimum is CONTAINER, not PROCESS: a separate process without
        namespaces does not contain a determined skill, and treating it as
        isolation would be the kind of overstatement this module exists to
        avoid.
        """
        threshold = self._ORDER.get(minimum, 99)
        for runtime in self.available():
            if self._ORDER.get(runtime.trust_level(), -1) >= threshold:
                return runtime
        present = ", ".join(
            "%s(%s)" % (r.name, r.trust_level().value) for r in self.runtimes()
        )
        raise SandboxUnavailable(
            "no registered sandbox runtime meets the minimum isolation level %r; "
            "registered: %s. Refusing rather than running untrusted third-party "
            "skill code in the host process. Register a SandboxRuntime (container, "
            "microVM, or remote) to enable skill execution."
            % (minimum.value, present or "none")
        )

    def describe(self) -> list[dict[str, Any]]:
        return [r.describe() for r in self.runtimes()]

    def run(self, request: SandboxRequest, *, minimum: TrustLevel = TrustLevel.CONTAINER) -> SandboxResult:
        """Select a runtime and execute. Refuses when none qualifies."""
        return self.select(minimum=minimum).run(request)


def default_registry() -> SandboxRegistry:
    """The honest default: NOTHING can execute skill code on this host.

    An empty registry, not a stub runtime. A runtime whose ``run`` always
    refuses would be dead code — ``select`` would never hand it a request — and
    its refusal message would merely duplicate the one ``select`` already
    produces. The registry's own refusal names what is registered, what the
    minimum is, and what would fix it, so an operator is not left guessing.
    """
    return SandboxRegistry()
