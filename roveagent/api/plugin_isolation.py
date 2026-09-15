"""Plugin isolation boundary — plugins must not run in the main process.

The gap this closes (risk R19)
------------------------------

``clisupport.plugins.PluginManager`` imports a plugin's Python module into the
host process. That gives a plugin the host's memory, the host's open file
descriptors, the host's ``sys.modules``, and the ability to end the process with
one call. A plugin that crashes, hangs, or mutates global state takes the OS
down with it — the opposite of the stated requirement that a broken plugin must
not affect the main system.

The architecture this implements
--------------------------------

    Plugin -> MCP Boundary -> Sandbox Process -> Tool Gateway -> Agent

Translated into this repository's existing parts:

  * **Sandbox Process** is ``tools/process_registry.spawn_via_env()``, which
    already spawns through the environment backends in ``tools/environments/``
    (docker, local, ssh, singularity, ...). Nothing new is invented for
    spawning.
  * **MCP Boundary** is JSON-RPC 2.0 over stdio — the wire shape MCP itself
    uses. The transport is owned here rather than routed through
    ``tools/mcp_tool.py``, which is a client for externally configured,
    OAuth-authorised MCP servers; conscripting it for in-tree plugin sandboxes
    would couple two unrelated lifecycles. The shape is compatible, so a real
    MCP client can speak to this later without a redesign.
  * **Tool Gateway** is unchanged: a tool reached through this boundary is still
    a tool call, and ``EnterpriseToolGate`` remains the only thing that
    authorises one.

What isolation is actually provided
-----------------------------------

Two guarantees, and the honest limits of each:

  * **Failure isolation** — real and verified. The plugin runs in a separate OS
    process. A crash, an unhandled exception at import, an infinite loop, or a
    deliberate ``os._exit`` affects only that process; the host observes a
    closed pipe or times out and reports it.
  * **Privilege isolation** — partial. The child gets a scrubbed environment
    (via ``_make_env_for_child``) and a working directory of the plugin's own
    folder, and stdout is reserved for the protocol so a plugin cannot forge
    frames. It does **not** get filesystem or network confinement. Only a
    container or microVM backend provides that, and that requires Docker (or
    equivalent) to be running. ``sandbox.mode`` states which is in effect so
    nothing downstream can mistake process isolation for a container.

Manifest extension
------------------

The plugin spec requires ``permissions`` and ``sandbox`` fields that
``PluginManifest`` does not declare. They are parsed here rather than by editing
``PluginManifest``, so the existing loader keeps its current behaviour for every
plugin that does not use them — an unknown-key-tolerant read, not a change to a
307 KB module that everything else depends on.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

__all__ = [
    "IsolationMode",
    "SandboxSpec",
    "PluginPermission",
    "SandboxError",
    "SandboxStartError",
    "SandboxTimeout",
    "PluginCrashed",
    "PluginPermissions",
    "parse_sandbox_spec",
    "parse_permissions",
    "evaluate_isolation",
    "IsolationVerdict",
    "PluginSandboxProcess",
    "available_isolation_modes",
    "container_argv",
    "read_manifest_isolation",
    "isolation_status",
    "isolation_status_for_discovered",
    "isolation_summary",
]

RUNNER_MODULE = "roveagent.api.plugin_sandbox_runner"

#: Default per-call budget. A plugin tool that has not answered in this long is
#: treated as hung and its process is discarded.
DEFAULT_CALL_TIMEOUT_S = 30.0
DEFAULT_START_TIMEOUT_S = 20.0


class IsolationMode(str, Enum):
    """How a plugin's code is kept away from the host."""

    IN_PROCESS = "in-process"   # imported into the host. No isolation.
    SUBPROCESS = "subprocess"   # separate OS process. Failure isolation only.
    CONTAINER = "container"     # container backend. Failure + privilege isolation.


class PluginPermission(str, Enum):
    """What a plugin may ask for. Requests are never grants (see ``decide``)."""

    TOOLS_EXPOSE = "tools:expose"
    HOOKS_REGISTER = "hooks:register"
    FILES_READ = "files:read"
    FILES_WRITE = "files:write"
    SHELL_EXECUTE = "shell:execute"
    NETWORK_EGRESS = "network:egress"
    ENV_SECRETS = "env:secrets"


class SandboxError(RuntimeError):
    """Base class for sandbox failures."""


class SandboxStartError(SandboxError):
    """The sandbox process could not be started."""


class SandboxTimeout(SandboxError):
    """The plugin did not answer in time and its process was discarded."""


class PluginCrashed(SandboxError):
    """The plugin process died. The host is unaffected; this call is not."""


