"""端到端：高影响安装的「挂起 → 批准 → 落地」回放管线。

为什么单独测这条：``Skill_Fetch_Design.md`` 的核心安全主张是
「低影响自动装、高影响必须人批，且批准授予的能力来自**记录**而不是请求」。
策略层（``install_policy_test``）和取回层（``fetcher_test``）各自已覆盖，
但两者之间的**回放管线**此前只有"挂起"那一步被验证过 —— 而管线的正确性
正是「谁能授予能力」这个问题的答案所在。

做法：不构造高影响技能（那需要猜 manifest 的能力声明格式），而是把
``decide_install_policy`` 注入成固定返回 NEEDS_APPROVAL，从而只验证管线本身；
阈值判定本身由 install_policy_test 覆盖。两段组合起来才等于"高影响必须人批"。

隔离：pending 队列与技能库都重定向到临时目录，绝不碰真实的
``get_roveagent_home()`` 与 skills 目录。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from roveagent.skills_market import install_policy as policy_mod
from roveagent.skills_market.install_policy import (
    InstallDisposition,
    InstallPolicyDecision,
)
from roveagent.skills_market.permissions import Capability
from roveagent.tools import skill_manager_tool as smt
from roveagent.tools import write_approval as wa

#: 仓库里一个真实存在的技能目录，避免凭猜构造 manifest。
REAL_SKILL = Path("roveagent/skills_library/restaurant/daily-briefing")


def _forced_policy_factory(real):
    """把**原** ``_install_policy_for`` 闭包进来，返回自洽的 (plan, decision, requested)。

    注入点选在 ``_install_policy_for`` 而不是 ``decide_install_policy``：后者只决定
    处置，而记录里的授权集合来自 plan 算出的 requested。若只把它换成"因 shell 需
    审批"，就会出现"策略说要 shell、requested 里却没有 shell"的不可能状态 ——
    真实流程里不可能发生（``decide_install_policy`` 只在 requested ∩ HIGH_IMPACT
    非空时才返回 NEEDS_APPROVAL）。

    必须经由 ``real`` 调用原实现：直接调 ``smt._install_policy_for`` 会调到自己
    （补丁已经装上去了），初版就是这么写成无限递归的。
    """

    def _forced(source_path):
        plan, _decision, _requested = real(source_path)
        return (
            plan,
            InstallPolicyDecision(
                disposition=InstallDisposition.NEEDS_APPROVAL,
                reason="needs approval: shell:execute",
                high_impact=("shell:execute",),
            ),
            frozenset(_requested) | {Capability.SHELL_EXECUTE},
        )

    return _forced


class ReplayPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.lib = root / "library"
        self.lib.mkdir()
        self.pending = root / "pending"
        self.pending.mkdir()

        self._real_skills_dir = smt._skills_dir
        self._real_pending_dir = wa._pending_dir
        self._real_policy_for = smt._install_policy_for
        smt._skills_dir = lambda: self.lib
        wa._pending_dir = lambda subsystem: self.pending / subsystem

    def tearDown(self) -> None:
        smt._skills_dir = self._real_skills_dir
        wa._pending_dir = self._real_pending_dir
        smt._install_policy_for = self._real_policy_for
        self._tmp.cleanup()

    def _record(self, pending_id: str) -> dict:
        rec = wa.get_pending(wa.SKILLS, pending_id)
        self.assertIsNotNone(rec, "stage_write 之后读不到 pending 记录")
        return rec

    def test_high_impact_install_stages_then_replays_from_the_record(self) -> None:
        self.assertTrue(REAL_SKILL.is_dir(), "测试源技能目录不存在")
        smt._install_policy_for = _forced_policy_factory(self._real_policy_for)

        # 阶段 1：挂起。库里必须一个字节都没变。
        staged = json.loads(smt.skill_manage(action="install", source=str(REAL_SKILL)))
        self.assertTrue(staged.get("staged"), staged)
        self.assertIsNone(staged.get("installed"))
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), [],
                         "挂起阶段不得写库")

        # 记录里必须带着授权集合 —— 那是人批准时看到的东西。
        rec = self._record(staged["pending_id"])
        payload = rec.get("payload", rec)
        self.assertEqual(payload.get("action"), "install")
        self.assertEqual(payload.get("source"), str(REAL_SKILL))
        self.assertTrue(payload.get("granted"), "批准记录里没有授权集合")
        self.assertIn("shell:execute", payload["granted"])

        # 阶段 2：批准后回放。库必须落地。
        replayed = json.loads(smt.apply_skill_pending(payload))
        self.assertTrue(replayed.get("installed"), replayed)
        self.assertIn("shell:execute", replayed.get("granted", []))
        landed = sorted(p for p in self.lib.rglob("daily-briefing") if p.is_dir())
        self.assertTrue(landed, "批准回放后技能没有落地")
        # 记录实际落点：安装走的是 <library>/<category>/<name>，不是平铺。
        self.assertTrue(str(landed[0]).startswith(str(self.lib)))

    def test_replay_without_recorded_grants_fails_closed(self) -> None:
        # 记录被篡改/丢失授权时的行为：拒绝，不猜。
        poisoned = {"action": "install", "source": str(REAL_SKILL)}
        result = json.loads(smt.apply_skill_pending(poisoned))
        self.assertFalse(result.get("success"), result)
        self.assertIn("no recorded grants", str(result.get("error")))
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), [],
                         "无授权的回放不得写库")

    def test_replay_of_a_vanished_quarantine_is_refused(self) -> None:
        # 隔离区被清理后（例如超时清理或重启），回放必须明确报错而不是半装。
        gone = {"action": "install", "source": str(self.pending / "nope"),
                "granted": ["files:read"]}
        result = json.loads(smt.apply_skill_pending(gone))
        self.assertFalse(result.get("success"), result)
        self.assertIn("gone", str(result.get("error")))
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), [])

    def test_auto_install_does_not_stage(self) -> None:
        # 反向对照：同一个源、同一个管线，低影响时**不**产生 pending 记录。
        self.assertTrue(REAL_SKILL.is_dir())
        result = json.loads(smt.skill_manage(action="install", source=str(REAL_SKILL)))
        self.assertTrue(result.get("installed"), result)
        self.assertIsNone(result.get("staged"))
        self.assertEqual(wa.pending_count(wa.SKILLS), 0,
                         "低影响安装不该留下待批准记录")


if __name__ == "__main__":
    unittest.main()
