"""Phase 3 验证：Command Policy Layer（R16）+ Plugin Security Envelope。

Command Policy 的验收重点是**分类正确性**与**默认不改变行为**：
- 只读命令判 read
- 破坏性判 destructive
- 复合命令按最严段定级
- 默认（未设 env）只分类不阻断
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

from roveagent.api.command_policy import (  # noqa: E402
    READ_ONLY_CLASSES,
    CommandClass,
    classify_command,
    classify_commands,
    command_policy_enabled,
    extract_command,
)


class ReadOnlyClassificationTest(unittest.TestCase):
    """只读命令必须判 read —— 这是 DevOps 只读能力的基础。"""

    READ_ONLY = (
        "ps aux",
        "tasklist",
        "top",
        "uptime",
        "df -h",
        "free -m",
        "cat /var/log/syslog",
        "tail -n 100 app.log",
        "ls -la",
        "whoami",
        "hostname",
        "wmic OS get FreePhysicalMemory",
        "netstat -an",
        "ipconfig",
        "docker ps",
        "docker images",
        "docker logs --tail 50 web",
        "docker inspect web",
        "docker stats",
        "systemctl status nginx",
        "systemctl is-active nginx",
        "sc query mock-service",
        "service nginx status",
        "journalctl -n 50 --no-pager",
        "wevtutil qe System /c:5 /f:text",
        "git status --short",
        "git log --oneline -5",
        "kubectl get pods",
        "kubectl describe pod web",
        "kubectl logs web",
        "helm list",
    )

    def test_read_only_commands(self) -> None:
        for command in self.READ_ONLY:
            with self.subTest(command=command):
                verdict = classify_command(command)
                self.assertEqual(
                    verdict.classification, CommandClass.READ,
                    f"{command!r} 应判只读，实际 {verdict.classification}",
                )
                self.assertTrue(verdict.read_only)
                self.assertFalse(verdict.requires_approval)


class DestructiveClassificationTest(unittest.TestCase):
    DESTRUCTIVE = (
        "kill 1234",
        "killall nginx",
        "pkill -f node",
        "taskkill /PID 1234 /F",
        "rm -rf /tmp/x",
        "rmdir /s /q C:\\temp",
        "del /f file.txt",
        "truncate -s 0 app.log",
        "dd if=/dev/zero of=/dev/sda",
        "mkfs.ext4 /dev/sdb1",
        "dropdb prod",
        "shutdown -h now",
        "reg delete HKLM\\Software\\X /f",
    )

    def test_destructive_commands(self) -> None:
        for command in self.DESTRUCTIVE:
            with self.subTest(command=command):
                verdict = classify_command(command)
                self.assertEqual(
                    verdict.classification, CommandClass.DESTRUCTIVE,
                    f"{command!r} 应判破坏性，实际 {verdict.classification}",
                )
                self.assertFalse(verdict.read_only)
                self.assertTrue(verdict.requires_approval)


class MutateAndDeployTest(unittest.TestCase):
    def test_mutate_commands(self) -> None:
        for command in (
            "systemctl restart nginx",
            "systemctl stop nginx",
            "sc stop mock-service",
            "docker restart web",
            "docker compose down",
            "kubectl rollout restart deploy/web",
            "chmod 777 /tmp/x",
            "mv a.txt b.txt",
        ):
            with self.subTest(command=command):
                verdict = classify_command(command)
                self.assertEqual(verdict.classification, CommandClass.MUTATE,
                                 f"{command!r} 实际 {verdict.classification}")
                self.assertTrue(verdict.requires_approval)

    def test_deploy_commands(self) -> None:
        for command in (
            "deploy production",
            "docker compose up -d",
            "terraform apply",
            "helm upgrade web ./chart",
            "kubectl apply -f k8s/",
        ):
            with self.subTest(command=command):
                verdict = classify_command(command)
                self.assertEqual(verdict.classification, CommandClass.DEPLOY,
                                 f"{command!r} 实际 {verdict.classification}")
                self.assertTrue(verdict.requires_approval)

    def test_unknown_is_fail_closed(self) -> None:
        """无法识别的命令按 mutate（需审批）处理，绝不默认放行。"""
        for command in ("frobnicate --all", "./mystery-script.sh", "somebinary x"):
            with self.subTest(command=command):
                verdict = classify_command(command)
                self.assertFalse(verdict.read_only, f"{command!r} 不得被判只读")
                self.assertTrue(verdict.requires_approval)


class CompositeCommandTest(unittest.TestCase):
    """复合命令按**最严**一段定级 —— 否则只读前段会掩护破坏性后段。"""

    def test_read_then_destructive_is_destructive(self) -> None:
        verdict = classify_command("tasklist && taskkill /PID 1 /F")
        self.assertEqual(verdict.classification, CommandClass.DESTRUCTIVE)

    def test_read_only_chain_stays_read(self) -> None:
        verdict = classify_command("ps aux && df -h")
        self.assertEqual(verdict.classification, CommandClass.READ)
        self.assertTrue(verdict.read_only)

    def test_pipe_with_destructive(self) -> None:
        verdict = classify_command("cat app.log | rm -f x")
        self.assertEqual(verdict.classification, CommandClass.DESTRUCTIVE)

    def test_semicolon_and_or(self) -> None:
        for command in (
            "tasklist; taskkill /F /IM node.exe",
            "df -h || systemctl restart nginx",
            "uptime\nrm -rf /tmp/x",
        ):
            with self.subTest(command=command):
                self.assertNotEqual(classify_command(command).classification,
                                    CommandClass.READ)

    def test_segments_recorded(self) -> None:
        verdict = classify_command("ps aux && df -h")
        self.assertEqual(len(verdict.segments), 2)
        for segment in verdict.segments:
            self.assertEqual(segment["classification"], CommandClass.READ)


class DefaultBehaviourTest(unittest.TestCase):
    """**关键**：默认不得强制 —— 否则会静默改变既有部署的放行结果。"""

    def test_policy_disabled_by_default(self) -> None:
        previous = os.environ.pop("ROVEAGENT_COMMAND_POLICY", None)
        try:
            self.assertFalse(
                command_policy_enabled(),
                "默认必须为「只分类不阻断」，启用强制需显式设 env",
            )
        finally:
            if previous is not None:
                os.environ["ROVEAGENT_COMMAND_POLICY"] = previous

    def test_policy_enabled_requires_explicit_value(self) -> None:
        previous = os.environ.get("ROVEAGENT_COMMAND_POLICY")
        try:
            for value in ("enforce", "1", "true", "on"):
                os.environ["ROVEAGENT_COMMAND_POLICY"] = value
                with self.subTest(value=value):
                    self.assertTrue(command_policy_enabled())
            for value in ("off", "0", "false", ""):
                os.environ["ROVEAGENT_COMMAND_POLICY"] = value
                with self.subTest(value=value):
                    self.assertFalse(command_policy_enabled())
        finally:
            if previous is None:
                os.environ.pop("ROVEAGENT_COMMAND_POLICY", None)
            else:
                os.environ["ROVEAGENT_COMMAND_POLICY"] = previous


class ExtractCommandTest(unittest.TestCase):
    def test_string_form(self) -> None:
        self.assertEqual(extract_command({"command": "ps aux"}), "ps aux")

    def test_list_form(self) -> None:
        self.assertEqual(
            extract_command({"command": ["ps aux", "df -h"]}), "ps aux && df -h",
        )

    def test_missing_returns_none(self) -> None:
        for args in ({}, {"other": 1}, None, "not-a-dict"):
            with self.subTest(args=args):
                self.assertIsNone(extract_command(args))

    def test_empty_command_is_not_read_only(self) -> None:
        verdict = classify_command("")
        self.assertFalse(verdict.read_only)

    def test_read_only_classes_only_contains_read(self) -> None:
        self.assertEqual(set(READ_ONLY_CLASSES), {CommandClass.READ})

    def test_batch_classification(self) -> None:
        verdicts = classify_commands(["ps aux", "rm -rf /"])
        self.assertEqual(len(verdicts), 2)
        self.assertTrue(verdicts[0].read_only)
        self.assertFalse(verdicts[1].read_only)


if __name__ == "__main__":
    unittest.main(verbosity=2)
