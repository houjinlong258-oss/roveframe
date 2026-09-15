"""Phase 4 扫描：媒体能力面 + 文档能力面（只读）。

回答三个问题：
  1. image / video / audio 三类 provider 的注册表与可用性
  2. 媒体工具的真实 schema（决定 Media Hub 怎么封装）
  3. 文档生成（PDF/DOCX/PPTX/XLSX）现状与中文字体缺口
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.environ.setdefault("ROVEAGENT_ROOT", str(REPO / ".roveagent"))
os.environ.setdefault("ROVEAGENT_API_KEY", "scan-key")


def main() -> int:
    from roveagent.api.app import get_context

    get_context()

    # 媒体 provider 是**插件**，注册发生在插件发现阶段。不先触发发现，
    # registry 是空的（实测 0 provider）—— 这会让人误判「没有媒体能力」。
    try:
        from roveagent.clisupport.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        print("[scan] plugin discovery triggered")
    except Exception as exc:  # noqa: BLE001
        print(f"[scan] plugin discovery failed: {type(exc).__name__}: {exc}")

    print("=" * 72)
    print("1. 媒体 provider 注册表")
    print("=" * 72)
    for kind, module in (
        ("image", "roveagent.core.image_gen_registry"),
        ("video", "roveagent.core.video_gen_registry"),
    ):
        try:
            mod = __import__(module, fromlist=["list_providers"])
            providers = mod.list_providers()
            print(f"\n  [{kind}] {len(providers)} provider(s)")
            for provider in providers:
                try:
                    available = bool(provider.is_available())
                except Exception as exc:  # noqa: BLE001
                    available = f"RAISED({type(exc).__name__})"
                try:
                    default = provider.default_model()
                except Exception:  # noqa: BLE001
                    default = None
                print(f"    {provider.name:16s} available={available!s:22s} default={default}")
        except Exception as exc:  # noqa: BLE001
            print(f"  [{kind}] registry unavailable: {type(exc).__name__}: {exc}")

    print()
    print("=" * 72)
    print("2. 媒体工具 schema（决定 Media Hub 封装）")
    print("=" * 72)
    from roveagent.tools.registry import registry

    for name in ("image_generate", "video_generate", "text_to_speech", "xai_video_edit"):
        entry = registry.get_entry(name)
        if entry is None:
            print(f"\n  {name}: NOT REGISTERED")
            continue
        schema = getattr(entry, "schema", None) or {}
        params = schema.get("parameters") or {}
        props = list((params.get("properties") or {}).keys())
        required = list(params.get("required") or [])
        check = getattr(entry, "check_fn", None)
        verdict = "n/a"
        if check is not None:
            try:
                verdict = "PASS" if check() else "FAIL"
            except Exception as exc:  # noqa: BLE001
                verdict = f"RAISED({type(exc).__name__})"
        print(f"\n  {name}")
        print(f"    toolset   : {registry.get_toolset_for_tool(name)}")
        print(f"    check_fn  : {verdict}")
        print(f"    props     : {props}")
        print(f"    required  : {required}")

    print()
    print("=" * 72)
    print("3. 文档能力（TS 侧零依赖 writer）")
    print("=" * 72)
    writers = REPO.parent / "src" / "lib" / "artifacts"
    if not writers.exists():
        writers = REPO / "src" / "lib" / "artifacts"
    if writers.exists():
        for path in sorted(writers.glob("*.ts")):
            print(f"    {path.name:24s} {path.stat().st_size:>8} bytes")
    else:
        print(f"    (artifacts dir not found at {writers})")

    print()
    print("=" * 72)
    print("4. 中文字体（PDF 依赖）")
    print("=" * 72)
    fonts_dir = REPO / "public" / "fonts"
    print(f"    public/fonts exists: {fonts_dir.exists()}")
    if fonts_dir.exists():
        entries = sorted(p.name for p in fonts_dir.iterdir())
        print(f"    contents: {entries}")
    for env_var in ("RF_PDF_FONT", "ROVEAGENT_PDF_FONT"):
        print(f"    {env_var} = {os.environ.get(env_var) or '(unset)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
