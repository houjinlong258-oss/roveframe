"""Media Hub（Phase 4）—— 图像 / 视频 / 音频 的统一能力面。

「统一」的确切含义
------------------
本模块**不新建 provider 框架**。三类媒体的 provider 早已存在且各自成熟：

    core/image_gen_registry.py     8 个 provider（fal/openai/xai/deepinfra/krea/openrouter/nous）
    core/video_gen_registry.py     3 个 provider（fal/xai/deepinfra）
    core/tts_registry.py           语音合成 provider

本模块做的是**把三者收进一个名字空间**，让调用方（服务层 / 运维页 / 未来
的 ``media.generate`` 工具）能用同一套词汇查询与调用，而不是分别记住
三个 registry 的差异。

与 EnterpriseToolGate 的关系（关键）
------------------------------------
本模块是**服务层 facade**，直接调用 provider，**不经过 gate**。
因此它**只对服务端内部代码开放**，绝不能被 agent 直接调用 ——
否则就绕过了「所有高风险操作必须审批」的约束。

要让 **agent** 生成媒体，走的是已注册工具（经 gate）：

    image_generate   → toolset image_gen → gate
    video_generate   → toolset video_gen → gate
    text_to_speech   → toolset tts       → gate

:func:`media_status` 会把这条边界显式写回结果（``agent_path`` 字段），
避免以后有人误把 facade 接到 agent 上。

设计约束
--------
- 不新增第三方依赖
- 不修改任何既有 registry / provider
- provider 不可用时返回**结构化原因**（缺什么 key），不静默失败
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "MediaKind",
    "ProviderInfo",
    "MediaStatus",
    "list_providers",
    "media_status",
    "generate_image",
    "generate_video",
    "generate_audio",
    "edit_media",
]


class MediaKind:
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


#: 每类媒体：registry 模块、工具名（agent 路径）、展示名
_MEDIA_KINDS: Dict[str, Dict[str, str]] = {
    MediaKind.IMAGE: {
        "registry": "roveagent.core.image_gen_registry",
        "tool": "image_generate",
        "toolset": "image_gen",
    },
    MediaKind.VIDEO: {
        "registry": "roveagent.core.video_gen_registry",
        "tool": "video_generate",
        "toolset": "video_gen",
    },
    MediaKind.AUDIO: {
        "registry": "roveagent.core.tts_registry",
        "tool": "text_to_speech",
        "toolset": "tts",
    },
}


@dataclass
class ProviderInfo:
    kind: str
    name: str
    available: bool
    default_model: Optional[str] = None
    #: provider 不可用时的原因（通常是缺 API key）
    reason: str = ""
    #: 声明支持的模态（image provider 会区分 text / image 编辑）
    modalities: List[str] = field(default_factory=list)
    max_reference_images: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "available": self.available,
            "default_model": self.default_model,
            "reason": self.reason,
            "modalities": list(self.modalities),
            "max_reference_images": self.max_reference_images,
        }


def _ensure_plugins() -> None:
    """确保插件发现已跑过 —— provider 都是插件，未发现时 registry 是空的。"""
    try:
        from ..clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
    except Exception as exc:  # noqa: BLE001 — 发现失败不致命，后续会显示 0 provider
        logger.warning("media hub: plugin discovery failed: %s", exc)


def _registry(kind: str) -> Any:
    spec = _MEDIA_KINDS.get(kind)
    if spec is None:
        raise ValueError(f"unknown media kind: {kind!r}")
    try:
        module = __import__(spec["registry"], fromlist=["list_providers"])
        return module
    except Exception as exc:  # noqa: BLE001
        logger.warning("media hub: registry %s unavailable: %s", spec["registry"], exc)
        return None


def list_providers(kind: Optional[str] = None) -> List[ProviderInfo]:
    """列出媒体 provider（含可用性与原因）。

    ``kind`` 为 None 时返回三类全部。
    """
    _ensure_plugins()
    kinds = [kind] if kind else [MediaKind.IMAGE, MediaKind.VIDEO, MediaKind.AUDIO]
    out: List[ProviderInfo] = []

    for current in kinds:
        module = _registry(current)
        if module is None:
            continue
        try:
            providers = module.list_providers()
        except Exception as exc:  # noqa: BLE001
            logger.warning("media hub: list_providers(%s) failed: %s", current, exc)
            continue

        for provider in providers:
            name = str(getattr(provider, "name", "?"))
            reason = ""
            try:
                available = bool(provider.is_available())
            except Exception as exc:  # noqa: BLE001 — 坏 provider 不应拖垮列表
                available = False
                reason = f"is_available raised {type(exc).__name__}: {exc}"

            default_model: Optional[str] = None
            try:
                default_model = provider.default_model()
            except Exception:  # noqa: BLE001
                default_model = None

            modalities: List[str] = []
            max_refs = 0
            try:
                caps = provider.capabilities() or {}
                modalities = [str(m) for m in (caps.get("modalities") or [])]
                max_refs = int(caps.get("max_reference_images") or 0)
            except Exception:  # noqa: BLE001
                pass

            if not available and not reason:
                reason = "provider reports unavailable (missing credentials or dependency)"

            out.append(ProviderInfo(
                kind=current, name=name, available=available,
                default_model=default_model, reason=reason,
                modalities=modalities, max_reference_images=max_refs,
            ))

    return out


@dataclass
class MediaStatus:
    """媒体能力总览 —— 给运维/设置页看的「到底能用什么」。"""

    providers: List[ProviderInfo] = field(default_factory=list)
    #: agent 生成媒体的**唯一合法路径**（经 EnterpriseToolGate）
    agent_path: Dict[str, str] = field(default_factory=dict)
    #: 各类是否有可用 provider
    ready: Dict[str, bool] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ready": dict(self.ready),
            "providers": [p.as_dict() for p in self.providers],
            "agent_path": dict(self.agent_path),
            "note": (
                "This is a server-side facade. Agents must use the registered "
                "tools (agent_path) so every call passes EnterpriseToolGate."
            ),
        }


def media_status() -> MediaStatus:
    """三类媒体的可用性总览 + agent 合法路径说明。"""
    providers = list_providers()
    ready: Dict[str, bool] = {}
    for kind in (MediaKind.IMAGE, MediaKind.VIDEO, MediaKind.AUDIO):
        ready[kind] = any(p.available for p in providers if p.kind == kind)
    return MediaStatus(
        providers=providers,
        agent_path={k: v["tool"] for k, v in _MEDIA_KINDS.items()},
        ready=ready,
    )


# ---------------------------------------------------------------------------
# 统一调用面（服务层内部用）
#
# 每个函数都返回统一形状：
#   {"ok": bool, "kind": str, "provider": str, "asset": str|None,
#    "model": str, "reason": str, ...}
# 失败时 reason 一定非空且**可执行**（说清缺什么），不静默返回空。
# ---------------------------------------------------------------------------

def _result(kind: str, *, ok: bool, provider: str = "", asset: Optional[str] = None,
            model: str = "", reason: str = "", extra: Optional[Dict[str, Any]] = None
            ) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "ok": ok, "kind": kind, "provider": provider,
        "asset": asset, "model": model, "reason": reason,
    }
    if extra:
        payload.update(extra)
    return payload


def _no_provider_reason(kind: str) -> str:
    available = [p for p in list_providers(kind) if p.available]
    if available:
        return ""
    known = [p.name for p in list_providers(kind)]
    return (
        f"No available {kind} provider. Known providers: {known or '(none registered)'}. "
        f"Configure credentials for one of them and select it in settings."
    )


def _delegate_tool(tool_name: str, args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """调用**已注册工具**的 handler（服务层内部使用）。

    注意：这条路径**不经过 EnterpriseToolGate**（gate 是中间件，只在 agent
    工具循环里生效）。因此本函数只应被服务端内部代码调用，且返回结果里
    会带 ``via: "registry-handler"`` 让调用方知道它没走门。
    """
    try:
        from ..tools.registry import registry

        entry = registry.get_entry(tool_name)
        if entry is None:
            return None
        handler = getattr(entry, "handler", None)
        if handler is None:
            return None
        raw = handler(args)
        if isinstance(raw, dict):
            return raw
        # 工具 handler 通常返回 JSON 字符串
        import json

        try:
            parsed = json.loads(raw) if isinstance(raw, str) else None
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            return parsed
        return {"raw": raw}
    except Exception as exc:  # noqa: BLE001 — 绝不把异常抛给调用方
        logger.warning("media hub: tool %s raised: %s", tool_name, exc, exc_info=True)
        return {"error": f"{type(exc).__name__}: {exc}"}


def generate_image(prompt: str, *, aspect_ratio: str = "landscape",
                   image_url: Optional[str] = None,
                   reference_image_urls: Optional[List[str]] = None,
                   **kwargs: Any) -> Dict[str, Any]:
    """生成/编辑图片。委托 ``image_generate`` 的 provider 路径。"""
    if not (prompt or "").strip():
        return _result(MediaKind.IMAGE, ok=False, reason="prompt is required")
    reason = _no_provider_reason(MediaKind.IMAGE)
    if reason:
        return _result(MediaKind.IMAGE, ok=False, reason=reason)

    from ..tools.image_generation_tool import image_generate_tool

    raw = image_generate_tool(
        prompt=prompt, aspect_ratio=aspect_ratio,
        image_url=image_url, reference_image_urls=reference_image_urls, **kwargs,
    )
    return _result(
        MediaKind.IMAGE,
        ok=bool(raw.get("success")),
        provider=str(raw.get("provider") or ""),
        asset=raw.get("image"),
        model=str(raw.get("model") or ""),
        reason=str(raw.get("error") or ""),
        extra={"modality": raw.get("modality"), "via": "image_gen_registry"},
    )


def generate_video(prompt: str, *, aspect_ratio: str = "landscape",
                   image_url: Optional[str] = None, duration: Optional[int] = None,
                   **kwargs: Any) -> Dict[str, Any]:
    """生成视频。委托 ``video_generate`` 已注册工具。"""
    if not (prompt or "").strip():
        return _result(MediaKind.VIDEO, ok=False, reason="prompt is required")
    reason = _no_provider_reason(MediaKind.VIDEO)
    if reason:
        return _result(MediaKind.VIDEO, ok=False, reason=reason)

    args: Dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
    if image_url:
        args["image_url"] = image_url
    if duration is not None:
        args["duration"] = duration
    args.update(kwargs)

    raw = _delegate_tool("video_generate", args)
    if raw is None:
        return _result(MediaKind.VIDEO, ok=False,
                       reason="video_generate tool is not registered")
    return _result(
        MediaKind.VIDEO,
        ok=bool(raw.get("success") and not raw.get("error")),
        provider=str(raw.get("provider") or ""),
        asset=raw.get("video") or raw.get("url"),
        model=str(raw.get("model") or ""),
        reason=str(raw.get("error") or ""),
        extra={"via": "registry-handler"},
    )


def generate_audio(text: str, *, provider: Optional[str] = None,
                   output_path: Optional[str] = None,
                   **kwargs: Any) -> Dict[str, Any]:
    """文字转语音。委托 ``text_to_speech`` 已注册工具。"""
    if not (text or "").strip():
        return _result(MediaKind.AUDIO, ok=False, reason="text is required")
    reason = _no_provider_reason(MediaKind.AUDIO)
    if reason:
        return _result(MediaKind.AUDIO, ok=False, reason=reason)

    args: Dict[str, Any] = {"text": text}
    if provider:
        args["provider"] = provider
    if output_path:
        args["output_path"] = output_path
    args.update(kwargs)

    raw = _delegate_tool("text_to_speech", args)
    if raw is None:
        return _result(MediaKind.AUDIO, ok=False,
                       reason="text_to_speech tool is not registered")
    return _result(
        MediaKind.AUDIO,
        ok=bool(raw.get("success") and not raw.get("error")),
        provider=str(raw.get("provider") or ""),
        asset=raw.get("audio") or raw.get("path") or raw.get("url"),
        model=str(raw.get("model") or ""),
        reason=str(raw.get("error") or ""),
        extra={"via": "registry-handler"},
    )


def edit_media(kind: str, prompt: str, *, source: str, **kwargs: Any) -> Dict[str, Any]:
    """编辑已有媒体。

    当前只有图像编辑有真实实现（image provider 通过 ``image_url`` 路由到
    各自的 image-to-image / edit 端点）。视频编辑在 provider 层存在但在工具
    层未暴露（``video_generate`` 明确拒绝 edit/extend），因此这里**如实返回
    不支持**，而不是假装成功。
    """
    if kind == MediaKind.IMAGE:
        if not source:
            return _result(MediaKind.IMAGE, ok=False, reason="source image is required")
        return generate_image(prompt, image_url=source, **kwargs)

    if kind == MediaKind.VIDEO:
        return _result(
            MediaKind.VIDEO, ok=False,
            reason=(
                "Video edit/extend is not exposed at the tool layer. "
                "Use the provider-specific tool (xai_video_edit) if your provider "
                "supports it."
            ),
        )

    if kind == MediaKind.AUDIO:
        return _result(
            MediaKind.AUDIO, ok=False,
            reason="Audio editing is not supported by the TTS registry (synthesis only).",
        )

    return _result(kind, ok=False, reason=f"unsupported media kind: {kind!r}")
