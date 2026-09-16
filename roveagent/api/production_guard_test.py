"""Phase 12 / R-07 —— ROVEAGENT_TEST_MODE 的代码级生产护栏。

背景：该变量此前只被 ``scripts/roveagent-service.sh`` 读取，``app.py`` 完全不认。
护栏因此取决于"用哪个脚本启动"，而绕过脚本直接起 uvicorn 是完全常规的做法
（部署平台重启、本地调试、自定义编排）。TEST_MODE 一旦生效，内核会接受
Mock LLM —— 在生产里等于允许返回编造内容。

本文件锁定：生产信号存在时，TEST_MODE 必须让 ``create_app()`` **拒绝启动**，
且只有显式的 ``ROVEAGENT_ALLOW_TEST_MODE=1`` 可以放行。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

_GUARD_VARS = (
    "ROVEAGENT_TEST_MODE",
    "ROVEAGENT_ALLOW_TEST_MODE",
    "ROVEAGENT_ENV",
    "COZE_PROJECT_ENV",
    "APP_ENV",
)


class TestModeProductionGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in _GUARD_VARS}
        for key in _GUARD_VARS:
            os.environ.pop(key, None)
        os.environ.setdefault("ROVEAGENT_OFFLINE", "1")

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _create(self):
        from roveagent.api.app import create_app

        return create_app()

    def test_test_mode_is_refused_in_production(self) -> None:
        os.environ["ROVEAGENT_TEST_MODE"] = "true"
        os.environ["ROVEAGENT_ENV"] = "production"
        with self.assertRaises(RuntimeError) as ctx:
            self._create()
        self.assertIn("TEST_MODE", str(ctx.exception))

    def test_test_mode_is_refused_for_each_production_signal(self) -> None:
        os.environ["ROVEAGENT_TEST_MODE"] = "true"
        for var in ("ROVEAGENT_ENV", "COZE_PROJECT_ENV", "APP_ENV"):
            with self.subTest(signal=var):
                for key in ("ROVEAGENT_ENV", "COZE_PROJECT_ENV", "APP_ENV"):
                    os.environ.pop(key, None)
                os.environ[var] = "PROD"
                with self.assertRaises(RuntimeError):
                    self._create()

    def test_explicit_opt_in_allows_test_mode_in_staging(self) -> None:
        os.environ["ROVEAGENT_TEST_MODE"] = "true"
        os.environ["ROVEAGENT_ENV"] = "production"
        os.environ["ROVEAGENT_ALLOW_TEST_MODE"] = "1"
        app = self._create()  # 不得抛错
        self.assertIsNotNone(app)

    def test_production_without_test_mode_starts_normally(self) -> None:
        os.environ["ROVEAGENT_ENV"] = "production"
        app = self._create()
        self.assertIsNotNone(app)

    def test_development_with_test_mode_starts_normally(self) -> None:
        os.environ["ROVEAGENT_TEST_MODE"] = "true"
        app = self._create()
        self.assertIsNotNone(app)


if __name__ == "__main__":
    unittest.main()
