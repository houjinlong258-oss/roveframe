"""Phase 15 —— AI 员工的工具白名单必须与 Gate 策略一致。

## 为什么需要这组测试

联网检索（``web_search`` / ``web_extract``）在运行时**早已注册**，
Gate 策略也**早已登记**（``framework.py`` 的 Phase 9 段）。
但 CEO 员工的工具白名单 glob 是 ``read_*`` / ``*_sales`` ——
两者都不匹配 ``web_search``，于是 **Agent 实际上无法联网检索**：
老板问"这个食材现在什么行情"只能答"查不到"。

也就是说该能力缺失既不是"没实现"也不是"没登记策略"，
而是**第三处**（员工白名单）没接上。三处的一致性没有测试守着，
所以这次能潜伏很久。

## 这里断言什么

1. CEO 员工的白名单确实覆盖联网检索工具；
2. 这些工具的 Gate 策略存在（否则 Phase 9 的 default-deny 会拒绝它们）；
3. 反向对照：白名单里**不应该**出现未登记策略的工具 ——
   那种工具会"出现在列表里但每次调用都被拒"，模型会反复尝试，
   比不开放更糟。
"""
from __future__ import annotations

import fnmatch
import unittest

from roveagent.tools.framework import DEFAULT_POLICIES
from roveagent.workforce.employees import build_workforce

#: 本次要保证可用的联网检索工具
WEB_TOOLS = ("web_search", "web_extract")


def _allowed_by_whitelist(tool: str) -> bool:
    """员工白名单的匹配语义：glob（`read_*` / `*_sales` 等）。"""
    ceo = next(e for e in build_workforce() if e.key == "ceo")
    return any(fnmatch.fnmatchcase(tool, pat) for pat in ceo.tools)


def _has_policy(tool: str) -> bool:
    return any(p.pattern == tool or fnmatch.fnmatchcase(tool, p.pattern)
               for p in DEFAULT_POLICIES)


class WebToolReachabilityTest(unittest.TestCase):
    def test_ceo_whitelist_covers_web_tools(self) -> None:
        """CEO 能用到联网检索 —— 这正是 Phase 15 修掉的那个缺口。"""
        for tool in WEB_TOOLS:
            self.assertTrue(
                _allowed_by_whitelist(tool),
                f"CEO 白名单未覆盖 {tool}：联网检索对 Agent 不可用。"
                f"当前白名单 = {next(e for e in build_workforce() if e.key == 'ceo').tools}",
            )

    def test_web_tools_have_gate_policies(self) -> None:
        """白名单放行的工具必须有 Gate 策略，否则会被 default-deny 拒绝。"""
        for tool in WEB_TOOLS:
            self.assertTrue(
                _has_policy(tool),
                f"{tool} 没有 Gate 策略 —— Phase 9 之后兜底为 DENY，"
                f"只改白名单会让它每次调用都被拒（比不开放更糟）",
            )

    def test_no_whitelisted_ceo_tool_lacks_a_policy(self) -> None:
        """反向对照：白名单里的每个具体工具都必须有策略。

        只检查白名单中**不含通配符**的条目 —— 通配符（如 `read_*`）展开后
        覆盖大量工具，其中部分本来就没有策略（它们由更早的显式行或
        兜底语义处理），逐个断言会变成脆弱测试。
        """
        ceo = next(e for e in build_workforce() if e.key == "ceo")
        concrete = [t for t in ceo.tools if not any(c in t for c in "*?[")]
        missing = [t for t in concrete if not _has_policy(t)]
        self.assertEqual(
            missing, [],
            f"这些工具在白名单里但没有 Gate 策略，调用必被拒: {missing}",
        )
        # 确保这条测试**真的在检查东西**：白名单里应当有具体条目
        self.assertGreater(
            len(concrete), 0,
            "白名单里没有具体（非通配）工具 —— 本测试退化为空断言，请复查",
        )


if __name__ == "__main__":
    unittest.main()
