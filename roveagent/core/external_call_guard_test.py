"""Phase 10 / Task 5 —— external_call_guard 测试。

目标：证明在 `ROVEAGENT_OFFLINE=1` 下，辅助通道**不会**构造任何可发起网络请求
的客户端，也**不会**解析付费 provider。

为什么必须存在这个测试：实测 `python -m unittest discover` 会向 OpenRouter /
Nous 发起真实付费请求（日志证据：`Auxiliary client: PAID lane engaged …
may incur real spend`）。环境保护不能依赖「本机恰好没有凭据」。

断言手段不是「看它返回了什么」，而是**把 socket 层打断**后跑完整条解析路径：
如果任何环节真的想连网，`socket.socket.connect` 会抛错并被本测试捕获。
"""
from __future__ import annotations

import os
import socket
import unittest
from unittest.mock import patch

from roveagent.core import auxiliary_client as ac


def _offline_socket(*_args, **_kwargs):
    raise AssertionError("external network access attempted while ROVEAGENT_OFFLINE=1")


class ExternalCallGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._previous = os.environ.get("ROVEAGENT_OFFLINE")
        os.environ["ROVEAGENT_OFFLINE"] = "1"

    def tearDown(self) -> None:
        if self._previous is None:
            os.environ.pop("ROVEAGENT_OFFLINE", None)
        else:
            os.environ["ROVEAGENT_OFFLINE"] = self._previous

    def test_guard_is_env_driven(self) -> None:
        self.assertTrue(ac._offline_guard_active())
        for off in ("0", "false", "no", ""):
            with self.subTest(value=off):
                os.environ["ROVEAGENT_OFFLINE"] = off
                self.assertFalse(ac._offline_guard_active())
        os.environ["ROVEAGENT_OFFLINE"] = "1"
        self.assertTrue(ac._offline_guard_active())

    def test_no_sdk_client_is_constructed_while_offline(self) -> None:
        """客户端构造卡点必须返回探针桩，而不是真实 SDK 客户端。"""
        client = ac._create_openai_client(
            api_key="probe-key", base_url="https://example.invalid/v1",
        )
        self.assertIsInstance(
            client, ac._AuxProbeClientStub,
            "离线时不得构造真实 SDK 客户端（_create_openai_client 是所有构造的共享卡点）",
        )

    def test_openrouter_resolution_short_circuits_without_network(self) -> None:
        """付费车道必须在解析阶段就被短路，且全程不触碰 socket。"""
        with patch.object(socket.socket, "connect", _offline_socket), \
             patch.object(socket.socket, "connect_ex", _offline_socket):
            client, model = ac._try_openrouter()
        self.assertIsNone(client, "离线时 OpenRouter 必须不可用")
        self.assertIsNone(model)

    def test_paid_lane_warning_is_not_emitted_while_offline(self) -> None:
        """`PAID lane engaged` 告警本身即是测试期真实消费的证据；离线时不得出现。"""
        captured: list[str] = []
        original = ac.logger.warning

        def _capture(message, *args, **kwargs):  # type: ignore[no-untyped-def]
            captured.append(str(message) % args if args else str(message))

        ac.logger.warning = _capture  # type: ignore[assignment]
        try:
            ac._try_openrouter()
        finally:
            ac.logger.warning = original  # type: ignore[assignment]

        self.assertFalse(
            [line for line in captured if "PAID lane" in line],
            "离线模式下不得进入付费车道",
        )

    def test_guard_defaults_on_under_the_test_runner(self) -> None:
        """`scripts/run-python-tests.py` 必须默认把闸门打开。"""
        runner = (
            __import__("pathlib").Path(__file__).resolve().parents[2]
            / "scripts" / "run-python-tests.py"
        )
        self.assertTrue(runner.exists(), "测试运行器必须存在（package.json 的 test:python 依赖它）")
        source = runner.read_text(encoding="utf-8")
        self.assertIn("ROVEAGENT_OFFLINE", source)
        self.assertIn('"1"', source)


if __name__ == "__main__":
    unittest.main()