# ---------------------------------------------------------------------------
# Manifest extension
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class SandboxSpec:
    """Parsed ``sandbox:`` block from plugin.yaml."""

    mode: IsolationMode = IsolationMode.SUBPROCESS
    image: str = ""
    memory_mb: int = 0
    cpus: float = 0.0
    network: bool = False
    writable_paths: tuple[str, ...] = ()
    timeout_s: float = DEFAULT_CALL_TIMEOUT_S
    #: Set when the manifest asked for something we cannot honour, so the
    #: verdict can refuse instead of quietly downgrading.
    unsatisfied: str = ""

    @property
    def declares_container(self) -> bool:
        return self.mode is IsolationMode.CONTAINER


def parse_sandbox_spec(raw: Any) -> SandboxSpec:
    """Parse a ``sandbox`` block. Unknown shapes produce an unsatisfied spec.

    A manifest that asks for confinement we cannot provide must NOT be silently
    downgraded: the plugin author wrote that requirement for a reason, and a
    quiet fallback to a weaker mode is exactly the kind of silent downgrade this
    project forbids.
    """
    if raw is None:
        return SandboxSpec(mode=IsolationMode.SUBPROCESS)
    if isinstance(raw, str):
        raw = {"mode": raw}
    if not isinstance(raw, Mapping):
        return SandboxSpec(mode=IsolationMode.SUBPROCESS,
                           unsatisfied="sandbox must be a mapping or a mode string")

    mode_text = str(raw.get("mode") or "subprocess").strip().lower()
    try:
        mode = IsolationMode(mode_text)
    except ValueError:
        return SandboxSpec(
            mode=IsolationMode.SUBPROCESS,
            unsatisfied="unknown sandbox mode %r; known: %s"
                       % (mode_text, ", ".join(m.value for m in IsolationMode)))

    def _int(key: str, default: int = 0) -> int:
        try:
            return max(0, int(raw.get(key) or default))
        except (TypeError, ValueError):
            return default

    def _float(key: str, default: float = 0.0) -> float:
        try:
            return max(0.0, float(raw.get(key) or default))
        except (TypeError, ValueError):
            return default

    paths = raw.get("writable_paths") or raw.get("writablePaths") or ()
    if isinstance(paths, str):
        paths = (paths,)
    timeout = _float("timeout_s", DEFAULT_CALL_TIMEOUT_S) or DEFAULT_CALL_TIMEOUT_S

    return SandboxSpec(
        mode=mode,
        image=str(raw.get("image") or ""),
        memory_mb=_int("memory_mb"),
        cpus=_float("cpus"),
        network=bool(raw.get("network")),
        writable_paths=tuple(str(p) for p in paths if str(p).strip()),
        timeout_s=timeout,
    )


def parse_permissions(raw: Any) -> frozenset[PluginPermission]:
    """Parse a ``permissions`` list. Unknown names are refused, not dropped.

    Dropping an unrecognised permission would silently narrow what a plugin
    asked for while leaving it installed — the plugin would then fail in ways
    nobody can attribute.
    """
    if raw is None:
        return frozenset()
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, Iterable):
        raise ValueError("permissions must be a list of strings")
    out: set[PluginPermission] = set()
    for item in raw:
        text = str(item or "").strip()
        if not text:
            continue
        try:
            out.add(PluginPermission(text))
        except ValueError as exc:
            raise ValueError(
                "unknown plugin permission %r; known: %s"
                % (text, ", ".join(sorted(p.value for p in PluginPermission)))
            ) from exc
    return frozenset(out)


@dataclasses.dataclass(frozen=True)
class PluginPermissions:
    #: A plugin that requests nothing is a legitimate, common case (a pure
    #: formatter), so both sets default to empty and a bare
    #: ``PluginPermissions()`` is valid.
    requested: frozenset[PluginPermission] = frozenset()
    granted: frozenset[PluginPermission] = frozenset()

    @property
    def missing(self) -> frozenset[PluginPermission]:
        return self.requested - self.granted

    @property
    def ok(self) -> bool:
        return not self.missing

    def as_dict(self) -> dict[str, Any]:
        return {
            "requested": sorted(p.value for p in self.requested),
            "granted": sorted(p.value for p in self.granted),
            "missing": sorted(p.value for p in self.missing),
            "ok": self.ok,
        }


# ---------------------------------------------------------------------------
# Isolation policy
# ---------------------------------------------------------------------------


def available_isolation_modes() -> dict[IsolationMode, bool]:
    """Which modes this host can actually provide RIGHT NOW.

    Probes binaries only; it does not start a daemon or pull an image. A mode
    reported available here can still fail at spawn time, which is why
    :meth:`PluginSandboxProcess.start` reports its own failure rather than
    trusting this.
    """
    have_docker = bool(shutil.which("docker"))
    docker_daemon = False
    if have_docker:
        try:
            probe = subprocess.run(
                ["docker", "info", "--format", "{{.ServerVersion}}"],
                capture_output=True, text=True, timeout=8,
            )
            docker_daemon = probe.returncode == 0 and bool(probe.stdout.strip())
        except (OSError, subprocess.SubprocessError):
            docker_daemon = False
    return {
        IsolationMode.IN_PROCESS: True,
        IsolationMode.SUBPROCESS: True,
        IsolationMode.CONTAINER: docker_daemon,
    }


