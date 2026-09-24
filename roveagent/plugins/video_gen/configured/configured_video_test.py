"""新视频后端（configured）与基类两个钩子的行为锁定。

## 背景：为什么会有这个后端

运行时自带的三个视频后端各自要一份独立第三方凭证（FAL_KEY / XAI_API_KEY /
DEEPINFRA_API_KEY）。而老板在「设置 → AI 服务商」里配置的那家 OpenAI 兼容服务商
自己就提供视频模型（实测 `agnes-video-2.5-flash` / `agnes-video-v2.0`），却没有任何
后端会去用它 —— 视频模型能被识别、能被分类，但永远出不了片。

## 两处真实缺陷（都是实测出来的，不是推测）

1. **LiteLLM 风格网关要求 `mode` 字段**，不带就 400：

       POST /v1/videos {"model": ...}
       -> {"code":"invalid_request","message":"mode is required","data":{"param":"mode"}}

   基类原先只发送一组固定字段，没有注入厂商特有字段的位置 → 加了
   `_provider_extra_body()` 钩子。

2. **输出地址在顶层 `url`，而且该网关没有实现 `GET /videos/{id}/content`**：

       完成任务 JSON: {"status":"completed","progress":100,
                      "perf_output_size":2373927,
                      "url":"https://platform-outputs.agnes-ai.space/videos/…/video_….mp4"}
       GET /videos/{id}/content -> HTTP 502 + <!DOCTYPE html>

   基类只扫 OpenAI 的 `data[].url`，扫不到就退到 SDK 的 `download_content`，
   于是永远得到 `"no output could be retrieved: <!DOCTYPE html>"` → 加了
   `_output_url()` 钩子。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "test-key")

from roveagent.core.video_gen_provider import OpenAICompatibleVideoGenProvider  # noqa: E402
from roveagent.plugins.video_gen.configured import (  # noqa: E402
    ConfiguredEndpointVideoGenProvider,
)


class _FakeVideo:
    """最小替身：只带基类会读的字段。"""

    def __init__(self, *, status: str = "failed", url: str | None = None,
                 data: list | None = None, vid: str = "vid-1") -> None:
        self.status = status
        self.url = url
        self.data = data if data is not None else []
        self.id = vid
        self.error = "synthetic"

    def model_dump(self) -> dict:
        return {"id": self.id, "status": self.status, "url": self.url, "data": self.data}


class _ConcreteBase(OpenAICompatibleVideoGenProvider):
    """基类是抽象的（`name` 未实现），测试基类默认行为需要一个最小具体子类。"""

    name = "test-base"
    _env_key = "TEST_BASE_KEY"


class _CapturingProvider(ConfiguredEndpointVideoGenProvider):
    """捕获 call_kwargs 后立刻以 failed 结束，避免真的发起下载。"""

    captured: dict | None = None

    def _api_key(self) -> str:  # 让 generate() 不因缺 key 提前返回
        return "test-key"

    def default_model(self):  # 不查真实目录：本测试只关心请求体
        return "test-model"

    def _create_and_poll(self, client, call_kwargs):  # noqa: ANN001
        _CapturingProvider.captured = call_kwargs
        return _FakeVideo(status="failed")


class OutputUrlTest(unittest.TestCase):
    """取输出地址：默认走 OpenAI 形状，configured 走顶层 url。"""

    def test_base_default_reads_openai_data_url(self) -> None:
        base = _ConcreteBase()
        video = _FakeVideo(data=[{"url": "https://cdn.example/a.mp4"}])
        self.assertEqual(base._output_url(video), "https://cdn.example/a.mp4")

    def test_base_default_ignores_top_level_url(self) -> None:
        """负向对照：基类**不认**顶层 url —— 这正是本缺陷的成因。"""
        base = _ConcreteBase()
        video = _FakeVideo(url="https://platform-outputs.example/v.mp4")
        self.assertIsNone(
            base._output_url(video),
            "基类只扫 data[].url；若它开始认顶层 url，本后端的覆盖就不再是必需的",
        )

    def test_configured_reads_top_level_url(self) -> None:
        provider = ConfiguredEndpointVideoGenProvider()
        url = "https://platform-outputs.agnes-ai.space/videos/agnes-video-v2.0/video_x.mp4"
        self.assertEqual(provider._output_url(_FakeVideo(url=url)), url)

    def test_configured_prefers_openai_shape_when_present(self) -> None:
        """两种形状同时存在时以 OpenAI 形状优先（保持与其它后端一致）。"""
        provider = ConfiguredEndpointVideoGenProvider()
        video = _FakeVideo(url="https://top/v.mp4", data=[{"url": "https://data/v.mp4"}])
        self.assertEqual(provider._output_url(video), "https://data/v.mp4")

    def test_configured_returns_none_without_any_url(self) -> None:
        provider = ConfiguredEndpointVideoGenProvider()
        self.assertIsNone(provider._output_url(_FakeVideo()))

    def test_configured_falls_back_to_model_extra(self) -> None:
        """SDK 把未知字段收进 model_extra 时也要能取到。"""

        class _ExtraOnly:
            status = "completed"
            id = "v2"
            data: list = []
            model_extra = {"url": "https://extra/v.mp4"}

            def model_dump(self) -> dict:
                return {"id": "v2"}

        provider = ConfiguredEndpointVideoGenProvider()
        self.assertEqual(provider._output_url(_ExtraOnly()), "https://extra/v.mp4")


class ExtraBodyTest(unittest.TestCase):
    """mode 必须真的进入请求体，且可关闭。"""

    def _captured_extra_body(self) -> dict:
        _CapturingProvider.captured = None
        provider = _CapturingProvider()
        provider.generate("a cat")
        self.assertIsNotNone(_CapturingProvider.captured, "未捕获到 call_kwargs")
        return dict(_CapturingProvider.captured.get("extra_body") or {})

    def test_default_sends_ti2vid(self) -> None:
        original = os.environ.pop("ROVEAGENT_VIDEO_MODE", None)
        try:
            self.assertEqual(self._captured_extra_body().get("mode"), "ti2vid")
        finally:
            if original is not None:
                os.environ["ROVEAGENT_VIDEO_MODE"] = original

    def test_empty_env_omits_the_field(self) -> None:
        """对接严格的 OpenAI 官方端点时可以关掉该字段。"""
        original = os.environ.get("ROVEAGENT_VIDEO_MODE")
        os.environ["ROVEAGENT_VIDEO_MODE"] = ""
        try:
            self.assertNotIn("mode", self._captured_extra_body())
        finally:
            if original is None:
                os.environ.pop("ROVEAGENT_VIDEO_MODE", None)
            else:
                os.environ["ROVEAGENT_VIDEO_MODE"] = original

    def test_env_override_wins(self) -> None:
        original = os.environ.get("ROVEAGENT_VIDEO_MODE")
        os.environ["ROVEAGENT_VIDEO_MODE"] = "keyframes"
        try:
            self.assertEqual(self._captured_extra_body().get("mode"), "keyframes")
        finally:
            if original is None:
                os.environ.pop("ROVEAGENT_VIDEO_MODE", None)
            else:
                os.environ["ROVEAGENT_VIDEO_MODE"] = original

    def test_negative_control_base_class_sends_no_mode(self) -> None:
        """负向对照：基类不会发送 mode —— 证明上面测的是钩子而非巧合。"""
        self.assertEqual(_ConcreteBase()._provider_extra_body(), {})


class AvailabilityTest(unittest.TestCase):
    """两者齐备才算可用（fail-closed），否则把选主权让给其它后端。"""

    def _with_env(self, base: str | None, key: str | None) -> bool:
        saved = {k: os.environ.get(k) for k in ("ROVEAGENT_LLM_BASE_URL", "ROVEAGENT_LLM_API_KEY")}
        try:
            for name, value in (("ROVEAGENT_LLM_BASE_URL", base), ("ROVEAGENT_LLM_API_KEY", key)):
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            return ConfiguredEndpointVideoGenProvider().is_available()
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_available_only_when_both_present(self) -> None:
        self.assertTrue(self._with_env("https://hub.example/v1", "sk-x"))
        self.assertFalse(self._with_env("https://hub.example/v1", None), "缺 key 必须不可用")
        self.assertFalse(self._with_env(None, "sk-x"), "缺 base URL 必须不可用")
        self.assertFalse(self._with_env("", ""), "空串必须不可用")


if __name__ == "__main__":
    unittest.main()
