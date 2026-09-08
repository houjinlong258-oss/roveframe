"""RoveAgent 渠道网关就绪检查 + 一键启用（Telegram / Discord / Slack）。

用法::

    python scripts/gateway-channels.py            # 只读体检报告
    python scripts/gateway-channels.py --enable   # 把已配 token 的平台写入 config.yaml（enabled: true）

判定口径（与网关启动时一致）：
    deps     平台适配器的 Python 依赖可导入
    token    必需环境变量已在 roveagent home 的 .env / 进程环境中配置
    enabled  config.yaml 的 gateway.platforms.<name>.enabled == true

三项全绿后，`roveagent gateway run` 即会把该平台带上线。
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PLATFORMS = {
    "telegram": {
        "label": "Telegram",
        "deps": ["telegram"],
        "required_env": ["TELEGRAM_BOT_TOKEN"],
        "get_token_url": "https://t.me/BotFather",
    },
    "discord": {
        "label": "Discord",
        "deps": ["discord"],
        "required_env": ["DISCORD_BOT_TOKEN"],
        "get_token_url": "https://discord.com/developers/applications",
    },
    "slack": {
        "label": "Slack",
        "deps": ["slack_sdk", "slack_bolt"],
        "required_env": ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
        "get_token_url": "https://api.slack.com/apps",
    },
    "weixin": {
        "label": "Weixin (iLink)",
        "deps": ["aiohttp", "qrcode"],
        "required_env": ["WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"],
        "get_token_url": "weixin_login.py 扫码获取",
    },
}


def roveagent_home() -> Path:
    from roveagent.clisupport.config import get_roveagent_home
    return get_roveagent_home()


def load_home_env(home: Path) -> dict[str, str]:
    env = dict(os.environ)
    env_file = home / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"'))
    return env


def check_platforms(home: Path) -> dict[str, dict[str, object]]:
    env = load_home_env(home)
    report: dict[str, dict[str, object]] = {}
    for key, meta in PLATFORMS.items():
        deps_ok = all(importlib.util.find_spec(m) for m in meta["deps"])
        missing_env = [e for e in meta["required_env"] if not env.get(e)]
        report[key] = {
            "label": meta["label"],
            "deps": deps_ok,
            "missing_env": missing_env,
            "ready": deps_ok and not missing_env,
            "get_token_url": meta["get_token_url"],
        }
    return report


def read_enabled(home: Path) -> dict[str, bool]:
    import yaml
    cfg_path = home / "config.yaml"
    if not cfg_path.exists():
        return {}
    data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    platforms = ((data.get("gateway") or {}).get("platforms")) or {}
    if not isinstance(platforms, dict):
        # gateway setup 写出的 list 形态：[- telegram, ...]
        if isinstance(platforms, list):
            return {str(p): True for p in platforms}
        return {}
    return {k: bool((v or {}).get("enabled")) for k, v in platforms.items() if isinstance(v, dict)}


def enable_platforms(home: Path, names: list[str]) -> None:
    """把指定平台写入 config.yaml（dict 形态，保留既有内容）。"""
    import yaml
    cfg_path = home / "config.yaml"
    data: dict = {}
    if cfg_path.exists():
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    gateway = data.setdefault("gateway", {})
    platforms = gateway.get("platforms")
    if isinstance(platforms, list):  # list 形态升级为 dict 形态
        platforms = {str(p): {"enabled": True} for p in platforms}
    if not isinstance(platforms, dict):
        platforms = {}
    for name in names:
        entry = platforms.setdefault(name, {})
        entry["enabled"] = True
    gateway["platforms"] = platforms
    cfg_path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                        encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--enable", action="store_true",
                    help="把 token 就绪的平台写入 config.yaml 启用")
    args = ap.parse_args()

    home = roveagent_home()
    report = check_platforms(home)
    enabled = read_enabled(home)

    print(f"roveagent home: {home}\n")
    print(f"{'platform':<10} {'deps':<6} {'token':<7} {'enabled':<8} 备注")
    for key, r in report.items():
        missing = ", ".join(r["missing_env"])  # type: ignore[arg-type]
        note = "" if r["ready"] else f"缺 {missing or 'deps'} → {r['get_token_url']}"
        print(f"{key:<10} {str(r['deps']):<6} {str(not missing):<7} "
              f"{str(enabled.get(key, False)):<8} {note}")

    if args.enable:
        ready = [k for k, r in report.items() if r["ready"]]
        if not ready:
            print("\n没有 token 就绪的平台可启用。")
            return 1
        enable_platforms(home, ready)
        print(f"\n已启用: {', '.join(ready)}（写入 {home / 'config.yaml'}）")
        print("重启网关生效: roveagent gateway run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