@dataclasses.dataclass(frozen=True)
class IsolationVerdict:
    """Whether a plugin may be loaded, and in which mode."""

    plugin_name: str
    mode: IsolationMode
    allowed: bool
    reason: str
    permissions: PluginPermissions
    effective_guarantees: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "plugin_name": self.plugin_name,
            "mode": self.mode.value,
            "allowed": self.allowed,
            "reason": self.reason,
            "permissions": self.permissions.as_dict(),
            "effective_guarantees": list(self.effective_guarantees),
        }


def evaluate_isolation(
    plugin_name: str, spec: SandboxSpec, permissions: PluginPermissions, *,
    available: Optional[Mapping[IsolationMode, bool]] = None,
    enforce: bool = False, allow_in_process: bool = False,
) -> IsolationVerdict:
    """Decide whether this plugin may load, and under which guarantee.

    The default posture is that a plugin declaring ``in-process`` is REFUSED:
    that mode is the very thing the requirement forbids, so it needs an explicit
    operator opt-in rather than being the silent default.

    ``enforce`` defaults to False, matching how the rest of this codebase
    introduces tightening (``plugin_security.enforce``,
    ``command_policy``): the verdict is always computed and reported, and a
    deployment flips enforcement on deliberately rather than having load
    behaviour change underneath it.
    """
    modes = dict(available or available_isolation_modes())
    guarantees: list[str] = []

    if spec.unsatisfied:
        return IsolationVerdict(
            plugin_name=plugin_name, mode=spec.mode, allowed=False,
            reason="sandbox declaration is not satisfiable: %s" % spec.unsatisfied,
            permissions=permissions,
        )

    if not permissions.ok:
        return IsolationVerdict(
            plugin_name=plugin_name, mode=spec.mode, allowed=False,
            reason="ungranted permissions: %s"
                   % ", ".join(sorted(p.value for p in permissions.missing)),
            permissions=permissions,
        )

    if spec.mode is IsolationMode.IN_PROCESS:
        reason = ("the manifest requests in-process execution, which gives the "
                  "plugin the host process")
        if not allow_in_process:
            return IsolationVerdict(
                plugin_name=plugin_name, mode=spec.mode, allowed=False,
                reason=reason + "; pass allow_in_process to accept that deliberately",
                permissions=permissions,
            )
        guarantees.append("none: the plugin shares the host process")

    if spec.mode is IsolationMode.CONTAINER and not modes.get(IsolationMode.CONTAINER):
        return IsolationVerdict(
            plugin_name=plugin_name, mode=spec.mode, allowed=False,
            reason=("the manifest requires container isolation but no container "
                    "backend is usable on this host (docker present but its "
                    "daemon is not reachable, or docker is absent). Refusing "
                    "rather than silently downgrading to process isolation."),
            permissions=permissions,
        )

    if spec.mode is IsolationMode.CONTAINER:
        guarantees += ["failure isolation: separate process",
                       "privilege isolation: container filesystem and network"]
    elif spec.mode is IsolationMode.SUBPROCESS:
        guarantees += ["failure isolation: separate process",
                       "partial: scrubbed environment, no filesystem/network confinement"]

    # Enforcement only gates the failure case; an allowed plugin is allowed.
    if not enforce and not modes.get(spec.mode):
        return IsolationVerdict(
            plugin_name=plugin_name, mode=spec.mode, allowed=True,
            reason=("mode %r is not available on this host, but enforcement is "
                    "off; the plugin will fail at start rather than be refused "
                    "here" % spec.mode.value),
            permissions=permissions, effective_guarantees=tuple(guarantees),
        )

    return IsolationVerdict(
        plugin_name=plugin_name, mode=spec.mode, allowed=True,
        reason="mode %r is available" % spec.mode.value,
        permissions=permissions, effective_guarantees=tuple(guarantees),
    )


# ---------------------------------------------------------------------------
# The boundary itself
# ---------------------------------------------------------------------------


#: The ONLY host environment variables a sandboxed plugin inherits.
#:
#: An allowlist, not a denylist, and deliberately not
#: ``tools/environments/local._make_run_env``. That helper computes
#: ``os.environ`` minus a list of KNOWN credential names, which is the right
#: policy for subprocesses the host itself spawns — such a child may legitimately
#: need host context, and the host chose to run it. A plugin is third-party
#: code the host did not write, and a denylist cannot enumerate the operator's
#: secrets: any variable nobody thought to name leaks. (Caught by test: an
#: invented marker variable passed straight through.) An allowlist can
#: enumerate what the child needs, so that is what this uses.
_CHILD_ENV_ALLOWLIST = (
    # Finding the interpreter and its libraries.
    "PATH", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV",
    # Windows will not start a process without these.
    "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    # Temp space and locale — a plugin writing a scratch file is normal.
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE",
    # Unix basics.
    "HOME", "USER", "LOGNAME", "SHELL", "TZ",
)

