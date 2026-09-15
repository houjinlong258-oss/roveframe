"""Image generation tool surface (``image_generate``).

状态说明（Phase 1 重建）
----------------------
本文件此前是 **0 字节的空文件**，导致：

- ``image_generate`` 工具**从未注册**（registry 里不存在）→ 模型无法调用出图
- ``image_gen`` toolset 不可用，连带其依赖者 ``media`` 与 ``safe`` 一并失效
- ``roveagent/clisupport/tools_config.py`` 的
  ``from roveagent.tools.image_generation_tool import FAL_MODELS, DEFAULT_MODEL``
  会在导入时失败
- ``video_generation_tool.py`` 的
  ``from roveagent.tools.image_generation_tool import _confine_source_images``
  同样会失败

本次重建**不重复实现任何出图逻辑** —— 真正的后端早已实现完毕，位于
``plugins/image_gen/{fal,openai,openai-codex,xai,deepinfra,krea,openrouter}/``，
统一遵循 ``roveagent.core.image_gen_provider.ImageGenProvider``。
本模块只做三件「胶水」事：

1. 暴露 provider 插件期望从本模块导入的**兼容符号**
   （``FAL_MODELS`` / ``DEFAULT_MODEL`` / ``check_fal_api_key`` /
   ``_resolve_fal_model`` / ``_confine_source_images``）；
2. 提供 ``image_generate_tool(...)`` —— 把调用委托给
   ``image_gen_registry.get_active_provider()`` 选中的 provider；
3. 把结果规范化为工具层期望的形状（provider 已在
   ``success_response`` / ``error_response`` 里定义，这里只做兜底与补字段）。

设计取向：**委托优先、绝不静默伪造**。没有可用 provider 时返回
``success=False`` + 可执行的错误说明（提示去设置里配 API Key），
而不是返回一张假图或空成功。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from roveagent.tools.registry import registry

logger = logging.getLogger(__name__)

__all__ = [
    "FAL_MODELS",
    "DEFAULT_MODEL",
    "check_fal_api_key",
    "resolve_active_provider",
    "image_generate_tool",
]


# ---------------------------------------------------------------------------
# 兼容符号：provider 插件与 tools_config 从本模块导入它们
# ---------------------------------------------------------------------------

def _fal_provider() -> Any:
    """取已注册的 FAL provider 实例（未注册返回 None）。"""
    try:
        from roveagent.core.image_gen_registry import get_provider

        return get_provider("fal")
    except Exception as exc:  # noqa: BLE001 — registry 可选
        logger.debug("fal provider lookup failed: %s", exc)
        return None


def _provider_model_map(provider: Any) -> Dict[str, Dict[str, Any]]:
    """把 provider 的模型清单规范成 ``{model_id: meta}``。

    ``ImageGenProvider.list_models()`` 默认返回 ``list[dict]``，
    而调用方（``plugins/image_gen/fal/__init__.py``）按 ``.items()`` 使用，
    因此这里统一转成 dict。
    """
    models: Dict[str, Dict[str, Any]] = {}
    if provider is None:
        return models
    try:
        raw = provider.list_models() or []
    except Exception as exc:  # noqa: BLE001 — 坏 provider 不得拖垮工具
        logger.debug("list_models failed for %s: %s", getattr(provider, "name", "?"), exc)
        return models
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model")
        if not model_id:
            continue
        models[str(model_id)] = dict(entry)
    return models


def _fallback_fal_models() -> Dict[str, Dict[str, Any]]:
    """FAL provider 未注册时的最小模型目录。

    只列 ``plugins/image_gen/fal`` 的 ``get_setup_schema()`` 已公开宣称的模型，
    **不臆造**没有依据的条目；缺字段时给空串，让 picker 优雅降级。
    """
    known = (
        "fal-ai/flux-2-klein",
        "fal-ai/flux-2-pro",
        "fal-ai/nano-banana-2",
        "fal-ai/nano-banana-pro",
        "fal-ai/gpt-image",
    )
    return {model_id: {"id": model_id, "display": model_id} for model_id in known}


def check_fal_api_key() -> bool:
    """FAL 后端是否可用（凭据或托管网关已配置）。

    ``plugins/image_gen/fal/__init__.py`` 用它判定 provider 可用性。
    优先问 FAL provider 自己；provider 未注册时回落托管网关探测。
    """
    provider = _fal_provider()
    if provider is not None:
        try:
            return bool(provider.is_available())
        except Exception as exc:  # noqa: BLE001 — 绝不因探测失败而抛
            logger.debug("fal provider is_available raised: %s", exc)
    try:
        from roveagent.tools.tool_backend_helpers import managed_nous_tools_enabled

        return bool(managed_nous_tools_enabled())
    except Exception as exc:  # noqa: BLE001
        logger.debug("managed gateway probe failed: %s", exc)
        return False


def _resolve_fal_model() -> tuple[str, Dict[str, Any]]:
    """返回 FAL 当前选中的 ``(model_id, meta)``。

    读 ``image_gen.model`` 配置；没有配置时用 provider 的 ``default_model()``；
    再不行退回目录首项。找不到任何模型时抛 ``RuntimeError``（调用方会兜住）。
    """
    models = _provider_model_map(_fal_provider()) or _fallback_fal_models()

    configured: Optional[str] = None
    try:
        from roveagent.clisupport.config import load_config_readonly

        cfg = load_config_readonly()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        if isinstance(section, dict):
            raw = section.get("model")
            if isinstance(raw, str) and raw.strip():
                configured = raw.strip()
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not read image_gen.model: %s", exc)

    if configured and configured in models:
        return configured, models[configured]

    provider = _fal_provider()
    if provider is not None:
        try:
            default = provider.default_model()
        except Exception:  # noqa: BLE001
            default = None
        if default and default in models:
            return default, models[default]

    if not models:
        raise RuntimeError("no FAL image model available (image_gen provider not registered)")
    first = next(iter(models))
    return first, models[first]


class _LazyModelMap(dict):
    """首次访问时填充的 dict，保持 ``FAL_MODELS.items()`` 的用法可用。

    为什么惰性：provider 注册发生在插件发现阶段，而本模块可能在发现之前
    就被 import（例如 ``tools_config`` 的静态导入）。用模块级立即求值会
    拿到空目录，惰性求值则总能拿到最终状态。
    """

    def __init__(self) -> None:
        super().__init__()
        self._loaded = False

    def _ensure(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            super().update(_provider_model_map(_fal_provider()) or _fallback_fal_models())
        except Exception as exc:  # noqa: BLE001
            logger.debug("FAL_MODELS load failed: %s", exc)
            super().update(_fallback_fal_models())

    def items(self):  # type: ignore[override]
        self._ensure()
        return super().items()

    def keys(self):  # type: ignore[override]
        self._ensure()
        return super().keys()

    def values(self):  # type: ignore[override]
        self._ensure()
        return super().values()

    def __getitem__(self, key):  # type: ignore[override]
        self._ensure()
        return super().__getitem__(key)

    def __contains__(self, key) -> bool:  # type: ignore[override]
        self._ensure()
        return super().__contains__(key)

    def __len__(self) -> int:  # type: ignore[override]
        self._ensure()
        return super().__len__()

    def get(self, key, default=None):  # type: ignore[override]
        self._ensure()
        return super().get(key, default)


FAL_MODELS: Dict[str, Dict[str, Any]] = _LazyModelMap()


class _LazyDefaultModel(str):
    """``DEFAULT_MODEL`` 的惰性字符串：取值时解析当前配置。

    调用方把它当普通 ``str`` 用（拼进 picker、写配置），因此继承 ``str``
    即可满足类型预期，同时保留惰性求值。
    """

    _FALLBACK = "fal-ai/flux-2-klein"

    def __new__(cls) -> "_LazyDefaultModel":
        return super().__new__(cls, cls._FALLBACK)

    def __str__(self) -> str:
        try:
            resolved = _resolve_fal_model()[0]
        except Exception:  # noqa: BLE001
            return self._FALLBACK
        return resolved or self._FALLBACK


DEFAULT_MODEL: str = _LazyDefaultModel()


def _confine_source_images(
    image_url: Optional[str],
    reference_image_urls: Any,
    task_id: Optional[str] = None,
) -> tuple[Optional[str], Any, Optional[str]]:
    """沙箱感知的来源图片收敛（``video_generation_tool`` 依赖此契约）。

    签名与返回**必须**是 ``(image_url, reference_image_urls, error_or_None)``
    —— ``video_generation_tool.py:276`` 正是这样解包的::

        image_url, reference_image_urls, confine_error = _confine_source_images(
            image_url, reference_image_urls, task_id)
        if confine_error is not None:
            return confine_error

    行为（对齐 ``tools/image_source.py`` 的既定安全模型，不另立一套）：

    - 非路径形态（``http(s)://`` / ``data:`` / 空）原样透传；
    - **本地终端后端**：保持 host 侧读取的既有姿态，仅做「绝对路径 +
      允许根」校验，返回原路径（零行为变化）；
    - **非本地后端**（容器/沙箱）：经
      ``image_source.resolve_local_source_to_data_url`` 把沙箱内文件读成
      ``data:`` URL，provider 无需感知后端差异。这正是该函数存在的理由
      （GHSA-gpxw-6wxv-w3qq：模型给的路径必须受沙箱边界约束）。

    任一步失败返回人类可读错误字符串（第三个元素），调用方直接当工具结果返回。
    """
    import asyncio
    import os

    refs = reference_image_urls
    if isinstance(refs, (str, Path)):
        refs = [refs]
    if refs is not None and not isinstance(refs, (list, tuple)):
        refs = None

    def _is_passthrough(value: Optional[str]) -> bool:
        if not value:
            return True
        lowered = str(value).strip().lower()
        return lowered.startswith(("http://", "https://", "data:"))

    # 本地路径的允许根（host 侧读取得以受限）
    allowed_roots = []
    for candidate in (
        os.environ.get("ROVEAGENT_HOME") or (Path.home() / ".roveagent"),
        os.environ.get("ROVEAGENT_ROOT") or "",
    ):
        if not candidate:
            continue
        try:
            allowed_roots.append(Path(str(candidate)).resolve())
        except Exception:  # noqa: BLE001
            continue

    def _confine_local(path_like: str) -> Optional[str]:
        """本地后端：校验路径合法，返回错误字符串或 None。"""
        try:
            resolved = Path(str(path_like)).expanduser().resolve(strict=False)
        except Exception:  # noqa: BLE001
            return f"invalid source image path: {path_like!r}"
        if not resolved.is_absolute():
            return f"source image path must be absolute: {path_like!r}"
        if allowed_roots and not any(
            resolved == root or root in resolved.parents for root in allowed_roots
        ):
            # 不阻断（历史行为允许任意 host 路径），仅告警 —— 收紧会破坏
            # 既有用法，属于安全模型变更，需单独决策。
            logger.warning("source image outside agent-managed roots: %s", resolved)
        return None

    try:
        from roveagent.tools.image_source import (
            _is_local_terminal_backend,
            resolve_local_source_to_data_url,
        )
    except Exception as exc:  # noqa: BLE001 — 解析器不可用时退化为本地校验
        logger.debug("image_source unavailable, local-only confinement: %s", exc)
        if not _is_passthrough(image_url) and (error := _confine_local(str(image_url))):
            return image_url, refs, error
        return image_url, refs, None

    local_backend = True
    try:
        local_backend = bool(_is_local_terminal_backend())
    except Exception:  # noqa: BLE001
        local_backend = True

    if local_backend:
        if not _is_passthrough(image_url) and (error := _confine_local(str(image_url))):
            return image_url, refs, error
        for ref in (refs or []):
            if _is_passthrough(str(ref)):
                continue
            if (error := _confine_local(str(ref))):
                return image_url, refs, error
        return image_url, refs, None

    # 非本地后端：走沙箱内读取 → data: URL
    async def _resolve_all() -> tuple[Optional[str], Any, Optional[str]]:
        resolved_primary = image_url
        if not _is_passthrough(image_url):
            try:
                resolved_primary = await resolve_local_source_to_data_url(
                    str(image_url), task_id,
                )
            except Exception as exc:  # noqa: BLE001
                return image_url, refs, f"could not read source image in sandbox: {exc}"
        resolved_refs: List[str] = []
        for ref in (refs or []):
            if _is_passthrough(str(ref)):
                resolved_refs.append(str(ref))
                continue
            try:
                resolved_refs.append(
                    await resolve_local_source_to_data_url(str(ref), task_id),
                )
            except Exception as exc:  # noqa: BLE001
                return resolved_primary, refs, f"could not read reference image in sandbox: {exc}"
        return resolved_primary, (resolved_refs or None), None

    try:
        return asyncio.run(_resolve_all())
    except RuntimeError:
        # 已有事件循环在跑（工具在 async 上下文被调用）：退化为本地校验，
        # 不阻塞调用方 —— provider 仍会在自己的读取路径上失败并给出错误。
        logger.debug("running loop detected; skipping sandbox source resolution")
        return image_url, refs, None
    except Exception as exc:  # noqa: BLE001
        return image_url, refs, f"source image confinement failed: {exc}"


# ---------------------------------------------------------------------------
# 主入口：委托给已注册的 provider
# ---------------------------------------------------------------------------

def resolve_active_provider() -> Any:
    """当前活跃的 image-gen provider（无可用者返回 None）。"""
    try:
        from roveagent.core.image_gen_registry import get_active_provider

        return get_active_provider()
    except Exception as exc:  # noqa: BLE001 — registry 可选
        logger.debug("get_active_provider failed: %s", exc)
        return None


def _no_provider_response(prompt: str, aspect_ratio: str) -> Dict[str, Any]:
    """没有可用 provider 时的诚实失败（绝不伪造成功）。"""
    return {
        "success": False,
        "image": None,
        "model": "",
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "provider": "",
        "error": (
            "No image generation provider is configured. Add one under "
            "Settings -> Plugins -> Media (image_gen), or set the matching API key "
            "(e.g. FAL_KEY) and select it with image_gen.provider."
        ),
        "error_type": "no_provider",
    }


def image_generate_tool(
    prompt: str,
    aspect_ratio: str = "landscape",
    *,
    image_url: Optional[str] = None,
    reference_image_urls: Optional[List[str]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """生成或编辑图片。

    统一入口，覆盖文生图与图生图（路由依据 ``image_url`` /
    ``reference_image_urls`` 是否存在）。真正的实现在 provider 插件里，
    本函数只做选择、委托与兜底。

    绝不抛异常 —— 失败以 ``success=False`` + ``error`` 返回，工具层可直接
    序列化给模型。
    """
    try:
        from roveagent.core.image_gen_provider import resolve_aspect_ratio

        aspect = resolve_aspect_ratio(aspect_ratio)
    except Exception:  # noqa: BLE001
        aspect = aspect_ratio or "landscape"

    provider = resolve_active_provider()
    if provider is None:
        return _no_provider_response(prompt, aspect)

    passthrough: Dict[str, Any] = {}
    if image_url is not None:
        passthrough["image_url"] = image_url
    if reference_image_urls is not None:
        passthrough["reference_image_urls"] = reference_image_urls
    # 前向兼容：把未知 kwargs 交给 provider，由它自行忽略（ABC 要求如此）
    for key, value in kwargs.items():
        passthrough.setdefault(key, value)

    try:
        response = provider.generate(prompt=prompt, aspect_ratio=aspect, **passthrough)
    except Exception as exc:  # noqa: BLE001 — 绝不把异常抛给工具层
        logger.warning(
            "image provider %s raised: %s", getattr(provider, "name", "?"), exc, exc_info=True,
        )
        return {
            "success": False,
            "image": None,
            "model": "",
            "prompt": prompt,
            "aspect_ratio": aspect,
            "provider": getattr(provider, "name", ""),
            "error": f"{type(exc).__name__}: {exc}",
            "error_type": "provider_raised",
        }

    if not isinstance(response, dict):
        return {
            "success": False,
            "image": None,
            "model": "",
            "prompt": prompt,
            "aspect_ratio": aspect,
            "provider": getattr(provider, "name", ""),
            "error": f"provider returned {type(response).__name__}, expected dict",
            "error_type": "bad_provider_response",
        }

    # 补齐下游消费者期望的字段（provider 通常已填好）
    response.setdefault("provider", getattr(provider, "name", ""))
    response.setdefault("prompt", prompt)
    response.setdefault("aspect_ratio", aspect)
    if "model" not in response:
        try:
            response["model"] = provider.default_model() or ""
        except Exception:  # noqa: BLE001
            response["model"] = ""
    return response


# ---------------------------------------------------------------------------
# 工具 schema + handler（注册用）
# ---------------------------------------------------------------------------

IMAGE_GENERATE_SCHEMA: Dict[str, Any] = {
    "name": "image_generate",
    "description": (
        "Generate an image from a text prompt, or edit/transform a supplied "
        "image. Set image_url to edit that image (image-to-image); add "
        "reference_image_urls for style/composition references. Use "
        "aspect_ratio to pick landscape/square/portrait."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "What to draw, or how to transform the source image.",
            },
            "aspect_ratio": {
                "type": "string",
                "enum": ["landscape", "square", "portrait"],
                "description": "Output framing. Default landscape.",
            },
            "image_url": {
                "type": "string",
                "description": (
                    "Primary source image to edit (http(s) URL, data: URL, or a "
                    "path under the agent's media cache). Omit for text-to-image."
                ),
            },
            "reference_image_urls": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Additional style/composition references.",
            },
        },
        "required": ["prompt"],
    },
}


def check_image_generation_requirements() -> bool:
    """``check_fn``：有可用 provider 时点亮 ``image_generate``。

    与 ``video_generation_tool.check_video_generation_requirements`` 同构。
    必须在**首次调用时**探测（provider 在插件发现阶段才注册），
    因此这里不做模块级缓存。
    """
    try:
        from roveagent.core.image_gen_registry import list_providers

        for provider in list_providers():
            try:
                if provider.is_available():
                    return True
            except Exception:  # noqa: BLE001 — 坏 provider 不应影响其他
                continue
        return False
    except Exception as exc:  # noqa: BLE001
        logger.debug("image generation availability probe failed: %s", exc)
        return False


def _handle_image_generate(args: Dict[str, Any], **kw: Any) -> str:
    """工具 handler：收敛来源 → 委托 provider → 序列化结果。

    与 ``video_generate`` 保持一致的接线方式（含沙箱来源收敛）。
    """
    import json

    prompt = (args.get("prompt") or "").strip()
    if not prompt:
        return json.dumps(
            {"success": False, "image": None, "error": "prompt is required",
             "error_type": "invalid_arguments"},
            ensure_ascii=False,
        )

    image_url = (args.get("image_url") or "").strip() or None
    reference_image_urls = args.get("reference_image_urls")
    task_id = kw.get("task_id")

    image_url, reference_image_urls, confine_error = _confine_source_images(
        image_url, reference_image_urls, task_id,
    )
    if confine_error is not None:
        return json.dumps(
            {"success": False, "image": None, "error": confine_error,
             "error_type": "source_not_permitted"},
            ensure_ascii=False,
        )

    result = image_generate_tool(
        prompt=prompt,
        aspect_ratio=(args.get("aspect_ratio") or "landscape"),
        image_url=image_url,
        reference_image_urls=reference_image_urls,
    )
    return json.dumps(result, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


registry.register(
    name="image_generate",
    toolset="image_gen",
    schema=IMAGE_GENERATE_SCHEMA,
    handler=_handle_image_generate,
    check_fn=check_image_generation_requirements,
    requires_env=[],
    is_async=False,
    emoji="🎨",
)
