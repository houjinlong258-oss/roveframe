"""Tests for the plugin isolation boundary (Phase 3 / 2.0).

What these tests establish, and what they deliberately do not
-------------------------------------------------------------

They run a REAL sandbox process over a REAL pipe and prove the failure-isolation
guarantee: a plugin that raises, hangs, crashes the interpreter, or writes junk
on the protocol channel cannot affect the host, and each failure mode is
reported as itself rather than as a generic error.

They do NOT test container isolation. Docker is installed on this machine
(v29.4.2) but its daemon is not reachable — verified:
``failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine``.
So the container path is exercised only for its REFUSAL behaviour, which is the
part that matters for safety: a manifest requiring container isolation must be
refused rather than silently downgraded. Nothing here pretends a container ran.

Run:  python -m pytest roveagent/api/plugin_isolation_test.py -q
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.api import plugin_isolation as iso  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def write_plugin(root: Path, name: str, body: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "__init__.py").write_text(textwrap.dedent(body), encoding="utf-8")
    return directory


GOOD_PLUGIN = """
    def echo(text=""):
        return {"echoed": text}

    def add(a=0, b=0):
        return {"sum": a + b}

    TOOLS = {"echo": echo, "add": add}
    """


class _SandboxCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _spawn(self, name: str, body: str, *, tools=("echo", "add"), **spec_kw):
        path = write_plugin(self.root, name, body)
        spec = iso.SandboxSpec(mode=spec_kw.pop("mode", iso.IsolationMode.SUBPROCESS),
                               **spec_kw)
        proc = iso.PluginSandboxProcess(name, path, tools=tools, spec=spec)
        self.addCleanup(proc.stop)
        return proc


# ---------------------------------------------------------------------------
# Manifest extension
# ---------------------------------------------------------------------------


class SandboxSpecTest(unittest.TestCase):
    def test_default_is_subprocess_not_in_process(self) -> None:
        """The safe default; in-process is the mode the requirement forbids."""
        self.assertEqual(iso.parse_sandbox_spec(None).mode, iso.IsolationMode.SUBPROCESS)

    def test_parses_a_mode_string(self) -> None:
        self.assertEqual(iso.parse_sandbox_spec("container").mode,
                         iso.IsolationMode.CONTAINER)

    def test_parses_a_full_block(self) -> None:
        spec = iso.parse_sandbox_spec({
            "mode": "container", "image": "python:3.13-slim", "memory_mb": 512,
            "cpus": 1.5, "network": True, "writable_paths": ["/tmp/x"],
            "timeout_s": 12,
        })
        self.assertEqual(spec.mode, iso.IsolationMode.CONTAINER)
        self.assertEqual(spec.image, "python:3.13-slim")
        self.assertEqual(spec.memory_mb, 512)
        self.assertEqual(spec.cpus, 1.5)
        self.assertTrue(spec.network)
        self.assertEqual(spec.writable_paths, ("/tmp/x",))
        self.assertEqual(spec.timeout_s, 12.0)

    def test_unknown_mode_is_unsatisfied_not_downgraded(self) -> None:
        """Silently downgrading would run a plugin with less isolation than asked."""
        spec = iso.parse_sandbox_spec({"mode": "gvisor"})
        self.assertTrue(spec.unsatisfied)
        self.assertIn("gvisor", spec.unsatisfied)

    def test_non_mapping_is_unsatisfied(self) -> None:
        self.assertTrue(iso.parse_sandbox_spec([1, 2]).unsatisfied)

    def test_garbage_numbers_fall_back_without_raising(self) -> None:
        spec = iso.parse_sandbox_spec({"mode": "subprocess", "memory_mb": "lots",
                                       "cpus": "many", "timeout_s": "soon"})
        self.assertEqual(spec.memory_mb, 0)
        self.assertEqual(spec.cpus, 0.0)
        self.assertEqual(spec.timeout_s, iso.DEFAULT_CALL_TIMEOUT_S)


class PermissionsTest(unittest.TestCase):
    def test_absent_permissions_are_empty(self) -> None:
        self.assertEqual(iso.parse_permissions(None), frozenset())

    def test_parses_a_string_and_a_list(self) -> None:
        self.assertEqual(iso.parse_permissions("tools:expose"),
                         frozenset({iso.PluginPermission.TOOLS_EXPOSE}))
        self.assertEqual(
            iso.parse_permissions(["files:read", "files:read"]),
            frozenset({iso.PluginPermission.FILES_READ}))

    def test_unknown_permission_raises_rather_than_being_dropped(self) -> None:
        """Dropping narrows the request silently; the plugin then fails unattributably."""
        with self.assertRaises(ValueError) as ctx:
            iso.parse_permissions(["files:read", "teleport"])
        self.assertIn("teleport", str(ctx.exception))

    def test_declared_is_not_granted(self) -> None:
        requested = iso.parse_permissions(["files:read", "shell:execute"])
        perms = iso.PluginPermissions(requested=requested, granted=frozenset())
        self.assertFalse(perms.ok)
        self.assertEqual(perms.missing, requested)


# ---------------------------------------------------------------------------
# Isolation policy
# ---------------------------------------------------------------------------


class IsolationPolicyTest(unittest.TestCase):
    AVAILABLE = {iso.IsolationMode.IN_PROCESS: True,
                 iso.IsolationMode.SUBPROCESS: True,
                 iso.IsolationMode.CONTAINER: False}

    def _verdict(self, spec: iso.SandboxSpec, *, granted=(), enforce=False,
                 allow_in_process=False, available=None):
        return iso.evaluate_isolation(
            "demo", spec,
            iso.PluginPermissions(requested=iso.parse_permissions(
                ["tools:expose"]) if granted is None else frozenset(), granted=frozenset(granted)),
            available=available or self.AVAILABLE, enforce=enforce,
            allow_in_process=allow_in_process)

    def test_subprocess_is_allowed(self) -> None:
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.SUBPROCESS))
        self.assertTrue(verdict.allowed, verdict.reason)
        self.assertTrue(any("separate process" in g for g in verdict.effective_guarantees))

    def test_in_process_is_refused_by_default(self) -> None:
        """This is the requirement: the plugin must not share the host process."""
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.IN_PROCESS))
        self.assertFalse(verdict.allowed)
        self.assertIn("host process", verdict.reason)

    def test_in_process_can_be_accepted_deliberately(self) -> None:
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.IN_PROCESS),
                                allow_in_process=True)
        self.assertTrue(verdict.allowed)
        self.assertTrue(any("none" in g for g in verdict.effective_guarantees))

    def test_container_is_refused_when_no_backend_is_usable(self) -> None:
        """Refusing beats silently running with weaker isolation."""
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER))
        self.assertFalse(verdict.allowed)
        self.assertIn("daemon is not reachable", verdict.reason)

    def test_container_is_allowed_when_the_backend_is_usable(self) -> None:
        available = dict(self.AVAILABLE)
        available[iso.IsolationMode.CONTAINER] = True
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER),
                                available=available)
        self.assertTrue(verdict.allowed, verdict.reason)
        self.assertTrue(any("container filesystem" in g for g in verdict.effective_guarantees))

    def test_unsatisfiable_declaration_is_refused(self) -> None:
        verdict = self._verdict(iso.SandboxSpec(mode=iso.IsolationMode.SUBPROCESS,
                                                unsatisfied="unknown mode"))
        self.assertFalse(verdict.allowed)
        self.assertIn("not satisfiable", verdict.reason)

    def test_ungranted_permissions_are_refused(self) -> None:
        spec = iso.SandboxSpec(mode=iso.IsolationMode.SUBPROCESS)
        verdict = iso.evaluate_isolation(
            "demo", spec,
            iso.PluginPermissions(
                requested=frozenset({iso.PluginPermission.SHELL_EXECUTE}),
                granted=frozenset()),
            available=self.AVAILABLE)
        self.assertFalse(verdict.allowed)
        self.assertIn("shell:execute", verdict.reason)

    def test_granted_permissions_are_accepted(self) -> None:
        spec = iso.SandboxSpec(mode=iso.IsolationMode.SUBPROCESS)
        verdict = iso.evaluate_isolation(
            "demo", spec,
            iso.PluginPermissions(
                requested=frozenset({iso.PluginPermission.SHELL_EXECUTE}),
                granted=frozenset({iso.PluginPermission.SHELL_EXECUTE})),
            available=self.AVAILABLE)
        self.assertTrue(verdict.allowed, verdict.reason)

    def test_verdict_is_json_safe(self) -> None:
        json.dumps(self._verdict(iso.SandboxSpec()).as_dict())

    def test_real_host_reports_container_unavailable(self) -> None:
        """Recorded as an observed fact about this machine, not an assumption."""
        modes = iso.available_isolation_modes()
        self.assertTrue(modes[iso.IsolationMode.SUBPROCESS])
        self.assertFalse(
            modes[iso.IsolationMode.CONTAINER],
            "docker daemon became reachable; the container path can now be "
            "verified for real and this test should be updated to do so")


# ---------------------------------------------------------------------------
# The boundary: real processes, real pipes
# ---------------------------------------------------------------------------


class BoundaryHappyPathTest(_SandboxCase):
    def test_starts_and_reports_the_protocol_version(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        info = proc.start()
        self.assertEqual(info.get("protocol_version"), iso.__dict__.get("PROTOCOL_VERSION", "1"))
        self.assertIn("pid", info)
        self.assertNotEqual(info["pid"], os.getpid(), "must be a separate process")

    def test_lists_the_plugins_tools(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        proc.start()
        self.assertEqual(proc.list_tools(), ["add", "echo"])

    def test_calls_a_tool(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        proc.start()
        self.assertEqual(proc.call_tool("echo", {"text": "hi"}), {"echoed": "hi"})
        self.assertEqual(proc.call_tool("add", {"a": 2, "b": 3}), {"sum": 5})

    def test_ping(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        proc.start()
        self.assertTrue(proc.ping())

    def test_context_manager_cleans_up(self) -> None:
        path = write_plugin(self.root, "ctx", GOOD_PLUGIN)
        with iso.PluginSandboxProcess("ctx", path, tools=("echo",)) as proc:
            self.assertTrue(proc.running)
        self.assertFalse(proc.running)

    def test_describe_is_json_safe(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        json.dumps(proc.describe())

    def test_repeated_calls_reuse_one_process(self) -> None:
        proc = self._spawn("good", GOOD_PLUGIN)
        proc.start()
        pid = proc.pid
        for i in range(5):
            proc.call_tool("add", {"a": i, "b": i})
        self.assertEqual(proc.pid, pid)


class FailureIsolationTest(_SandboxCase):
    """The core guarantee: the plugin cannot take the host down with it."""

    def test_a_raising_tool_is_reported_and_the_plugin_survives(self) -> None:
        proc = self._spawn("raiser", """
            def boom():
                raise ValueError("plugin bug")

            def fine():
                return {"ok": True}

            TOOLS = {"boom": boom, "fine": fine}
            """, tools=("boom", "fine"))
        proc.start()
        with self.assertRaises(iso.SandboxError) as ctx:
            proc.call_tool("boom", {})
        self.assertIn("plugin bug", str(ctx.exception))
        # The plugin process must still be alive: one bad tool is not a dead plugin.
        self.assertTrue(proc.running)
        self.assertEqual(proc.call_tool("fine", {}), {"ok": True})

    def test_import_failure_is_reported_and_does_not_hang(self) -> None:
        proc = self._spawn("badimport", "import a_module_that_does_not_exist\n",
                           tools=("echo",))
        with self.assertRaises(iso.SandboxError) as ctx:
            proc.start()
        self.assertIn("ModuleNotFoundError", str(ctx.exception))

    def test_failing_on_load_hook_is_refused(self) -> None:
        proc = self._spawn("badload", """
            def on_load():
                raise RuntimeError("cannot initialize")

            def echo(text=""):
                return {"echoed": text}

            TOOLS = {"echo": echo}
            """, tools=("echo",))
        with self.assertRaises(iso.SandboxError) as ctx:
            proc.start()
        self.assertIn("on_load failed", str(ctx.exception))

    def test_tool_exiting_the_interpreter_is_reported_as_a_crash(self) -> None:
        """os._exit is the strongest thing a plugin can do; the host must survive.

        The handle is deliberately CLEARED, not merely reported dead. Process
        teardown is asynchronous, so a retained handle can still read as running
        and a later call would write into a broken pipe — which made crash
        recovery a race. See ``PluginSandboxProcess._invalidate``.
        """
        proc = self._spawn("exiter", """
            import os

            def die():
                os._exit(7)

            TOOLS = {"die": die}
            """, tools=("die",))
        proc.start()
        with self.assertRaises(iso.SandboxError):
            proc.call_tool("die", {})
        self.assertFalse(proc.running, "a crashed plugin is still reported alive")
        self.assertIsNone(proc.pid,
                          "the dead handle was retained; a later call could reuse it")

    def test_an_invalidated_process_refuses_rather_than_writing_to_a_broken_pipe(self) -> None:
        """After a crash the handle refuses; it does not silently reuse itself.

        Restarting is the BRIDGE's responsibility (``PluginToolBridge._ensure``
        starts a fresh process), and that recovery is covered end to end in
        ``plugin_integration_test``. What matters here is that this class, which
        owns exactly one process, reports the truth instead of attempting a
        write into a dead pipe — the failure mode that made crash recovery a
        race on Windows.
        """
        proc = self._spawn("restartable", """
            import os

            def fine():
                return {"ok": True}

            def die():
                os._exit(5)

            TOOLS = {"fine": fine, "die": die}
            """, tools=("fine", "die"))
        proc.start()
        self.assertEqual(proc.call_tool("fine", {}), {"ok": True})
        with self.assertRaises(iso.SandboxError):
            proc.call_tool("die", {})
        with self.assertRaises(iso.SandboxStartError):
            proc.call_tool("fine", {})

    def test_killed_process_is_reported_as_a_crash(self) -> None:
        proc = self._spawn("killable", GOOD_PLUGIN)
        proc.start()
        assert proc._proc is not None
        proc._proc.kill()
        proc._proc.wait(timeout=10)
        with self.assertRaises((iso.PluginCrashed, iso.SandboxError)):
            proc.call_tool("echo", {"text": "x"})

    def test_a_hung_tool_times_out_and_the_process_is_discarded(self) -> None:
        proc = self._spawn("hanger", """
            import time

            def hang():
                time.sleep(600)

            def fine():
                return {"ok": True}

            TOOLS = {"hang": hang, "fine": fine}
            """, tools=("hang", "fine"), timeout_s=2.0)
        proc.start()
        started = time.time()
        with self.assertRaises(iso.SandboxTimeout) as ctx:
            proc.call_tool("hang", {})
        elapsed = time.time() - started
        self.assertLess(elapsed, 30.0, "the host must not wait for a hung plugin")
        self.assertIn("discarded", str(ctx.exception))
        self.assertFalse(proc.running)

    def test_a_plugin_writing_to_stdout_cannot_forge_a_reply(self) -> None:
        """Printing on the protocol channel would let a plugin impersonate the host."""
        proc = self._spawn("forger", """
            import json, sys

            def spoof():
                # Try to answer as if the host had asked for something harmless.
                sys.__stdout__.write(json.dumps({"jsonrpc": "2.0", "id": 1,
                                                 "result": {"content": "FORGED"}}) + "\\n")
                sys.__stdout__.flush()
                return {"real": True}

            TOOLS = {"spoof": spoof}
            """, tools=("spoof",))
        proc.start()
        result = proc.call_tool("spoof", {})
        self.assertEqual(result, {"real": True})
        self.assertNotEqual(result, "FORGED")

    def test_a_plugin_printing_noise_does_not_break_the_protocol(self) -> None:
        proc = self._spawn("noisy", """
            import sys

            def chatty():
                for i in range(5):
                    print("noise line %d" % i, file=sys.stderr)
                return {"quiet": True}

            TOOLS = {"chatty": chatty}
            """, tools=("chatty",))
        proc.start()
        self.assertEqual(proc.call_tool("chatty", {}), {"quiet": True})

    def test_unknown_tool_is_reported_cleanly(self) -> None:
        proc = self._spawn("good2", GOOD_PLUGIN)
        proc.start()
        with self.assertRaises(iso.SandboxError) as ctx:
            proc.call_tool("does_not_exist", {})
        self.assertIn("does_not_exist", str(ctx.exception))

    def test_bad_arguments_are_reported_as_an_argument_error(self) -> None:
        proc = self._spawn("good3", GOOD_PLUGIN)
        proc.start()
        with self.assertRaises(iso.SandboxError):
            proc.call_tool("echo", {"unexpected_kwarg": 1})


class BoundaryRefusalTest(_SandboxCase):
    def test_in_process_mode_has_no_process_to_start(self) -> None:
        path = write_plugin(self.root, "inproc", GOOD_PLUGIN)
        proc = iso.PluginSandboxProcess(
            "inproc", path, spec=iso.SandboxSpec(mode=iso.IsolationMode.IN_PROCESS))
        with self.assertRaises(iso.SandboxStartError) as ctx:
            proc.start()
        self.assertIn("in-process", str(ctx.exception))

    def test_container_mode_refuses_without_a_daemon(self) -> None:
        path = write_plugin(self.root, "cont", GOOD_PLUGIN)
        proc = iso.PluginSandboxProcess(
            "cont", path, spec=iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER))
        self.addCleanup(proc.stop)
        with self.assertRaises(iso.SandboxStartError) as ctx:
            proc.start()
        self.assertIn("container", str(ctx.exception).lower())

    def test_missing_plugin_files_are_reported(self) -> None:
        empty = self.root / "empty"
        empty.mkdir()
        proc = iso.PluginSandboxProcess("empty", empty)
        with self.assertRaises(iso.SandboxError) as ctx:
            proc.start()
        self.assertIn("no __init__.py", str(ctx.exception))

    def test_calling_without_starting_is_refused(self) -> None:
        path = write_plugin(self.root, "never", GOOD_PLUGIN)
        proc = iso.PluginSandboxProcess("never", path)
        with self.assertRaises(iso.SandboxStartError):
            proc.call_tool("echo", {})

    def test_stop_is_idempotent(self) -> None:
        proc = self._spawn("idem", GOOD_PLUGIN)
        proc.start()
        proc.stop()
        proc.stop()
        self.assertFalse(proc.running)


class ContainerArgvTest(unittest.TestCase):
    """The container command is pure, so it is asserted without a daemon.

    ``docker`` v29.4.2 is installed on this machine but its engine is not
    reachable, so no container is started and none is claimed to be. What is
    verified is the command: a wrong mount or a missing ``--network none`` is
    exactly the class of mistake that would quietly expose the host.
    """

    SPEC = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER, image="python:3.13-slim")

    def _argv(self, spec=None, **kw):
        return iso.container_argv(spec or self.SPEC, Path("/plugins/demo"), **kw)

    def test_network_is_denied_by_default(self) -> None:
        argv = self._argv()
        self.assertIn("--network", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "none")

    def test_network_is_granted_only_when_the_manifest_asks(self) -> None:
        spec = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER, network=True)
        argv = self._argv(spec)
        self.assertEqual(argv[argv.index("--network") + 1], "bridge")

    def test_root_filesystem_is_read_only_with_a_tmpfs(self) -> None:
        argv = self._argv()
        self.assertIn("--read-only", argv)
        self.assertIn("--tmpfs", argv)

    def test_the_plugin_mount_is_read_only(self) -> None:
        argv = self._argv()
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "--mount"]
        plugin_mounts = [m for m in mounts if "dst=/plugin" in m]
        self.assertTrue(plugin_mounts, "the plugin directory is not mounted")
        self.assertTrue(all(m.endswith(",readonly") for m in plugin_mounts),
                        "the plugin directory is mounted writable")

    def test_the_runner_module_is_mounted_read_only(self) -> None:
        argv = self._argv()
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "--mount"]
        self.assertTrue(any("dst=/opt/roveagent" in m and m.endswith(",readonly")
                            for m in mounts))

    def test_it_does_not_run_as_root(self) -> None:
        argv = self._argv()
        self.assertIn("--user", argv)
        self.assertNotEqual(argv[argv.index("--user") + 1], "0:0")

    def test_it_is_removed_after_exit(self) -> None:
        self.assertIn("--rm", self._argv())

    def test_stdin_stays_open_for_the_protocol(self) -> None:
        self.assertIn("-i", self._argv())

    def test_resource_limits_only_appear_when_declared(self) -> None:
        self.assertNotIn("--memory", self._argv())
        self.assertNotIn("--cpus", self._argv())
        spec = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER, memory_mb=256, cpus=1.5)
        argv = self._argv(spec)
        self.assertEqual(argv[argv.index("--memory") + 1], "256m")
        self.assertEqual(argv[argv.index("--cpus") + 1], "1.5")

    def test_it_launches_the_runner_module_unbuffered(self) -> None:
        argv = self._argv()
        self.assertEqual(argv[-4:], ["python", "-u", "-m", iso.RUNNER_MODULE])

    def test_writable_paths_are_mounted_writable(self) -> None:
        spec = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER,
                               writable_paths=("/var/scratch",))
        argv = self._argv(spec)
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "--mount"]
        self.assertTrue(any("dst=/var/scratch" in m and not m.endswith(",readonly")
                            for m in mounts))

    def test_the_image_can_be_overridden(self) -> None:
        spec = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER, image="alpine:3")
        self.assertIn("alpine:3", self._argv(spec))

    def test_a_shell_string_is_never_used(self) -> None:
        """A single string would need a shell, and a shell re-opens injection."""
        argv = self._argv()
        self.assertTrue(all(isinstance(part, str) for part in argv))
        self.assertNotIn("sh", argv)
        self.assertNotIn("-c", argv)


class RefusalToDowngradeTest(unittest.TestCase):
    def test_container_mode_never_falls_back_to_subprocess(self) -> None:
        """The failure mode this prevents: a manifest asks for confinement and
        silently gets a bare process instead."""
        spec = iso.SandboxSpec(mode=iso.IsolationMode.CONTAINER)
        verdict = iso.evaluate_isolation(
            "demo", spec, iso.PluginPermissions(),
            available={iso.IsolationMode.IN_PROCESS: True,
                       iso.IsolationMode.SUBPROCESS: True,
                       iso.IsolationMode.CONTAINER: False})
        self.assertFalse(verdict.allowed)
        self.assertEqual(verdict.mode, iso.IsolationMode.CONTAINER)


class SecretScrubbingTest(_SandboxCase):
    """The child must not inherit the host's credentials, known or unknown.

    The second test is the one that matters. A denylist of known provider
    variables would pass the first test and still leak an operator's own
    ``MY_COMPANY_API_KEY``; an allowlist cannot. The invented marker name below
    is deliberately one no denylist would ever list.
    """

    def test_a_host_secret_is_not_visible_to_the_plugin(self) -> None:
        marker = "ROVEFRAME_TEST_SECRET_MARKER"
        os.environ[marker] = "super-secret-value"
        self.addCleanup(os.environ.pop, marker, None)

        proc = self._spawn("envcheck", """
            import os

            def report():
                return {"marker": os.environ.get("ROVEFRAME_TEST_SECRET_MARKER"),
                        "has_path": bool(os.environ.get("PATH")),
                        "sandboxed": os.environ.get("ROVEAGENT_SANDBOXED_PLUGIN")}

            TOOLS = {"report": report}
            """, tools=("report",))
        proc.start()
        result = proc.call_tool("report", {})
        self.assertIsNone(result["marker"],
                          "the child inherited a host secret from os.environ")
        self.assertTrue(result["has_path"], "the child still needs a usable PATH")
        self.assertEqual(result["sandboxed"], "1")

    def test_an_invented_secret_name_cannot_leak(self) -> None:
        """The property a denylist cannot provide: unknown names are excluded too."""
        invented = "ACME_INTERNAL_WHATEVER_TOKEN"
        os.environ[invented] = "leak-me"
        self.addCleanup(os.environ.pop, invented, None)
        env = iso._make_env_for_child()
        self.assertNotIn(invented, env)

    def test_the_allowlist_excludes_known_host_secrets(self) -> None:
        env = iso._make_env_for_child()
        for leaky in ("ROVEAGENT_API_KEY", "ROVEAGENT_APPROVAL_SECRET",
                      "COZE_SUPABASE_SERVICE_ROLE_KEY", "COZE_SUPABASE_ANON_KEY",
                      "AWS_SECRET_ACCESS_KEY"):
            self.assertNotIn(leaky, env)

    def test_caller_supplied_vars_are_passed_through(self) -> None:
        """A plugin that needs a credential gets it deliberately, leaving a record."""
        env = iso._make_env_for_child({"PLUGIN_TOKEN": "explicit"})
        self.assertEqual(env["PLUGIN_TOKEN"], "explicit")

    def test_the_never_list_wins_over_an_explicit_grant(self) -> None:
        env = iso._make_env_for_child({"ROVEAGENT_API_KEY": "sneaky"})
        self.assertNotIn("ROVEAGENT_API_KEY", env)

    def test_the_allowlist_does_not_include_os_environ_wholesale(self) -> None:
        os.environ["ROVEFRAME_BULK_LEAK_CHECK"] = "x"
        self.addCleanup(os.environ.pop, "ROVEFRAME_BULK_LEAK_CHECK", None)
        env = iso._make_env_for_child()
        self.assertNotIn("ROVEFRAME_BULK_LEAK_CHECK", env)
        self.assertLess(len(env), len(os.environ) + 8,
                        "the child environment looks like a copy of os.environ")


class ProtocolTest(_SandboxCase):
    """Wire-level behaviour, driven directly against the runner."""

    def _talk(self, lines: list[str], *, timeout: float = 20.0) -> list[dict]:
        env = iso._make_env_for_child()
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, "-u", "-m", "roveagent.api.plugin_sandbox_runner"],
            input="\n".join(lines) + "\n", capture_output=True, text=True,
            encoding="utf-8", errors="replace", env=env, cwd=str(REPO_ROOT),
            timeout=timeout,
        )
        return [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]

    def test_ping_needs_no_plugin(self) -> None:
        replies = self._talk(['{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'])
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0]["result"]["pong"])

    def test_malformed_json_gets_a_parse_error_and_the_stream_continues(self) -> None:
        replies = self._talk([
            "this is not json",
            '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}',
        ])
        self.assertEqual(replies[0]["error"]["code"], iso.__dict__.get("E_PARSE", -32700))
        self.assertTrue(replies[1]["result"]["pong"])

    def test_calling_before_initialize_is_refused(self) -> None:
        replies = self._talk(['{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'])
        self.assertIn("error", replies[0])
        self.assertIn("initialize", replies[0]["error"]["message"])

    def test_unknown_method_is_refused(self) -> None:
        replies = self._talk([
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"plugin_path":"%s","tools":[]}}'
            % str(self.root).replace("\\", "\\\\"),
            '{"jsonrpc":"2.0","id":2,"method":"teleport","params":{}}',
        ])
        # The first initialize fails (no plugin file at the sandbox root) but the
        # second reply must still be a clean method-not-found or protocol error.
        self.assertIn("error", replies[-1])

    def test_non_object_request_is_refused(self) -> None:
        replies = self._talk(['[1,2,3]'])
        self.assertIn("error", replies[0])

    def test_missing_method_is_refused(self) -> None:
        replies = self._talk(['{"jsonrpc":"2.0","id":1,"params":{}}'])
        self.assertIn("error", replies[0])

    def test_shutdown_returns_zero_exit(self) -> None:
        env = iso._make_env_for_child()
        proc = subprocess.run(
            [sys.executable, "-u", "-m", "roveagent.api.plugin_sandbox_runner"],
            input='{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n'
                  '{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}\n',
            capture_output=True, text=True, encoding="utf-8", env=env,
            cwd=str(REPO_ROOT), timeout=20,
        )
        self.assertEqual(proc.returncode, 0)


class ManifestIsolationReadTest(_SandboxCase):
    """Reading `sandbox:` and `permissions:` out of a plugin manifest."""

    def _write_yaml(self, name: str, text: str) -> Path:
        directory = self.root / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "plugin.yaml").write_text(text, encoding="utf-8")
        return directory

    def test_no_manifest_yields_the_safe_default(self) -> None:
        empty = self.root / "nomanifest"
        empty.mkdir()
        spec, perms, error = iso.read_manifest_isolation(empty)
        self.assertEqual(error, "")
        self.assertEqual(spec.mode, iso.IsolationMode.SUBPROCESS)
        self.assertEqual(perms.requested, frozenset())

    def test_never_defaults_to_in_process(self) -> None:
        """In-process is the mode the requirement forbids; it must not be reachable by omission."""
        empty = self.root / "nomanifest2"
        empty.mkdir()
        self.assertNotEqual(iso.read_manifest_isolation(empty)[0].mode,
                            iso.IsolationMode.IN_PROCESS)

    def test_reads_a_sandbox_block(self) -> None:
        directory = self._write_yaml("withsandbox", """
            name: withsandbox
            version: 1.0.0
            sandbox:
              mode: container
              memory_mb: 512
            permissions:
              - files:read
            """)
        spec, perms, error = iso.read_manifest_isolation(directory)
        self.assertEqual(error, "")
        self.assertEqual(spec.mode, iso.IsolationMode.CONTAINER)
        self.assertEqual(spec.memory_mb, 512)
        self.assertEqual(perms.requested, frozenset({iso.PluginPermission.FILES_READ}))

    def test_misspelled_permission_is_reported_not_ignored(self) -> None:
        """Silently reading it as 'requests nothing' would hide the real intent."""
        directory = self._write_yaml("badperm", """
            name: badperm
            permissions:
              - files:raed
            """)
        _spec, _perms, error = iso.read_manifest_isolation(directory)
        self.assertIn("files:raed", error)

    def test_provides_tools_implies_a_tool_exposure_request(self) -> None:
        """A plugin that ships tools is asking to expose them; say so."""
        directory = self._write_yaml("withtools", """
            name: withtools
            provides_tools:
              - do_a_thing
            """)
        _spec, perms, _error = iso.read_manifest_isolation(directory)
        self.assertIn(iso.PluginPermission.TOOLS_EXPOSE, perms.requested)

    def test_json_manifest_is_accepted(self) -> None:
        directory = self.root / "jsonplugin"
        directory.mkdir()
        (directory / "plugin.json").write_text(
            '{"name": "jsonplugin", "permissions": ["files:read"]}', encoding="utf-8")
        _spec, perms, error = iso.read_manifest_isolation(directory)
        self.assertEqual(error, "")
        self.assertIn(iso.PluginPermission.FILES_READ, perms.requested)

    def test_a_path_that_is_not_a_directory_is_reported(self) -> None:
        _spec, _perms, error = iso.read_manifest_isolation(self.root / "absent")
        self.assertIn("not a directory", error)


class IsolationStatusTest(_SandboxCase):
    """The Plugin Manager `status` half of the contract."""

    def _entry(self, name: str, source: str = "user", manifest: str = "") -> dict:
        directory = self.root / name
        directory.mkdir(parents=True, exist_ok=True)
        if manifest:
            (directory / "plugin.yaml").write_text(manifest, encoding="utf-8")
        return {"name": name, "source": source, "path": str(directory), "key": name}

    def test_third_party_plugin_requesting_tools_is_refused_ungranted(self) -> None:
        entry = self._entry("third-party", source="user",
                            manifest="name: third-party\nprovides_tools: [x]\n")
        rows = iso.isolation_status_for_discovered([entry])
        self.assertFalse(rows[0]["allowed"])
        self.assertIn("tools:expose", rows[0]["reason"])

    def test_bundled_plugin_is_trusted_as_part_of_the_product(self) -> None:
        entry = self._entry("shipped", source="bundled",
                            manifest="name: shipped\nprovides_tools: [x]\n")
        rows = iso.isolation_status_for_discovered([entry])
        self.assertTrue(rows[0]["allowed"], rows[0]["reason"])
        self.assertFalse(rows[0]["isolation_required"])

    def test_bundled_is_recorded_as_in_process_not_as_sandboxed(self) -> None:
        """The honesty requirement: never imply a boundary that does not exist."""
        entry = self._entry("shipped2", source="bundled")
        rows = iso.isolation_status_for_discovered([entry])
        self.assertEqual(rows[0]["mode"], "in-process")
        self.assertTrue(any("none" in g for g in rows[0]["effective_guarantees"]))

    def test_trust_bundled_can_be_turned_off(self) -> None:
        """Without bundled trust the plugin is treated as third-party.

        It does not DECLARE a sandbox, so the safe default (subprocess) applies
        and it is still allowed — but it is now marked as requiring isolation,
        and it no longer receives the implicit tool-exposure grant.
        """
        entry = self._entry("shipped3", source="bundled",
                            manifest="name: shipped3\nprovides_tools: [x]\n")
        rows = iso.isolation_status_for_discovered([entry], trust_bundled=False)
        self.assertTrue(rows[0]["isolation_required"])
        self.assertEqual(rows[0]["mode"], "subprocess")
        self.assertFalse(rows[0]["allowed"],
                         "tools:expose must not be auto-granted without bundled trust")
        self.assertIn("tools:expose", rows[0]["reason"])

    def test_status_does_not_claim_enforcement_that_is_not_in_effect(self) -> None:
        """PluginManager still imports modules in-process; the report must say so.

        Without this, a row reading "subprocess" would be read as a guarantee
        that no boundary currently provides.
        """
        entry = self._entry("honest", source="bundled")
        row = iso.isolation_status_for_discovered([entry])[0]
        self.assertFalse(row["isolation_enforced"])
        self.assertIn("in-process", row["runtime_loader"])
        summary = iso.isolation_summary([row])
        self.assertFalse(summary["boundary_enforced"])
        self.assertIn("NOT yet routed", summary["note"])

    def test_a_third_party_plugin_declaring_container_is_refused_without_an_engine(self) -> None:
        entry = self._entry("wants-container", source="user",
                            manifest="name: wants-container\nsandbox:\n  mode: container\n")
        rows = iso.isolation_status_for_discovered([entry])
        self.assertFalse(rows[0]["allowed"])
        self.assertEqual(rows[0]["mode"], "container")

    def test_a_third_party_plugin_declaring_subprocess_passes(self) -> None:
        entry = self._entry("wants-subprocess", source="user",
                            manifest="name: wants-subprocess\nsandbox:\n  mode: subprocess\n")
        rows = iso.isolation_status_for_discovered([entry])
        self.assertTrue(rows[0]["allowed"], rows[0]["reason"])

    def test_entry_without_a_path_is_refused_not_crashed(self) -> None:
        rows = iso.isolation_status_for_discovered([{"name": "ghost", "source": "user"}])
        self.assertFalse(rows[0]["allowed"])
        self.assertIn("no path", rows[0]["reason"])

    def test_status_is_json_safe(self) -> None:
        entry = self._entry("jsonable", source="bundled")
        json.dumps(iso.isolation_status_for_discovered([entry]))

    def test_summary_counts_third_party_separately(self) -> None:
        entries = [
            self._entry("b1", source="bundled"),
            self._entry("b2", source="bundled"),
            self._entry("u1", source="user",
                        manifest="name: u1\nsandbox:\n  mode: subprocess\n"),
        ]
        summary = iso.isolation_summary(iso.isolation_status_for_discovered(entries))
        self.assertEqual(summary["total"], 3)
        self.assertEqual(summary["third_party_total"], 1)
        self.assertEqual(summary["allowed"], 3)

    def test_summary_note_does_not_claim_bundled_plugins_are_sandboxed(self) -> None:
        summary = iso.isolation_summary([])
        self.assertIn("does not claim they are sandboxed", summary["note"])


class RealPluginSetTest(unittest.TestCase):
    """Runs against the plugins this repository actually ships."""

    def _entries(self):
        from roveagent.api.plugin_center import _discover_all

        return _discover_all()

    def test_every_shipped_manifest_parses(self) -> None:
        problems = []
        entries = self._entries()
        self.assertGreater(len(entries), 10, "expected a populated plugin tree")
        for entry in entries:
            path = entry.get("path")
            if not path:
                problems.append("%s: discovery gave no path" % entry.get("name"))
                continue
            _spec, _perms, error = iso.read_manifest_isolation(Path(str(path)))
            if error:
                problems.append("%s: %s" % (entry.get("name"), error))
        self.assertEqual(problems, [], "shipped manifests failed to parse:\n"
                         + "\n".join(problems))

    def test_no_shipped_plugin_is_refused_under_the_default_posture(self) -> None:
        """The shipped product must not refuse its own plugins out of the box."""
        entries = self._entries()
        rows = iso.isolation_status_for_discovered(entries)
        refused = [(r["plugin_name"], r["reason"]) for r in rows if not r["allowed"]]
        self.assertEqual(refused, [], "bundled plugins were refused: %s" % refused)

    def test_shipped_plugins_are_honestly_reported_as_in_process(self) -> None:
        entries = self._entries()
        rows = iso.isolation_status_for_discovered(entries)
        modes = {r["mode"] for r in rows}
        self.assertEqual(modes, {"in-process"},
                         "a bundled plugin claims an isolation mode; verify it "
                         "actually gets that boundary before updating this test")
        self.assertEqual(iso.isolation_summary(rows)["third_party_total"], 0)


if __name__ == "__main__":
    unittest.main()