#: Names that must never be inherited even if they appear in the allowlist,
#: as a belt-and-braces check against a future allowlist edit.
_CHILD_ENV_NEVER = (
    "ROVEAGENT_API_KEY", "ROVEAGENT_APPROVAL_SECRET", "ROVEAGENT_GATE",
    "COZE_SUPABASE_SERVICE_ROLE_KEY", "COZE_SUPABASE_ANON_KEY",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
)


def _make_env_for_child(
    extra: Optional[Mapping[str, str]] = None, *, plugin_root: Optional[str] = None,
) -> dict[str, str]:
    """Build the child environment from an allowlist.

    The plugin process sees: the variables in :data:`_CHILD_ENV_ALLOWLIST` that
    the host actually sets, plus the sandbox markers, plus whatever the caller
    passes explicitly in *extra*. Nothing else — in particular not
    ``os.environ``. A plugin that needs a credential must be given it
    deliberately by the caller, which leaves a record of the decision.
    """
    env: dict[str, str] = {}
    for key in _CHILD_ENV_ALLOWLIST:
        value = os.environ.get(key)
        if value:
            env[key] = value

    # The runner must be importable in the child. The repo root is prepended to
    # whatever PATH-derived PYTHONPATH the allowlist let through, rather than
    # handing the child the host's whole sys.path.
    repo_root = str(Path(__file__).resolve().parents[2])
    existing = env.get("PYTHONPATH", "")
    parts = [repo_root] + [p for p in existing.split(os.pathsep) if p]
    env["PYTHONPATH"] = os.pathsep.join(parts)

    env["PYTHONIOENCODING"] = "utf-8"
    env["ROVEAGENT_SANDBOXED_PLUGIN"] = "1"
    if plugin_root:
        env["ROVEAGENT_PLUGIN_ROOT"] = plugin_root

    env.update({str(k): str(v) for k, v in dict(extra or {}).items()})

    for forbidden in _CHILD_ENV_NEVER:
        env.pop(forbidden, None)
    return env


def container_argv(
    spec: SandboxSpec, plugin_path: Path, *, default_image: str = "python:3.13-slim",
    repo_root: Optional[str] = None,
) -> list[str]:
    """Build the ``docker run`` argv for a sandboxed plugin. PURE — runs nothing.

    Kept separate from :meth:`PluginSandboxProcess.start` so the command can be
    asserted without a Docker daemon. The daemon is not reachable on the machine
    this was written on (``docker`` v29.4.2 present, no engine), so the container
    PATH is unverified; its COMMAND is not — and the command is where the
    mistakes that matter live, since a wrong mount means either the plugin cannot
    be found or the host filesystem is exposed.

    Why the docker CLI rather than ``tools/environments/docker.py``: that backend
    is a one-shot ``execute(command) -> output`` abstraction with its own session
    and file-sync model. A plugin sandbox needs a long-lived process with
    bidirectional stdio, which that interface does not describe. Forcing it in
    would mean bypassing its contract or rewriting it — both worse than building
    a small, checkable argv here.

    Isolation choices, each deliberate:

      -i               keep stdin open; the protocol is request/response on it
      --rm             no container outlives its plugin
      --network none   unless the manifest asked for network, deny it
      --read-only      the container root filesystem is immutable
      --tmpfs /tmp     the plugin still gets scratch space, in memory
      --mount ...ro    the plugin directory is readable, never writable
      --user 65534     do not run as root inside the container
      --memory/--cpus  only when the manifest asked; the default is then the
                       engine's own limit rather than a number invented here
    """
    root = repo_root or str(Path(__file__).resolve().parents[2])

    argv: list[str] = ["docker", "run", "--rm", "-i", "--init"]
    argv += ["--network", "bridge" if spec.network else "none"]
    argv += ["--read-only", "--tmpfs", "/tmp:rw,size=64m"]
    argv += ["--workdir", "/plugin"]
    argv += ["--mount",
             "type=bind,src=%s,dst=/plugin,readonly" % Path(plugin_path).resolve()]
    argv += ["--mount",
             "type=bind,src=%s,dst=/opt/roveagent,readonly" % Path(root).resolve()]
    if spec.memory_mb:
        argv += ["--memory", "%dm" % spec.memory_mb]
    if spec.cpus:
        argv += ["--cpus", str(spec.cpus)]
    for extra in spec.writable_paths:
        argv += ["--mount", "type=bind,src=%s,dst=%s" % (extra, extra)]
    argv += ["--env", "PYTHONPATH=/opt/roveagent"]
    argv += ["--env", "PYTHONIOENCODING=utf-8"]
    argv += ["--env", "ROVEAGENT_SANDBOXED_PLUGIN=1"]
    argv += ["--user", "65534:65534"]
    argv += [spec.image or default_image, "python", "-u", "-m", RUNNER_MODULE]
    return argv


