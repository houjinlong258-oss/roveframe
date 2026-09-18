"""Phase 15 — 校验 web_search / web_extract 的 Gate 策略行**不会被前面的行抢先匹配**。

`policy_for()` 是**顺序匹配、先命中先生效**（framework.py 的既有注释反复强调这点，
并因此踩过坑：`read_file` 曾被 `read_*` 抢先命中，语义错误）。

因此新增策略行时，必须确认它之前的每一行都不匹配这两个工具名 ——
否则新行是**死行**，而工具仍按前面那行的权限/审批级别执行。

本脚本只读，输出即证据。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SRC = Path("roveagent/tools/framework.py")
TARGETS = ["web_search", "web_extract"]


def matches(pattern: str, name: str) -> bool:
    """复刻 policy_for 的 glob 语义：前缀 *、后缀 *、两侧 *、精确。"""
    if pattern == "*":
        return True
    if pattern.startswith("*") and pattern.endswith("*"):
        return pattern[1:-1] in name
    if pattern.endswith("*"):
        return name.startswith(pattern[:-1])
    if pattern.startswith("*"):
        return name.endswith(pattern[1:])
    return pattern == name


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    start = text.index("DEFAULT_POLICIES")
    # 到 web_search 那一行为止
    anchor = text.index('ToolPolicy("web_search"', start)
    block = text[start:anchor]

    # 按出现顺序取所有 ToolPolicy 的第一个参数
    patterns = re.findall(r'ToolPolicy\(\s*"([^"]+)"', block)
    print(f"web_search 之前共有 {len(patterns)} 条策略")
    print(f"最后 5 条: {patterns[-5:]}")
    print()

    failures: list[str] = []
    for name in TARGETS:
        shadows = [p for p in patterns if matches(p, name)]
        if shadows:
            failures.append(f"{name} 被更早的策略抢先匹配: {shadows}")
            print(f"[FAIL] {name} -> 被 {shadows} 抢先匹配（新行会成为死行）")
        else:
            print(f"[PASS] {name} -> 无更早策略匹配，自己的行生效")

    # 反向对照：确认匹配函数**不是永远返回 False**。
    # 用已知会被前面的行匹配的名字验证（read_orders 应命中 read_*）。
    control = [p for p in patterns if matches(p, "read_orders")]
    if not control:
        print("[FAIL] 阳性对照失败：read_orders 竟然不被任何策略匹配，说明 matches() 有 bug")
        failures.append("阳性对照失败")
    else:
        print(f"[PASS] 阳性对照：read_orders 被 {control} 匹配（匹配函数有效）")

    print()
    if failures:
        print("结论: 策略顺序有问题 —— 新增行不会生效。")
        return 1
    print("结论: 两个 web 工具的策略行均会生效，且匹配函数经阳性对照验证。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
