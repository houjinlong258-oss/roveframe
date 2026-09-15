"""Phase 2a 验证：组合 toolset 的可用性解析（R1 修复）。

核心断言：``safe`` / ``media`` / ``git`` 等纯组合 toolset 虽然**不在**
``registry.get_available_toolsets()`` 里（该方法只按注册条目分组），
但它们展开出的工具是**真实可用**的，必须能被解析出来。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "test-key")

from roveagent.api.capability_router import (  # noqa: E402
    capability_report,
    filter_available_tools,
    resolved_available_tools,
)


class CompositeToolsetTest(unittest.TestCase):
    """R1：纯组合 toolset 必须能解析出真实可用的工具。"""

    def test_safe_resolves_available_tools(self) -> None:
        """safe = web + vision + image_gen，其工具应可解析。

        出厂态下 web_search/web_extract 可用；vision/image_gen 需凭据，
        因此这里断言「至少解析出 web 那两个」，而不是要求全部可用。
        """
        available, unavailable = resolved_available_tools(("safe",))
        self.assertIn("web_search", available, "web_search 应可用（Phase 1 已修 _wt）")
        self.assertIn("web_extract", available)
        # 不可用的必须被**报告**，而不是消失
        self.assertTrue(
            set(available) | set(unavailable),
            "safe 至少要解析出工具",
        )

    def test_git_resolves_terminal(self) -> None:
        """git 无独立工具，经 terminal 满足 —— 且 terminal 确实可用。"""
        available, _ = resolved_available_tools(("git",))
        self.assertIn("terminal", available)

    def test_developer_core_tools_available(self) -> None:
        """developer 的核心工具必须全部可用（Phase 2b 的前提）。"""
        available, _ = resolved_available_tools(("file", "terminal", "todo", "git"))
        for tool in ("read_file", "write_file", "patch", "search_files",
                     "terminal", "process", "todo"):
            with self.subTest(tool=tool):
                self.assertIn(tool, available, f"{tool} 应可用")

    def test_available_and_unavailable_are_disjoint(self) -> None:
        available, unavailable = resolved_available_tools(("safe", "media", "file"))
        self.assertEqual(set(available) & set(unavailable), set(),
                         "同一工具不能既可用又不可用")

    def test_filter_available_tools_matches_pair(self) -> None:
        for names in (("safe",), ("media",), ("file", "terminal")):
            with self.subTest(names=names):
                available, _ = resolved_available_tools(names)
                self.assertEqual(filter_available_tools(names), available)

    def test_all_agents_have_at_least_one_available_tool(self) -> None:
        """任何 agent 都不能「一个工具都拿不到」—— 那是静默失效。"""
        for agent in ("ceo", "operations", "marketing", "developer", "devops"):
            with self.subTest(agent=agent):
                report = capability_report(agent)
                self.assertTrue(
                    report.available_tools,
                    f"{agent} 解析不到任何可用工具：{report.unavailable_tools}",
                )

    def test_report_separates_available_from_unavailable(self) -> None:
        report = capability_report("marketing")
        # media 依赖 image_gen/video_gen/tts/vision —— 出厂态部分缺凭据
        self.assertTrue(report.available_tools, "marketing 应有可用工具（business/memory/web）")
        self.assertEqual(
            set(report.available_tools) & set(report.unavailable_tools), set(),
        )
        # 两者并集应等于解析出的全部工具
        self.assertEqual(
            set(report.available_tools) | set(report.unavailable_tools),
            set(report.resolved_tools),
        )

    def test_developer_report_has_write_path(self) -> None:
        """Phase 2b 前提：developer 报告里写路径工具齐全。"""
        report = capability_report("developer")
        for tool in ("read_file", "write_file", "patch", "search_files", "terminal"):
            with self.subTest(tool=tool):
                self.assertIn(tool, report.available_tools)

    def test_ceo_still_excluded_from_file_tools(self) -> None:
        """fail-closed 未被削弱。"""
        report = capability_report("ceo")
        for tool in ("read_file", "write_file", "patch", "terminal"):
            with self.subTest(tool=tool):
                self.assertNotIn(tool, report.available_tools)


if __name__ == "__main__":
    unittest.main(verbosity=2)
