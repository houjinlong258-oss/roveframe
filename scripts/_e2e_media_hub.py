"""Phase 4b 验证：Media Hub + image_generate 真实端到端。

背景：Phase 1 从 0 字节重建了 ``image_generation_tool.py``，但本机无任何
媒体 provider 凭据，因此当时**只验证了「注册成功」**，未验证调用链。
本脚本用一个**内存 fake provider**（注册进既有 image_gen_registry）
把整条链路走通：

    Media Hub / image_generate_tool
        → image_gen_registry.get_active_provider()
        → provider.generate()
        → 统一响应形状

这验证的是**接线与契约**，不是上游厂商行为（那需要真实凭据）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "media-probe-key")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


from roveagent.core.image_gen_provider import ImageGenProvider  # noqa: E402


class FakeImageProvider(ImageGenProvider):
    """最小可用的 image provider：不联网，返回一段可识别的假图 URL。

    必须继承 ``ImageGenProvider`` —— registry 用 ``isinstance`` 校验
    （实测：不继承会抛 ``TypeError: register_provider() expects an
    ImageGenProvider instance``）。
    """

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    @property
    def name(self) -> str:
        return "fake-probe"

    def is_available(self) -> bool:
        return True

    def default_model(self) -> Optional[str]:
        return "fake-model-v1"

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": "fake-model-v1", "display": "Fake Model v1"}]

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text", "image"], "max_reference_images": 2}

    def generate(self, prompt: str, aspect_ratio: str = "landscape", *,
                 image_url: Optional[str] = None,
                 reference_image_urls: Optional[List[str]] = None,
                 **kwargs: Any) -> Dict[str, Any]:
        self.calls.append({
            "prompt": prompt, "aspect_ratio": aspect_ratio,
            "image_url": image_url, "refs": reference_image_urls,
        })
        return {
            "success": True,
            "image": f"https://fake.local/{abs(hash(prompt)) % 10**8}.png",
            "model": self.default_model(),
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "modality": "image" if image_url else "text",
            "provider": self.name,
        }


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    # ---- 准备：注册 fake provider ----
    from roveagent.core.image_gen_registry import register_provider, list_providers
    from roveagent.tools.registry import discover_builtin_tools, registry

    discover_builtin_tools()
    provider = FakeImageProvider()
    register_provider(provider)
    names = [p.name for p in list_providers()]
    check("fake provider 已注册", "fake-probe" in names, f"providers={names}")

    # ---- 1. 直接调用底层 image_generate_tool ----
    from roveagent.tools.image_generation_tool import (
        check_image_generation_requirements,
        image_generate_tool,
    )

    raw = image_generate_tool(prompt="a red bicycle", aspect_ratio="square")
    check("image_generate_tool 返回成功", bool(raw.get("success")), str(raw.get("error") or ""))
    check("返回 image URL", bool(raw.get("image")), str(raw.get("image")))
    check("provider 正确标注", raw.get("provider") == "fake-probe", str(raw.get("provider")))
    check("model 已填充", bool(raw.get("model")), str(raw.get("model")))
    check("aspect_ratio 已规范化", raw.get("aspect_ratio") == "square", str(raw.get("aspect_ratio")))
    check("底层确实收到 prompt", provider.calls[-1]["prompt"] == "a red bicycle",
          str(provider.calls[-1]["prompt"]))

    # ---- 2. check_fn 现在应通过 ----
    check("check_image_generation_requirements 通过",
          bool(check_image_generation_requirements()), "")

    # ---- 3. 图片编辑路由（image_url 存在 → modality=image）----
    edited = image_generate_tool(
        prompt="make it blue", image_url="https://fake.local/source.png",
    )
    check("编辑模式成功", bool(edited.get("success")), str(edited.get("error") or ""))
    check("编辑模式 modality=image", edited.get("modality") == "image",
          str(edited.get("modality")))
    check("image_url 已透传到 provider",
          provider.calls[-1]["image_url"] == "https://fake.local/source.png",
          str(provider.calls[-1]["image_url"]))

    # ---- 4. Media Hub 统一面 ----
    from roveagent.api.media_hub import (
        MediaKind, edit_media, generate_audio, generate_image, generate_video,
        media_status,
    )

    hub = generate_image("a mountain landscape", aspect_ratio="landscape")
    check("Media Hub generate_image 成功", bool(hub.get("ok")), str(hub.get("reason")))
    check("Media Hub 回传统一形状",
          set(("ok", "kind", "provider", "asset", "model", "reason")) <= set(hub.keys()),
          str(sorted(hub.keys())))
    check("Media Hub kind=image", hub.get("kind") == MediaKind.IMAGE, str(hub.get("kind")))

    status = media_status()
    check("media_status 反映 image 就绪", bool(status.ready.get("image")), str(status.ready))
    check("media_status 声明 agent 合法路径",
          status.agent_path.get("image") == "image_generate", str(status.agent_path))
    check("media_status 含 provider 明细", len(status.providers) > 0,
          f"{len(status.providers)} providers")

    # ---- 5. 失败路径必须给出可执行原因（不静默）----
    empty = generate_image("   ")
    check("空 prompt 被拒且给原因", (not empty["ok"]) and bool(empty["reason"]),
          empty["reason"])

    # video / audio 当前无可用 provider → 必须结构化失败
    video = generate_video("a cat surfing")
    check("video 无 provider 时结构化失败",
          (not video["ok"]) and "provider" in video["reason"].lower(),
          video["reason"][:90])

    audio = generate_audio("hello world")
    check("audio 无 provider 时结构化失败",
          (not audio["ok"]) and bool(audio["reason"]), audio["reason"][:90])

    # 视频编辑在工具层未暴露 → 如实拒绝，不假装成功
    vedit = edit_media(MediaKind.VIDEO, "add rain", source="https://x/v.mp4")
    check("video 编辑如实拒绝（不假装成功）",
          (not vedit["ok"]) and bool(vedit["reason"]), vedit["reason"][:80])

    # 图片编辑经 Media Hub 走通
    hub_edit = edit_media(MediaKind.IMAGE, "make it night",
                          source="https://fake.local/source.png")
    check("Media Hub 图片编辑成功", bool(hub_edit.get("ok")), str(hub_edit.get("reason")))

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n[summary] {passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