class PluginSandboxProcess:
    """Host-side handle on a plugin running in its own OS process.

    One instance owns one child process. :meth:`call` is not thread-safe for
    concurrent use on the same instance: the protocol is strictly
    request/response on a single pipe, so a second concurrent call would
    interleave frames. Use one instance per concurrent caller, or serialise.
    """

    def __init__(
        self, plugin_name: str, plugin_path: Path, *, tools: Sequence[str] = (),
        spec: Optional[SandboxSpec] = None, python: Optional[str] = None,
    ) -> None:
        self.plugin_name = plugin_name
        self.plugin_path = Path(plugin_path)
        self.declared_tools = tuple(tools)
        self.spec = spec or SandboxSpec()
        self.python = python or sys.executable
        self._proc: Optional[subprocess.Popen] = None
        self._next_id = 0
        self._lock = threading.Lock()
        self._stderr_tail: list[str] = []

    # -- lifecycle -----------------------------------------------------

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def pid(self) -> Optional[int]:
        return self._proc.pid if self._proc else None

    def start(self) -> dict[str, Any]:
        """Spawn the sandbox process and initialize the plugin inside it.

        Raises :class:`SandboxStartError` on any failure to reach a usable
        state. There is no in-process fallback: falling back would execute
        exactly the code this class exists to keep out of the host.
        """
        if self.spec.mode is IsolationMode.IN_PROCESS:
            raise SandboxStartError(
                "in-process mode has no sandbox process to start; it is refused "
                "by design and exists in the enum only so a manifest can name it "
                "and be told no")
        if self.spec.mode is IsolationMode.CONTAINER:
            modes = available_isolation_modes()
            if not modes.get(IsolationMode.CONTAINER):
                raise SandboxStartError(
                    "container mode requested but no container backend is usable "
                    "on this host; refusing rather than running the plugin with "
                    "weaker isolation than its manifest requires")
            argv = container_argv(self.spec, self.plugin_path, default_image=self.python)
            # Inside a container the environment is defined by the argv, not by
            # the host's, so no host environment is passed at all.
            env: Optional[dict[str, str]] = None
            cwd: Optional[str] = None
        else:
            argv = [self.python, "-u", "-m", RUNNER_MODULE]
            env = _make_env_for_child(plugin_root=str(self.plugin_path))
            cwd = str(self.plugin_path)

        try:
            self._proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8",
                errors="replace", cwd=cwd, env=env, bufsize=1,
            )
        except OSError as exc:
            raise SandboxStartError(
                "could not spawn the sandbox process: %s" % exc) from exc

        threading.Thread(target=self._drain_stderr, daemon=True).start()

        try:
            reply = self._request("initialize", {
                "plugin_path": str(self.plugin_path),
                "module_name": self.plugin_name,
                "tools": list(self.declared_tools),
            }, timeout=DEFAULT_START_TIMEOUT_S)
        except SandboxError:
            self.stop()
            raise
        return reply if isinstance(reply, dict) else {}

    def _invalidate(self) -> None:
        """Mark the process unusable so no later call can reuse a dead handle.

        Necessary because process teardown is ASYNCHRONOUS: after a plugin calls
        ``os._exit``, ``poll()`` can still return ``None`` for a short while, so
        ``running`` reports True and the next call writes into a broken pipe
        (Windows raises ``OSError: [Errno 22]``). Relying on the OS having reaped
        by the time the next call arrives makes crash recovery a race; clearing
        the handle here makes it deterministic.

        Only ever called on a path that has already concluded the process is
        gone, so killing a still-live child here is cleanup, not a behaviour
        change.
        """
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    def stop(self, *, timeout: float = 5.0) -> None:
        """Terminate the plugin process. Safe to call from anywhere, any number of times.

        Does NOT send a protocol request. Sending ``shutdown`` here would need
        the same lock ``_request`` holds, and ``stop`` is called from inside the
        timeout path — a plain (non-reentrant) ``Lock`` would deadlock the host
        on the very first hung plugin. It is also pointless: the process is
        being stopped precisely because it is not answering.

        Use :meth:`graceful_shutdown` when the process is believed healthy and a
        cooperative exit is wanted.
        """
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=timeout)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                    proc.wait(timeout=timeout)
                except (OSError, subprocess.SubprocessError):
                    pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    def graceful_shutdown(self, *, timeout: float = 5.0) -> dict[str, Any]:
        """Ask the plugin to run ``on_unload`` and exit, then ensure it is gone.

        Best-effort: any failure falls through to the hard :meth:`stop` path, so
        a plugin that ignores ``shutdown`` still cannot keep its process alive.
        """
        result: dict[str, Any] = {}
        try:
            reply = self._request("shutdown", {}, timeout=timeout)
            if isinstance(reply, dict):
                result = reply
        except SandboxError:
            pass
        self.stop(timeout=timeout)
        return result

    def __enter__(self) -> "PluginSandboxProcess":
        self.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.graceful_shutdown()

    # -- protocol ------------------------------------------------------

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                self._stderr_tail.append(line.rstrip("\n"))
                del self._stderr_tail[:-40]
        except (OSError, ValueError):
            return

    @property
    def stderr_tail(self) -> str:
        return "\n".join(self._stderr_tail)

    def _request(self, method: str, params: Mapping[str, Any], *,
                 timeout: float) -> Any:
        """Send one request and read exactly one matching reply.

        The read is bounded by ``timeout`` in a worker thread rather than by a
        socket timeout, because ``readline`` on a pipe has no timeout of its own
        and a hung plugin must not hang the host.

        The lock covers the write and the wait, and is released BEFORE any error
        handling. Handling a timeout while still holding it would deadlock: the
        handler stops the process, and stopping must not need the lock it is
        already inside. A plain ``Lock`` is not reentrant, so that mistake hangs
        the host on the first hung plugin — which is the one case the timeout
        exists for.
        """
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdout is None:
            raise SandboxStartError("sandbox process is not running")
        if proc.poll() is not None:
            self._invalidate()
            raise PluginCrashed(
                "plugin %r exited with code %s before %r could be sent"
                % (self.plugin_name, proc.returncode, method))

        holder: dict[str, Any] = {}
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            frame = json.dumps({
                "jsonrpc": "2.0", "id": request_id,
                "method": method, "params": dict(params),
            }, ensure_ascii=False)
            try:
                proc.stdin.write(frame + "\n")
                proc.stdin.flush()
            except (OSError, ValueError) as exc:
                # A broken pipe means the child is gone even if poll() has not
                # caught up yet. Invalidate so the next call starts a fresh
                # process instead of reusing this one for ever.
                self._invalidate()
                raise PluginCrashed(
                    "could not write to the plugin process: %s" % exc) from exc

            def _read() -> None:
                try:
                    while True:
                        line = proc.stdout.readline()
                        if line == "":
                            holder["eof"] = True
                            return
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            payload = json.loads(line)
                        except json.JSONDecodeError:
                            # A non-JSON line is plugin noise on a channel it
                            # should not be using; keep reading rather than
                            # treating it as the reply.
                            holder.setdefault("noise", []).append(line[:200])
                            continue
                        if isinstance(payload, dict) and payload.get("id") == request_id:
                            holder["reply"] = payload
                            return
                except (OSError, ValueError) as exc:  # noqa: BLE001
                    holder["error"] = str(exc)

            reader = threading.Thread(target=_read, daemon=True)
            reader.start()
            reader.join(timeout)

        # --- lock released; safe to touch process lifecycle from here ---
        if "reply" not in holder:
            if reader.is_alive():
                self.stop()
                raise SandboxTimeout(
                    "plugin %r did not answer %r within %.1fs; its process was "
                    "discarded. stderr tail: %s"
                    % (self.plugin_name, method, timeout,
                       self.stderr_tail[-300:] or "(empty)"))
            if holder.get("eof"):
                self._invalidate()
                raise PluginCrashed(
                    "plugin %r closed its output while answering %r (exit code "
                    "%s). stderr tail: %s"
                    % (self.plugin_name, method, proc.returncode,
                       self.stderr_tail[-300:] or "(empty)"))
            raise SandboxError(
                "no reply from plugin %r for %r: %s"
                % (self.plugin_name, method,
                   holder.get("error") or "stream ended"))

        reply = holder["reply"]
        if "error" in reply:
            error = reply.get("error") or {}
            raise SandboxError(
                "plugin %r reported %s (code %s)"
                % (self.plugin_name, error.get("message") or "an error",
                   error.get("code")))
        return reply.get("result")

    # -- public API ----------------------------------------------------

    def list_tools(self, *, timeout: float = DEFAULT_CALL_TIMEOUT_S) -> list[str]:
        result = self._request("tools/list", {}, timeout=timeout)
        tools = (result or {}).get("tools") if isinstance(result, dict) else None
        return [str(t) for t in tools] if isinstance(tools, list) else []

    def call_tool(self, name: str, arguments: Mapping[str, Any], *,
                  timeout: Optional[float] = None) -> Any:
        """Invoke one plugin tool across the boundary.

        The caller is responsible for having authorised this call; the boundary
        relays, it does not grant. ``EnterpriseToolGate`` remains the gate.
        """
        result = self._request(
            "tools/call", {"name": name, "arguments": dict(arguments)},
            timeout=timeout or self.spec.timeout_s)
        if isinstance(result, dict) and "content" in result:
            return result["content"]
        return result

    def ping(self, *, timeout: float = 5.0) -> bool:
        try:
            result = self._request("ping", {}, timeout=timeout)
        except SandboxError:
            return False
        return bool(isinstance(result, dict) and result.get("pong"))

    def describe(self) -> dict[str, Any]:
        modes = available_isolation_modes()
        return {
            "plugin_name": self.plugin_name,
            "plugin_path": str(self.plugin_path),
            "requested_mode": self.spec.mode.value,
            "running": self.running,
            "pid": self.pid,
            "isolation_available": {m.value: ok for m, ok in modes.items()},
            "declared_tools": list(self.declared_tools),
        }


