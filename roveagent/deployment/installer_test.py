"""P0-13：Python healing/installer 死代码安全改造测试。

- 安装器输入白名单：host/ssh_user/app_dir/domain 非法即拒绝；
- 安装器口令：不再硬编码，每计划独立随机；
- healing：提交信息净化、commit_hash 校验、rollback 需真实人工批准
  （无快速通道自批）。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from roveagent.deployment.installer import RoveAgentInstaller
from roveagent.permissions.engine import PermissionEngine
from roveagent.repair.healing import SelfHealingEngine, safe_commit_message


class InstallerInputValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.installer = RoveAgentInstaller(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_valid_inputs_build_plan_with_random_password(self) -> None:
        plan = self.installer.build_plan(
            "db1.example.com", "roveframe.example.com",
            ssh_user="deployer", app_dir="/opt/roveframe",
        )
        self.assertEqual(plan.status, "planned")
        self.assertTrue(len(plan.db_password) >= 16)
        self.assertNotEqual(plan.db_password, "roveframe")
        self.assertIn(plan.db_password, plan.steps[3].command)
        # 口令不落 dry-run 输出之外的任何日志路径：这里只校验不硬编码
        self.assertNotIn("POSTGRES_PASSWORD=roveframe", plan.steps[3].command)

    def test_invalid_inputs_are_rejected(self) -> None:
        cases = [
            dict(host="bad host; rm -rf /", domain="a.com"),
            dict(host="db1.example.com", domain="a.com; touch /tmp/pwn"),
            dict(host="db1.example.com", domain="a.com", ssh_user="root; rm"),
            dict(host="db1.example.com", domain="a.com", app_dir="/opt/rove; rm"),
            dict(host="db1.example.com", domain="not a domain"),
        ]
        for kwargs in cases:
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.installer.build_plan(kwargs["host"], kwargs["domain"],
                                          ssh_user=kwargs.get("ssh_user", "root"),
                                          app_dir=kwargs.get("app_dir", "/opt/roveframe"))


class HealingHardeningTest(unittest.TestCase):
    def test_safe_commit_message_folds_newlines(self) -> None:
        msg = safe_commit_message("bad\nsignature\n--amend", "case-1")
        self.assertNotIn("\n", msg)
        self.assertIn("bad signature --amend", msg)
        self.assertLessEqual(len(msg), 180)

    def test_rollback_requires_real_approval(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            permissions = PermissionEngine()
            engine = SelfHealingEngine(Path(tmp), Path(tmp) / "state", permissions)
            case = engine.report_error("boom", "trace")
            case.commit_hash = "a" * 40
            engine._save(case)
            from roveagent.permissions.engine import ApprovalRequired
            with self.assertRaises(ApprovalRequired):
                engine.rollback(case.case_id)

    def test_rollback_rejects_invalid_commit_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            permissions = PermissionEngine()
            engine = SelfHealingEngine(Path(tmp), Path(tmp) / "state", permissions)
            case = engine.report_error("boom", "trace")
            case.commit_hash = "a; rm -rf /"
            engine._save(case)
            with self.assertRaises(ValueError):
                engine.rollback(case.case_id)


if __name__ == "__main__":
    unittest.main()
