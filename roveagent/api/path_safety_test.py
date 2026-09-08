"""P0-10：tenant_id / 技能名白名单净化与路径穿越防护测试。

覆盖：
- require_safe_id / sanitize_skill_name 单元行为；
- 请求模型（ChatRequest 等）对穿越型 tenant_id fail-closed 拒绝；
- marketplace.install 对非法 tenant_id 返回 None 且不产生目录写入。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from roveagent.api.security import require_safe_id, sanitize_skill_name
from roveagent.skills.marketplace import install


def _chat_payload() -> dict:
    return {
        "tenant_id": "t-1",
        "business_id": "b-1",
        "user_id": "u-1",
        "message": "hello",
        "agent": "ceo",
        "role": "owner",
        "permissions": [],
        "request_id": "r1",
        "task_id": "t1",
        "session_id": "s1",
        "industry": "restaurant",
        "business_context": "ctx",
    }


class TenantIdSanitizationTest(unittest.TestCase):
    def test_require_safe_id_accepts_whitelisted(self) -> None:
        self.assertEqual(require_safe_id("tenant-abc_123"), "tenant-abc_123")
        self.assertEqual(require_safe_id("A"), "A")

    def test_require_safe_id_rejects_traversal_and_illegal(self) -> None:
        for bad in ("../../x", "a/b", "..", ".", "a b", "a.b", "%2e%2e",
                    "a\\b", "", "x" * 65):
            with self.assertRaises(ValueError, msg=bad):
                require_safe_id(bad)

    def test_sanitize_skill_name(self) -> None:
        self.assertEqual(sanitize_skill_name("Refund SOP!"), "refundsop")
        self.assertEqual(sanitize_skill_name("Refund-SOP_2"), "refund-sop_2")
        with self.assertRaises(ValueError):
            sanitize_skill_name("../../")
        with self.assertRaises(ValueError):
            sanitize_skill_name("")

    def test_request_models_reject_traversal_tenant_id(self) -> None:
        from roveagent.api.app import (ChatRequest, SkillInstallRequest,
                                       SkillRequest, TaskRequest)
        for model_cls, payload in (
            (ChatRequest, _chat_payload()),
            (TaskRequest, {"tenant_id": "t", "business_id": "b",
                           "objective": "increase sales"}),
            (SkillRequest, {"tenant_id": "t", "business_id": "b",
                            "name": "refund-sop"}),
            (SkillInstallRequest, {"tenant_id": "t", "business_id": "b",
                                   "name": "refund-sop"}),
        ):
            payload = dict(payload)
            payload["tenant_id"] = "../../evil"
            with self.assertRaises(ValidationError):
                model_cls(**payload)
            payload["tenant_id"] = "ok-tenant_1"
            model_cls(**payload)  # 合法输入不抛错

    def test_marketplace_install_rejects_traversal_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = install(root, "../../evil", "refund-sop")
            self.assertIsNone(result)
            # 根目录外不得被创建（../../evil 解析到 tmp 的上级，属于越界）
            self.assertFalse(Path(tmp, "..", "..", "evil").exists())
            # 根内 skills 目录不应被写入
            self.assertFalse((root / "skills" / "tenant-..").exists())

    def test_skill_name_with_slashes_cannot_escape_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = install(root, "t-1", "a/../../b")
            self.assertIsNone(result)
            self.assertFalse((root / "b").exists())


if __name__ == "__main__":
    unittest.main()