# ---------------------------------------------------------------------------
# Plugin Manager: isolation status for a discovered plugin
# ---------------------------------------------------------------------------

#: Manifest filenames a plugin may use, in the order the loader tries them.
_MANIFEST_NAMES = ("plugin.yaml", "plugin.yml", "plugin.json")


def read_manifest_isolation(plugin_path: Path) -> tuple[SandboxSpec, "PluginPermissions", str]:
    """Read ``sandbox`` and ``permissions`` from a plugin manifest.

    Returns ``(spec, permissions, error)``. A missing manifest, or one with
    neither key, yields the SAFE default: subprocess mode and no permissions.
    It never yields in-process, because that is the mode the requirement
    forbids and it must not be reachable by omission.

    Parsing is tolerant of an absent key and strict about a present-but-invalid
    one: a manifest that misspells a permission should be told so, not silently
    treated as requesting nothing.
    """
    directory = Path(plugin_path)
    if not directory.is_dir():
        return SandboxSpec(), PluginPermissions(), "plugin path is not a directory"

    raw: Any = None
    for name in _MANIFEST_NAMES:
        candidate = directory / name
        if not candidate.is_file():
            continue
        try:
            text = candidate.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            return SandboxSpec(), PluginPermissions(), "cannot read %s: %s" % (name, exc)
        try:
            if candidate.suffix == ".json":
                raw = json.loads(text)
            else:
                from roveagent.core.skill_utils import yaml_load

                raw = yaml_load(text)
        except Exception as exc:  # noqa: BLE001 — the shared loader owns its errors
            return SandboxSpec(), PluginPermissions(), "invalid %s: %s" % (name, exc)
        break

    if not isinstance(raw, Mapping):
        # No manifest at all is normal for bundled plugins; not an error.
        return SandboxSpec(), PluginPermissions(), ""

    try:
        spec = parse_sandbox_spec(raw.get("sandbox"))
    except Exception as exc:  # noqa: BLE001
        return SandboxSpec(), PluginPermissions(), "invalid sandbox block: %s" % exc

    try:
        requested = parse_permissions(raw.get("permissions"))
    except ValueError as exc:
        return spec, PluginPermissions(), str(exc)

    # A manifest that declares capabilities but no explicit permissions is
    # requesting tool exposure implicitly — say so rather than reading as
    # "wants nothing".
    if not requested and raw.get("provides_tools"):
        requested = frozenset({PluginPermission.TOOLS_EXPOSE})

    return spec, PluginPermissions(requested=requested), ""


