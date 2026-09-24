"""OpenAI-compatible video generation over the endpoint you already configured.

## 为什么需要这个后端

运行时自带三个视频后端（fal / xai / deepinfra），但它们各自要一份**独立的第三方
凭证**（``FAL_KEY`` / ``XAI_API_KEY`` / ``DEEPINFRA_API_KEY``）。而老板在
「设置 → AI 服务商」里配置的那家 OpenAI 兼容服务商 —— 它自己就提供视频模型 ——
**已经有 key 也有 base URL 了**，却没有任何后端会去用它。结果是：视频模型能被
识别、能被分类（``agnes-video-2.5-flash`` 等），但永远出不了片。

本后端复用**同一个** ``ROVEAGENT_LLM_BASE_URL`` / ``ROVEAGENT_LLM_API_KEY``，
因此不需要用户再申请任何新凭证。

## 协议（实测确认，2026-09-25）

目标是标准 OpenAI Videos 异步任务形状，基类
:class:`~roveagent.core.video_gen_provider.OpenAICompatibleVideoGenProvider`
已经把 create → poll → download 的管线写好，这里只声明身份、凭证与模型发现：

    POST /v1/videos  {"mode":"ti2vid","model":"agnes-video-v2.0","prompt":"..."}
    -> 200 {"id":"task_…","object":"video","status":"queued","progress":0,
            "seconds":"5.0","size":"1088x832"}

    GET /v1/videos/{id}
    -> {"status":"queued","progress":0,"completed_at":null,"error":null,…}

**``mode`` 是这类网关（LiteLLM 风格聚合）特有的必填字段** —— 不带它就返回
``400 {"code":"invalid_request","message":"mode is required"}``，带错值则上游回
``Input should be 'ti2vid', 'keyframes' or 'multi_reference'``。因此这里默认发
``ti2vid``（文/图生视频），可用 ``ROVEAGENT_VIDEO_MODE`` 覆盖，设为空字符串则不发送
该字段（对接严格的 OpenAI 官方端点时用得上）。

## 选主方式

``video_gen_registry.get_active_provider()`` 在未显式配置 ``video_gen.provider``
时，会选中**唯一一个 ``is_available()`` 为真**的后端。本后端只在
``ROVEAGENT_LLM_BASE_URL`` 与 ``ROVEAGENT_LLM_API_KEY`` 都存在时可用，
所以只配了聊天供应商的机器会自动选中它，不需要改 config.yaml。
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional

from roveagent.core.video_gen_provider import OpenAICompatibleVideoGenProvider

logger = logging.getLogger(__name__)

#: 复用聊天供应商已配置的凭证 —— 这是本后端存在的全部意义。
_KEY_ENV = "ROVEAGENT_LLM_API_KEY"
_BASE_URL_ENV = "ROVEAGENT_LLM_BASE_URL"
#: LiteLLM 风格网关的 mode 取值。空字符串 = 不发送该字段。
_MODE_ENV = "ROVEAGENT_VIDEO_MODE"
_DEFAULT_MODE = "ti2vid"

#: 模型清单里哪些 id 算视频模型（命名模式启发式，与 TS 侧 VIDEO_PATTERN 同源思路）。
_VIDEO_ID_PATTERN = re.compile(
    r"(^|[-_/.])(video|t2v|i2v|ti2vid|sora|kling|runway|seedance|veo|hunyuan-video)([-_/.]|$)",
    re.IGNORECASE,
)


class ConfiguredEndpointVideoGenProvider(OpenAICompatibleVideoGenProvider):
    """Text/image-to-video via the OpenAI-compatible endpoint already configured."""

    name = "configured"
    _env_key = _KEY_ENV
    _default_base_url = ""  # 基类默认值无意义，一律走 _base_url() 的环境读取

    @property
    def display_name(self) -> str:
        return "已配置的 OpenAI 兼容端点"

    def _base_url(self) -> str:
        """从 ``ROVEAGENT_LLM_BASE_URL`` 读取，而不是基类的 ``CONFIGURED_BASE_URL``。"""
        return (os.environ.get(_BASE_URL_ENV) or "").strip().rstrip("/")

    def is_available(self) -> bool:
        """两者齐备才算可用 —— 少一个就 fail-closed，交给其它后端。"""
        return bool(self._api_key()) and bool(self._base_url())

    def _provider_extra_body(self) -> Dict[str, Any]:
        mode = os.environ.get(_MODE_ENV, _DEFAULT_MODE).strip()
        return {"mode": mode} if mode else {}

    def _output_url(self, video: Any) -> Optional[str]:
        """任务终态的输出地址在**顶层 ``url``**，不在 OpenAI 的 ``data[].url``。

        实测（2026-09-25，agnes-video-v2.0 完成任务）：

            {"status":"completed","progress":100,"perf_output_size":2373927,
             "url":"https://platform-outputs.agnes-ai.space/videos/…/video_….mp4"}

        且该网关**没有**实现 ``GET /videos/{id}/content``（返回 502 + HTML），
        所以基类的 SDK 下载回退在这里永远不会成功。必须优先读顶层 url。
        """
        url = super()._output_url(video)
        if url:
            return url
        # openai SDK 会把未知字段收进 model_extra；直接 getattr 未必拿得到。
        candidate = getattr(video, "url", None)
        if not candidate:
            dump = video.model_dump() if hasattr(video, "model_dump") else {}
            if isinstance(dump, dict):
                candidate = dump.get("url")
        if not candidate:
            extra = getattr(video, "model_extra", None)
            if isinstance(extra, dict):
                candidate = extra.get("url")
        return str(candidate) if candidate else None

    def list_models(self) -> List[Dict[str, Any]]:
        """从 ``GET /models`` 里挑出视频模型。

        目录不可达时返回空列表（而不是猜一个模型 id）—— 让选择器显示"无可用"，
        好过路由到一个可能已下线的模型。
        """
        base = self._base_url()
        if not base:
            return []
        try:
            import requests
        except Exception as exc:  # noqa: BLE001 — 缺依赖不该让选择器崩
            logger.debug("requests unavailable: %s", exc)
            return []
        try:
            res = requests.get(
                f"{base}/models",
                headers={"Authorization": f"Bearer {self._api_key()}"},
                timeout=20,
            )
            if res.status_code != 200:
                logger.debug("configured video: /models returned %s", res.status_code)
                return []
            payload = res.json()
        except Exception as exc:  # noqa: BLE001
            logger.debug("configured video: /models failed: %s", exc)
            return []

        items = payload.get("data") if isinstance(payload, dict) else None
        out: List[Dict[str, Any]] = []
        for item in items or []:
            mid = item.get("id") if isinstance(item, dict) else None
            if not isinstance(mid, str) or not mid:
                continue
            if not _VIDEO_ID_PATTERN.search(mid):
                continue
            out.append({"id": mid, "display": mid, "strengths": "视频生成"})
        return out

    def default_model(self) -> Optional[str]:
        """优先让用户显式指定，其次取目录里的第一个视频模型。"""
        explicit = (os.environ.get("ROVEAGENT_VIDEO_MODEL") or "").strip()
        if explicit:
            return explicit
        return super().default_model()

    def capabilities(self) -> Dict[str, Any]:
        return {
            "modalities": ["text", "image"],
            "aspect_ratios": ["16:9", "9:16", "1:1"],
            "resolutions": ["480p", "720p", "1080p"],
            "max_duration": 10,
            "min_duration": 1,
            "supports_audio": False,
            "supports_negative_prompt": False,
            "supports_seed": False,
            "supports_upscale": False,
            "max_reference_images": 0,
        }

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": self.display_name,
            "badge": "reuse",
            "tag": "复用「设置 → AI 服务商」里已配置的 OpenAI 兼容端点（含其视频模型）",
            "env_vars": [
                {
                    "key": _BASE_URL_ENV,
                    "prompt": "OpenAI 兼容端点的 base URL（与聊天供应商同一个）",
                    "url": "",
                },
                {
                    "key": _KEY_ENV,
                    "prompt": "该端点的 API key（与聊天供应商同一个）",
                    "url": "",
                },
                {
                    "key": _MODE_ENV,
                    "prompt": f"可选：视频任务模式，默认 {_DEFAULT_MODE}；设为空则不发送该字段",
                    "url": "",
                },
            ],
        }


def register(ctx: Any) -> None:
    """Plugin entry point — wire the provider into the video_gen registry."""
    ctx.register_video_gen_provider(ConfiguredEndpointVideoGenProvider())
