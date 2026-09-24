"""技能库内容完整性 —— 防止"装了个空壳"再次发生。

## 为什么需要

这个仓库在同一个坑里摔过两次：

1. **行业包技能**：`packs/*.json` 只列举技能名，正文必须由 `skills_library/` 提供。
   实测 4 个包共 15 个技能正文全为 0 字符，装进租户后 SKILL.md 只有 121 字节 ——
   HTTP 200、界面显示"安装成功"，而 agent 什么都没多会。
2. **外部技能安装**：`skills_market` 的安装器会对内容做扫描与授权判定，但**不检查正文
   是否为空**（它校验的是清单、能力与安全发现）。也就是说：一个空正文的技能可以
   干净地通过整条流水线并落盘。

两次都不是"崩溃"，而是**静默交付了一个没用的东西** —— 最难发现的一类。

## 守卫什么

`skills_library/**/SKILL.md` 每一条都必须：
  · 有 frontmatter，且含 `name` 与 `description`
  · 正文（去掉 frontmatter 后）不少于 `MIN_BODY_CHARS` 个字符

外部 vendor 进来的技能同样受这条约束 —— 它们和自研技能在库里没有区别。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
LIBRARY = REPO / "roveagent" / "skills_library"

#: 正文下限。定得低是刻意的：只拦"空壳"，不评价写作质量。
MIN_BODY_CHARS = 120

_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def split_skill(text: str) -> tuple[str, str]:
    """返回 (frontmatter, body)；没有 frontmatter 时 frontmatter 为空串。"""
    match = _FRONTMATTER.match(text)
    if not match:
        return "", text
    return match.group(1), text[match.end():]


def problems_with(text: str) -> list[str]:
    """该 SKILL.md 文本违反的不变量（空列表 = 合格）。

    由下面的负向对照证明它能返回非空，否则这条守卫是空转的。
    """
    issues: list[str] = []
    front, body = split_skill(text)
    if not front:
        issues.append("no frontmatter")
    else:
        if not re.search(r"^name:\s*\S", front, re.M):
            issues.append("frontmatter missing `name`")
        if not re.search(r"^description:\s*\S", front, re.M):
            issues.append("frontmatter missing `description`")
    if len(body.strip()) < MIN_BODY_CHARS:
        issues.append(f"body too short ({len(body.strip())} < {MIN_BODY_CHARS})")
    return issues


class SkillLibraryIntegrityTest(unittest.TestCase):
    def test_library_is_not_empty(self) -> None:
        found = sorted(LIBRARY.glob("*/*/SKILL.md"))
        self.assertGreater(len(found), 50, f"技能库看起来没被找到（{len(found)} 条），守卫会空转")

    def test_every_skill_has_frontmatter_and_real_content(self) -> None:
        offenders: list[str] = []
        for md in sorted(LIBRARY.glob("*/*/SKILL.md")):
            issues = problems_with(md.read_text(encoding="utf-8"))
            if issues:
                rel = md.relative_to(REPO)
                offenders.append(f"{rel}: {', '.join(issues)}")
        self.assertEqual(
            offenders, [],
            "以下技能的正文为空或缺 frontmatter —— 装进租户后 agent 拿不到任何指令：\n  "
            + "\n  ".join(offenders),
        )

    def test_vendored_skills_are_covered_by_the_same_rule(self) -> None:
        """外部 vendor 进来的技能与自研技能同规 —— 抽查其中几个。"""
        for name in ("brainstorming", "writing-plans", "verification-before-completion"):
            md = LIBRARY / "software-development" / name / "SKILL.md"
            if not md.exists():
                self.skipTest(f"{name} 未 vendor（可能来源变更），跳过抽查")
            self.assertEqual(problems_with(md.read_text(encoding="utf-8")), [], f"{name} 不合格")

    def test_negative_control_detector_flags_empty_and_headless_content(self) -> None:
        """负向对照：检测器必须能判出"空壳"与"缺 frontmatter"。"""
        empty_body = "---\nname: x\ndescription: y\n---\n\n"
        self.assertIn("body too short (0 < 120)", problems_with(empty_body))

        no_front = "# Title\n\n" + ("content " * 40)
        self.assertIn("no frontmatter", problems_with(no_front))

        missing_desc = "---\nname: x\n---\n\n" + ("content " * 40)
        self.assertIn("frontmatter missing `description`", problems_with(missing_desc))

        good = "---\nname: x\ndescription: y\n---\n\n" + ("content " * 40)
        self.assertEqual(problems_with(good), [], "合格样本不得被判为不合格")

    def test_real_library_would_fail_if_a_body_were_emptied(self) -> None:
        """负向对照（对真实文件）：把正文清空后判据必须变红。"""
        sample = sorted(LIBRARY.glob("*/*/SKILL.md"))[0]
        original = sample.read_text(encoding="utf-8")
        front, _ = split_skill(original)
        emptied = f"---\n{front}\n---\n\n"
        self.assertNotEqual(
            problems_with(emptied), [],
            "真实技能被清空正文后，判据必须报错 —— 否则这条守卫抓不到本次要防的缺陷",
        )


if __name__ == "__main__":
    unittest.main()