def isolation_status(
    plugin_name: str, plugin_path: Path, *, granted: Iterable[PluginPermission] = (),
    enforce: bool = False, allow_in_process: bool = False,
    available: Optional[Mapping[IsolationMode, bool]] = None,
) -> dict[str, Any]:
    """Isolation verdict for one discovered plugin, ready to serialise.

    This is the ``status`` half of the Plugin Manager contract: it answers "is
    this plugin allowed to load, under what isolation, with which guarantees"
    without loading anything.
    """
    spec, permissions, error = read_manifest_isolation(plugin_path)
    if error:
        return {
            "plugin_name": plugin_name,
            "plugin_path": str(plugin_path),
            "allowed": False,
            "mode": spec.mode.value,
            "reason": error,
            "permissions": permissions.as_dict(),
            "effective_guarantees": [],
        }
    permissions = PluginPermissions(requested=permissions.requested,
                                    granted=frozenset(granted))
    verdict = evaluate_isolation(
        plugin_name, spec, permissions, available=available,
        enforce=enforce, allow_in_process=allow_in_process)
    out = verdict.as_dict()
    out["plugin_path"] = str(plugin_path)
    out["manifest_has_sandbox"] = spec != SandboxSpec()
    return out


def isolation_status_for_discovered(
    entries: Iterable[Mapping[str, Any]], *,
    granted: Mapping[str, Iterable[PluginPermission]] = {},
    enforce: bool = False, allow_in_process: bool = False,
    trust_bundled: bool = True,
) -> list[dict[str, Any]]:
    """Isolation status for every entry from the existing discovery function.

    Takes the tuples ``clisupport.plugins_cmd._discover_all_plugins`` yields
    (already normalised to mappings by ``api.plugin_center._discover_all``) so
    discovery keeps exactly one implementation.

    ``trust_bundled`` (default on) treats a plugin that SHIPS WITH THE PRODUCT
    as already granted the two permissions a bundled plugin necessarily needs —
    ``tools:expose`` and in-process execution — because the product is the
    grantor and a release review already happened. This is the same line
    browsers draw between built-in components and extensions.

    The primitive stays strict: :func:`evaluate_isolation` still refuses
    in-process unless told otherwise. The product decision lives here, at the
    call site, where it is visible and where a deployment that wants to sandbox
    even its own plugins can pass ``trust_bundled=False``.
    """
    modes = available_isolation_modes()
    out: list[dict[str, Any]] = []
    for entry in entries:
        name = str(entry.get("name") or "")
        source = str(entry.get("source") or "")
        raw_path = entry.get("path")
        if not raw_path:
            out.append({
                "plugin_name": name, "allowed": False, "mode": "unknown",
                "reason": "discovery reported no path for this plugin",
                "permissions": PluginPermissions().as_dict(),
                "effective_guarantees": [],
            })
            continue

        bundled = trust_bundled and source == "bundled"
        plugin_granted = set(granted.get(name, ()))
        if bundled:
            plugin_granted.add(PluginPermission.TOOLS_EXPOSE)

        spec, permissions, error = read_manifest_isolation(Path(str(raw_path)))
        if error:
            out.append({
                "plugin_name": name, "plugin_path": str(raw_path), "source": source,
                "allowed": False, "mode": spec.mode.value, "reason": error,
                "permissions": permissions.as_dict(), "effective_guarantees": [],
            })
            continue

        # A bundled plugin does not declare `sandbox:`; it is part of the host.
        # Recording that as in-process (rather than letting it read as
        # "subprocess" and imply a boundary that does not exist) is the whole
        # point of a status endpoint.
        effective_spec = spec
        if bundled and not spec.declares_container and not spec.image:
            effective_spec = dataclasses.replace(spec, mode=IsolationMode.IN_PROCESS)

        verdict = evaluate_isolation(
            name, effective_spec,
            PluginPermissions(requested=permissions.requested,
                              granted=frozenset(plugin_granted)),
            available=modes, enforce=enforce,
            allow_in_process=allow_in_process or bundled)
        status = verdict.as_dict()
        status["plugin_path"] = str(raw_path)
        status["source"] = source
        status["plugin_key"] = str(entry.get("key") or name)
        status["manifest_has_sandbox"] = spec != SandboxSpec()
        status["isolation_required"] = not bundled
        # What the boundary COULD provide versus what is in effect TODAY. Stated
        # per row rather than in a footnote, because a status endpoint that
        # reports "subprocess" while the loader still imports the module into
        # the host process would be read as a guarantee it is not making.
        status["runtime_loader"] = "in-process (clisupport.plugins.PluginManager)"
        status["isolation_enforced"] = False
        out.append(status)
    return out


