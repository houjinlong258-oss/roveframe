"""Tests for :mod:`roveagent.skills_market.fetcher`.

Every test here runs **offline**: the git calls go through an injected runner, so
the refusal paths (which are the ones that matter) are exercised without a network
and without depending on any particular git host being reachable.

The one exception is :class:`RealFetchTest`, which is skipped unless
``RF_TEST_REAL_FETCH=1`` is set — it proves the real argv actually clones.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from roveagent.skills_market.fetcher import (
    FetchLimits,
    FetchRefused,
    fetch_skill,
)
from roveagent.skills_market.installer import digest_tree

GIT = None  # resolved lazily in setUpModule


def setUpModule() -> None:  # noqa: N802 - unittest API
    global GIT
    from roveagent.clisupport import plugins_cmd

    GIT = plugins_cmd._resolve_git_executable()


class FakeGit:
    """Stand-in for the git subprocess. Never touches the network."""

    def __init__(
        self,
        *,
        files: dict[str, bytes] | None = None,
        commit: str = "b" * 40,
        clone_rc: int = 0,
        clone_err: str = "",
        raise_timeout: bool = False,
        git_dir_bytes: int = 0,
        readonly: bool = False,
    ) -> None:
        self.files = files if files is not None else {"SKILL.md": b"# demo\n"}
        self.commit = commit
        self.clone_rc = clone_rc
        self.clone_err = clone_err
        self.raise_timeout = raise_timeout
        self.git_dir_bytes = git_dir_bytes
        self.readonly = readonly
        self.calls: list[list[str]] = []

    def __call__(self, argv, cwd, timeout):  # noqa: ANN001 - matches GitRunner
        self.calls.append(list(argv))
        if len(argv) > 1 and argv[1] == "clone":
            if self.raise_timeout:
                raise subprocess.TimeoutExpired(list(argv), timeout)
            if self.clone_rc != 0:
                return self.clone_rc, "", self.clone_err
            repo = Path(argv[-1])
            repo.mkdir(parents=True, exist_ok=True)
            if self.git_dir_bytes:
                # Simulates the packfile a single huge commit leaves in .git.
                gitdir = repo / ".git"
                gitdir.mkdir(exist_ok=True)
                (gitdir / "pack.bin").write_bytes(b"x" * self.git_dir_bytes)
            for name, payload in self.files.items():
                target = repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
                if self.readonly:
                    # A real clone leaves .git/objects/** read-only.
                    os.chmod(target, stat.S_IREAD)
            return 0, "", ""
        if len(argv) > 1 and argv[1] == "rev-parse":
            return 0, self.commit + "\n", ""
        return 1, "", "unexpected argv: %r" % (argv,)

    def clone_url(self) -> str:
        for argv in self.calls:
            if len(argv) > 1 and argv[1] == "clone":
                return argv[-2]
        raise AssertionError("no clone call recorded")


class FetcherTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "quarantine"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _leftovers(self) -> list[str]:
        if not self.root.exists():
            return []
        return sorted(p.name for p in self.root.iterdir())


class TransportRefusalTest(FetcherTestBase):
    """The transport allowlist is the boundary an agent cannot argue with."""

    def test_refuses_file_scheme_and_leaves_nothing_behind(self) -> None:
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("file:///etc/passwd", quarantine_root=self.root,
                        runner=FakeGit())
        self.assertIn("refused transport", str(ctx.exception))
        self.assertEqual(self._leftovers(), [], "拒绝路径不得留下隔离目录")

    def test_refuses_http_scheme(self) -> None:
        with self.assertRaises(FetchRefused):
            fetch_skill("http://example.com/a/b.git", quarantine_root=self.root,
                        runner=FakeGit())

    def test_refuses_empty_source(self) -> None:
        with self.assertRaises(FetchRefused):
            fetch_skill("   ", quarantine_root=self.root, runner=FakeGit())

    def test_local_path_is_not_treated_as_a_local_read(self) -> None:
        # _resolve_git_url turns a bare "/x/y" into a github URL, so this must be
        # an https fetch attempt — never a local filesystem read.
        runner = FakeGit()
        result = fetch_skill("/tmp/somewhere", quarantine_root=self.root, runner=runner)
        self.assertTrue(runner.clone_url().startswith("https://"))
        self.assertTrue(str(result.path).startswith(str(self.root)))


class HappyPathTest(FetcherTestBase):
    def test_https_fetch_returns_digest_and_provenance(self) -> None:
        runner = FakeGit(files={"SKILL.md": b"# demo\n", "tools/a.py": b"print(1)\n"})
        result = fetch_skill("https://gitlab.com/owner/repo.git",
                             quarantine_root=self.root, runner=runner)
        self.assertEqual(result.commit, "b" * 40)
        self.assertEqual(result.files, ("SKILL.md", "tools/a.py"))
        self.assertGreater(result.total_bytes, 0)
        self.assertEqual(result.digest, digest_tree(result.path)[0])

        provenance = json.loads((result.quarantine / "provenance.json").read_text("utf-8"))
        self.assertEqual(provenance["commit"], "b" * 40)
        self.assertEqual(provenance["digest"], result.digest)
        self.assertEqual(provenance["url"], "https://gitlab.com/owner/repo.git")
        self.assertIn("not installed", provenance["note"])

    def test_scp_like_ssh_is_accepted(self) -> None:
        runner = FakeGit()
        result = fetch_skill("git@github.com:owner/repo.git",
                             quarantine_root=self.root, runner=runner)
        self.assertEqual(runner.clone_url(), "git@github.com:owner/repo.git")
        self.assertEqual(result.commit, "b" * 40)

    def test_clone_is_shallow_and_never_prompts(self) -> None:
        runner = FakeGit()
        fetch_skill("https://host/owner/repo.git", quarantine_root=self.root, runner=runner)
        argv = runner.calls[0]
        for flag in ("--depth", "1", "--no-tags", "--single-branch", "--quiet"):
            self.assertIn(flag, argv)

    def test_provenance_is_outside_the_fetched_directory(self) -> None:
        # Writing provenance inside would change the digest the installer verifies.
        runner = FakeGit()
        result = fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        self.assertFalse((result.path / "provenance.json").exists())
        self.assertTrue((result.quarantine / "provenance.json").exists())


class LimitsTest(FetcherTestBase):
    def test_refuses_oversized_tree_during_the_walk(self) -> None:
        runner = FakeGit(files={"big.bin": b"x" * 5000})
        limits = FetchLimits(max_bytes=1000)
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root,
                        runner=runner, limits=limits)
        self.assertIn("byte cap", str(ctx.exception))
        self.assertEqual(self._leftovers(), [], "超限必须在拒绝时清理隔离目录")

    def test_git_directory_counts_towards_the_byte_cap(self) -> None:
        # --depth 1 bounds history, not blob size: a huge packfile must still trip
        # the cap, otherwise a repository can fill the disk while reporting a
        # size under the limit.
        runner = FakeGit(files={"SKILL.md": b"tiny\n"}, git_dir_bytes=50_000)
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root,
                        runner=runner, limits=FetchLimits(max_bytes=10_000))
        self.assertIn("byte cap", str(ctx.exception))

    def test_refuses_too_many_files(self) -> None:
        runner = FakeGit(files={"f%d.md" % i: b"x" for i in range(10)})
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root,
                        runner=runner, limits=FetchLimits(max_files=3))
        self.assertIn("file cap", str(ctx.exception))

    def test_refuses_empty_directory(self) -> None:
        runner = FakeGit(files={})
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        self.assertIn("nothing to fetch", str(ctx.exception))
        self.assertEqual(self._leftovers(), [])


class FailureCleanupTest(FetcherTestBase):
    def test_clone_failure_is_refused_and_cleaned(self) -> None:
        runner = FakeGit(clone_rc=128, clone_err="repository not found")
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        self.assertIn("git clone failed", str(ctx.exception))
        self.assertIn("repository not found", str(ctx.exception))
        self.assertEqual(self._leftovers(), [])

    def test_timeout_is_refused_and_cleaned(self) -> None:
        runner = FakeGit(raise_timeout=True)
        with self.assertRaises(FetchRefused) as ctx:
            fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        self.assertIn("timed out", str(ctx.exception))
        self.assertEqual(self._leftovers(), [])

    def test_subdir_traversal_is_refused(self) -> None:
        runner = FakeGit(files={"SKILL.md": b"x"})
        with self.assertRaises(FetchRefused):
            fetch_skill("https://host/o/r.git#../../../../etc",
                        quarantine_root=self.root, runner=runner)
        self.assertEqual(self._leftovers(), [])

    def test_cleanup_removes_readonly_files(self) -> None:
        # Regression: `shutil.rmtree(..., ignore_errors=True)` silently left the
        # quarantine directory behind on Windows because a real clone leaves git
        # objects read-only. That defect was only visible via the opt-in network
        # test (which is skipped by default), so it is pinned here as well.
        runner = FakeGit(files={"SKILL.md": b"x" * 10}, readonly=True)
        with self.assertRaises(FetchRefused):
            fetch_skill("https://host/o/r.git", quarantine_root=self.root,
                        runner=runner, limits=FetchLimits(max_files=0))
        self.assertEqual(self._leftovers(), [], "只读文件不得阻止隔离目录被清理")


class ScopeTest(FetcherTestBase):
    """Fetch must not be able to install, and must not know how."""

    def test_module_never_references_the_installing_entry_points(self) -> None:
        # Parsed with ast rather than substring-matched: the module docstring
        # legitimately *names* install_from_directory while explaining why the
        # fetch step deliberately stops short of it. A substring check would flag
        # prose; the import list and call sites are what actually grant capability.
        import ast

        source = (Path(__file__).parent / "fetcher.py").read_text("utf-8")
        tree = ast.parse(source)

        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imported.update(alias.name for alias in node.names)
        self.assertIn("digest_tree", imported,
                      "fetcher.py 应当只从 installer 复用 digest_tree")
        for banned in ("install_from_directory", "plan_install", "InstallResult"):
            self.assertNotIn(banned, imported,
                             "fetcher.py 导入了 %s —— 取回阶段不得具备安装能力" % banned)

        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        # Negative control built in: `run` is called, so this set is not empty.
        self.assertIn("run", called, "未解析出调用点，ast 断言可能失效")
        for banned in ("install_from_directory", "plan_install"):
            self.assertNotIn(banned, called,
                             "fetcher.py 调用了 %s —— 取回阶段不得安装" % banned)

    def test_result_offers_no_install_action(self) -> None:
        runner = FakeGit()
        result = fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        for name in ("install", "activate", "enable"):
            self.assertFalse(hasattr(result, name),
                             "FetchedSkill 暴露了 %s —— 取回结果不应可安装" % name)

    def test_quarantine_directory_is_outside_the_skill_library(self) -> None:
        runner = FakeGit()
        result = fetch_skill("https://host/o/r.git", quarantine_root=self.root, runner=runner)
        self.assertTrue(str(result.path).startswith(str(self.root)))


@unittest.skipUnless(os.environ.get("RF_TEST_REAL_FETCH") == "1",
                     "set RF_TEST_REAL_FETCH=1 to run the real network clone")
class RealFetchTest(FetcherTestBase):
    """Opt-in: proves the real argv clones. Needs network + a host key."""

    def test_real_clone_from_github(self) -> None:
        # Resolved here, not via a decorator: `@skipIf(GIT is None, ...)` is
        # evaluated when the class body runs — before setUpModule assigns GIT — so
        # that form skips unconditionally *and* reports a false reason
        # ("git not available" when git is present). This test is the only L3
        # evidence for the real argv, so it has to be reachable.
        from roveagent.clisupport import plugins_cmd

        if plugins_cmd._resolve_git_executable() is None:
            self.skipTest("git executable not on PATH")

        result = fetch_skill("https://github.com/obra/superpowers.git",
                             quarantine_root=self.root,
                             limits=FetchLimits(timeout_seconds=180))
        self.assertTrue(result.commit)
        self.assertTrue(result.files, "clone 成功但文件清单为空")
        self.assertTrue((result.quarantine / "provenance.json").exists())
        # Cleanup: quarantine is not a garbage can.
        result.cleanup()
        self.assertFalse(result.quarantine.exists())


if __name__ == "__main__":
    unittest.main()
