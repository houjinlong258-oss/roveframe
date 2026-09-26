"""Tests for :mod:`roveagent.skills_market.install_policy`.

All offline and pure: the policy reads no settings, no environment and no disk.
The last test in ``NonBypassableTest`` asserts that property against the module's
own source, because "not configurable" is the whole point and is easy to lose.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

from roveagent.skills_market.install_policy import (
    InstallDisposition,
    auto_grants,
    decide_install_policy,
)
from roveagent.skills_market.permissions import HIGH_IMPACT, Capability


class LowImpactTest(unittest.TestCase):
    def test_no_capabilities_auto_installs(self) -> None:
        d = decide_install_policy()
        self.assertIs(d.disposition, InstallDisposition.AUTO)
        self.assertTrue(d.ok)

    def test_files_read_auto_installs(self) -> None:
        d = decide_install_policy(requested=[Capability.FILES_READ])
        self.assertIs(d.disposition, InstallDisposition.AUTO)
        self.assertEqual(d.low_impact, ("files:read",))

    def test_skill_invoke_auto_installs(self) -> None:
        d = decide_install_policy(requested=[Capability.SKILL_INVOKE])
        self.assertIs(d.disposition, InstallDisposition.AUTO)

    def test_auto_grants_returns_exactly_the_low_impact_request(self) -> None:
        requested = [Capability.FILES_READ, Capability.SKILL_INVOKE]
        d = decide_install_policy(requested=requested)
        self.assertEqual(auto_grants(d, requested), frozenset(requested))


class ThresholdTest(unittest.TestCase):
    def test_every_high_impact_capability_requires_approval(self) -> None:
        # Driven by HIGH_IMPACT itself so a new member cannot be forgotten here.
        self.assertTrue(HIGH_IMPACT, "HIGH_IMPACT 为空，阈值失去意义")
        for capability in HIGH_IMPACT:
            with self.subTest(capability=capability.value):
                d = decide_install_policy(requested=[capability])
                self.assertIs(d.disposition, InstallDisposition.NEEDS_APPROVAL)
                self.assertTrue(d.needs_approval)
                self.assertIn(capability.value, d.reason,
                              "审批理由必须点名具体能力，人要看的就是这个")

    def test_one_high_impact_among_low_impact_still_requires_approval(self) -> None:
        d = decide_install_policy(
            requested=[Capability.FILES_READ, Capability.SHELL_EXECUTE]
        )
        self.assertIs(d.disposition, InstallDisposition.NEEDS_APPROVAL)
        self.assertEqual(d.low_impact, ("files:read",))
        self.assertEqual(d.high_impact, ("shell:execute",))

    def test_auto_grants_is_empty_when_approval_is_required(self) -> None:
        # This is the mechanism that stops an agent granting itself a shell.
        requested = [Capability.SHELL_EXECUTE]
        d = decide_install_policy(requested=requested)
        self.assertEqual(auto_grants(d, requested), frozenset())


class RefusalTest(unittest.TestCase):
    def test_blocking_finding_refuses(self) -> None:
        d = decide_install_policy(blocking=["critical: destructive_command (rm -rf)"])
        self.assertIs(d.disposition, InstallDisposition.REFUSE)
        self.assertFalse(d.ok)

    def test_refusal_outranks_approval(self) -> None:
        # Even a high-impact request that a human might approve is refused: the
        # scan verdict is not an approval decision.
        d = decide_install_policy(
            requested=[Capability.SHELL_EXECUTE],
            blocking=["critical: instruction-override phrasing"],
        )
        self.assertIs(d.disposition, InstallDisposition.REFUSE)
        self.assertIn("not an approval", d.reason)

    def test_auto_grants_is_empty_on_refusal(self) -> None:
        requested = [Capability.FILES_READ]
        d = decide_install_policy(requested=requested, blocking=["high: something"])
        self.assertEqual(auto_grants(d, requested), frozenset())


class FailClosedTest(unittest.TestCase):
    def test_unknown_capability_requires_approval(self) -> None:
        d = decide_install_policy(requested=["quantum:teleport"])
        self.assertIs(d.disposition, InstallDisposition.NEEDS_APPROVAL)
        self.assertEqual(d.unknown, ("quantum:teleport",))
        self.assertIn("never as harmless", d.reason)

    def test_unknown_capability_is_never_auto_granted(self) -> None:
        d = decide_install_policy(requested=["quantum:teleport"])
        self.assertEqual(auto_grants(d, ["quantum:teleport"]), frozenset())

    def test_accepts_plain_strings_for_known_capabilities(self) -> None:
        self.assertIs(
            decide_install_policy(requested=["files:read"]).disposition,
            InstallDisposition.AUTO,
        )
        self.assertIs(
            decide_install_policy(requested=["shell:execute"]).disposition,
            InstallDisposition.NEEDS_APPROVAL,
        )


class NonBypassableTest(unittest.TestCase):
    """The policy must not be switchable off — asserted against its own source."""

    def _module_source(self) -> str:
        return (Path(__file__).parent / "install_policy.py").read_text("utf-8")

    def _module_tree(self) -> ast.Module:
        return ast.parse(self._module_source())

    def test_source_is_parseable(self) -> None:
        # Negative control for the assertions below: if parsing broke, the
        # checks would silently pass over an empty tree.
        tree = self._module_tree()
        self.assertGreater(len(tree.body), 5, "解析出的模块体过小，ast 断言可能失效")

    def test_does_not_read_configuration(self) -> None:
        source = self._module_source()
        tree = self._module_tree()
        # Compare against the docstring-stripped body: the module docstring
        # legitimately *names* these to explain why they are not used.
        body = "\n".join(
            ast.unparse(node) for node in tree.body
            if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant))
        )
        for banned in ("write_approval", "os.environ", "getenv", "cfg_get"):
            self.assertNotIn(
                banned, body,
                "install_policy 读取了 %s —— 那样关掉设置就等于把高影响技能降级为自动安装" % banned,
            )
        # And the reason string mentioning 'write_approval' in the docstring is
        # exactly why the check above uses the parsed body rather than the text.
        self.assertIn("write_approval", source)

    def test_imports_only_the_permission_layer(self) -> None:
        imported: set[str] = set()
        for node in ast.walk(self._module_tree()):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                imported.update(
                    alias.name for alias in node.names
                )
        self.assertEqual(
            imported,
            # "annotations" 来自 `from __future__ import annotations`（ast 把
            # __future__ 导入也当作普通 ImportFrom），漏掉它会让这条断言在正确
            # 代码上变红 —— 初版就是这么写的。
            {"annotations", "dataclasses", "Enum", "Any", "Iterable",
             "HIGH_IMPACT", "Capability"},
            "install_policy 的依赖面变了 —— 它应当是纯逻辑，不碰 I/O、配置或扫描器",
        )


if __name__ == "__main__":
    unittest.main()