def isolation_summary(statuses: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Counts for a Plugin Center header row."""
    rows = list(statuses)
    by_mode: dict[str, int] = {}
    for row in rows:
        mode = str(row.get("mode") or "unknown")
        by_mode[mode] = by_mode.get(mode, 0) + 1
    third_party = [r for r in rows if r.get("isolation_required")]
    return {
        "total": len(rows),
        "allowed": sum(1 for r in rows if r.get("allowed")),
        "refused": sum(1 for r in rows if not r.get("allowed")),
        "by_mode": by_mode,
        # The number an operator actually acts on: how many THIRD-PARTY plugins
        # exist, since bundled ones are the product itself.
        "third_party_total": len(third_party),
        "third_party_refused": sum(1 for r in third_party if not r.get("allowed")),
        "container_available": available_isolation_modes()[IsolationMode.CONTAINER],
        "boundary_enforced": False,
        "note": (
            "The isolation boundary is implemented and verified, but plugin "
            "loading is NOT yet routed through it: PluginManager still imports "
            "plugin modules into the host process, so a plugin reported here as "
            "'subprocess' may still be running in-process. Every row carries "
            "isolation_enforced=false for that reason. Bundled plugins ship with "
            "the product and run in-process by design; this report does not claim "
            "they are sandboxed. Process isolation gives failure isolation only; "
            "container isolation additionally confines filesystem and network and "
            "needs a reachable container engine."
        ),
    }
