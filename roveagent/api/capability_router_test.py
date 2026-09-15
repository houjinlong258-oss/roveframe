"""Phase 1 验证：Agent Capability Router。

覆盖：
  - 能力画像的 fail-closed 行为
  - toolset → 工具解析（含 registry 归属并集）
  - 漂移检测（声明了但无已注册工具的 toolset）
  - 可用性报告（check_fn 未通过）
  - 与 api/toolsets.py 的一致性（两张表不得各说各话）
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
    AGENT_CAPABILITIES,
    DEFAULT_CAPABILITY,
    MAX_ITERATIONS_CEILING,
    capability_for,
    capability_report,
    planned_max_iterations,
    planned_toolsets,
    reports_for_all_agents,
    resolve_toolset,
)
from roveagent.api.toolsets import _AGENT_RUNTIME  # noqa: E402
from roveagent.toolsets import TOOLSETS  # noqa: E402


class CapabilityProfileTest(unittest.TestCase):
    def test_known_agents_have_profiles(self) -> None:
        for agent in ("ceo", "operations", "marketing", "developer", "devops"):
            with self.subTest(agent=agent):
                self.assertIn(agent, AGENT_CAPABILITIES)

    def test_unknown_agent_fails_closed(self) -> None:
        for agent in ("", "   ", "nobody", "root", "../devops"):
            with self.subTest(agent=agent):
                cap = capability_for(agent)
                self.assertEqual(cap.toolsets, DEFAULT_CAPABILITY.toolsets)
                self.assertNotIn("file", cap.toolsets)
                self.assertNotIn("terminal", cap.toolsets)

    def test_case_and_whitespace_insensitive(self) -> None:
        self.assertEqual(planned_toolsets("  Developer "), planned_toolsets("developer"))

    def test_iteration_budget_respects_ceiling(self) -> None:
        for agent in AGENT_CAPABILITIES:
            with self.subTest(agent=agent):
                self.assertLessEqual(planned_max_iterations(agent), MAX_ITERATIONS_CEILING)

    def test_developer_gets_file_and_terminal(self) -> None:
        toolsets = planned_toolsets("developer")
        self.assertIn("file", toolsets)
        self.assertIn("terminal", toolsets)

    def test_ceo_has_no_file_or_terminal(self) -> None:
        toolsets = planned_toolsets("ceo")
        self.assertNotIn("file", toolsets)
        self.assertNotIn("terminal", toolsets)

    def test_every_referenced_toolset_name_exists(self) -> None:
        """能力画像引用的每个 toolset 名必须在 toolsets.py 中存在。"""
        for agent, cap in AGENT_CAPABILITIES.items():
            for name in cap.toolsets:
                with self.subTest(agent=agent, toolset=name):
                    self.assertIn(name, TOOLSETS, f"{agent} 引用了不存在的 toolset {name}")


class ToolsetResolutionTest(unittest.TestCase):
    def test_file_toolset_resolves_real_tools(self) -> None:
        resolution = resolve_toolset("file")
        self.assertEqual(
            set(resolution.tools),
            {"read_file", "write_file", "patch", "search_files"},
        )
        self.assertTrue(resolution.available, "file 应可用")

    def test_terminal_toolset_includes_process(self) -> None:
        """registry 里 process 归属于 terminal —— 必须出现在解析结果里。"""
        resolution = resolve_toolset("terminal")
        self.assertIn("terminal", resolution.tools)
        self.assertIn("process", resolution.tools)

    def test_git_intent_resolves_to_terminal(self) -> None:
        """git 没有独立工具，意图经 terminal 满足。"""
        resolution = resolve_toolset("git")
        self.assertIn("terminal", resolution.tools)
        self.assertEqual(resolution.declared, ())

    def test_search_toolset_drift_is_detected(self) -> None:
        """search 声明 web_search，但 registry 里 web_search 归属 web。

        因此 search 的 registry_owned 为空 → 漂移。这正是本模块要暴露的问题：
        若 agent 只映射 search，它会静默拿不到工具。
        """
        resolution = resolve_toolset("search")
        self.assertEqual(resolution.declared, ("web_search",))
        self.assertEqual(resolution.registry_owned, ())
        self.assertTrue(resolution.drift, "search 应被标记为漂移")
        # 但声明的工具名仍被保留（并集语义），保证 web_search 不会丢
        self.assertIn("web_search", resolution.tools)

    def test_declared_only_toolsets_are_flagged_empty(self) -> None:
        """git/docker_read/monitoring/media/social 无声明工具 → 视为纯组合。"""
        for name in ("git", "docker_read", "monitoring", "media", "social"):
            with self.subTest(toolset=name):
                resolution = resolve_toolset(name)
                self.assertEqual(resolution.declared, ())
                self.assertTrue(resolution.tools, f"{name} 应通过 includes 解析出工具")


class CapabilityReportTest(unittest.TestCase):
    def test_records_all_agents(self) -> None:
        reports = reports_for_all_agents()
        self.assertEqual(len(reports), len(AGENT_CAPABILITIES))
        for report in reports:
            self.assertTrue(report.known)
            self.assertTrue(report.resolved_tools, f"{report.agent} 解析不到任何工具")

    def test_developer_report_resolves_real_tools(self) -> None:
        report = capability_report("developer")
        for tool in ("read_file", "write_file", "patch", "terminal", "process", "todo"):
            with self.subTest(tool=tool):
                self.assertIn(tool, report.resolved_tools)

    def test_ceo_report_excludes_file_tools(self) -> None:
        report = capability_report("ceo")
        for tool in ("read_file", "write_file", "patch", "terminal"):
            with self.subTest(tool=tool):
                self.assertNotIn(tool, report.resolved_tools)

    def test_unknown_agent_report_is_fail_closed(self) -> None:
        report = capability_report("nobody")
        self.assertFalse(report.known)
        self.assertNotIn("read_file", report.resolved_tools)
        self.assertNotIn("terminal", report.resolved_tools)

    def test_report_surfaces_unavailable_toolsets(self) -> None:
        """缺凭据的 toolset 必须被标为 unavailable，而不是静默消失。"""
        report = capability_report("marketing")
        # media 依赖 image_gen/video_gen/tts/vision —— 出厂态缺凭据
        self.assertTrue(
            report.unavailable_toolsets or report.empty_toolsets,
            "marketing 的能力缺口应被报告出来",
        )


class ConsistencyTest(unittest.TestCase):
    """api/toolsets.py（Step 1.75 表）与 capability_router（Phase 1 表）不得矛盾。"""

    def test_shared_agents_agree_on_core_toolsets(self) -> None:
        for agent, (toolsets, _iters) in _AGENT_RUNTIME.items():
            if agent not in AGENT_CAPABILITIES:
                continue
            router_toolsets = set(planned_toolsets(agent))
            legacy = set(toolsets)
            with self.subTest(agent=agent):
                # Phase 1 是超集：不得丢掉 Step 1.75 已授予的能力
                missing = legacy - router_toolsets
                self.assertEqual(
                    missing, set(),
                    f"{agent}: capability_router 缺少 api/toolsets 已授予的 {sorted(missing)}",
                )

    def test_iteration_budget_agrees(self) -> None:
        for agent, (_toolsets, iterations) in _AGENT_RUNTIME.items():
            if agent not in AGENT_CAPABILITIES:
                continue
            with self.subTest(agent=agent):
                self.assertEqual(planned_max_iterations(agent), iterations)


if __name__ == "__main__":
    unittest.main(verbosity=2)
