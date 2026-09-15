"""Plugin Center（Phase 3）—— 插件生态的统一服务面。

设计原则：**零重复实现**
------------------------
插件生命周期（install / enable / disable / remove / update）在
``clisupport/plugins_cmd.py`` 里**已经实现且已被 dashboard 使用**：

    dashboard_install_plugin(identifier, *, force, enable)
    dashboard_set_agent_plugin_enabled(name, *, enabled)
    dashboard_remove_user_plugin(name)
    dashboard_update_user_plugin(name)

本模块**只做三件事**，不重写上面任何一个：

1. **汇总**：把「发现（manifests）+ 状态（enabled/disabled）+ 安全信封审计」
   合成一份给前端与运维用的视图；
2. **补上缺失的安全维度**：既有的 ``list_plugins()`` 不含资源访问信封，
   本模块用 ``plugin_security`` 的静态审计补齐（网络/文件系统/进程/原生代码）；
3. **暴露成服务**：供 ``api/app.py`` 的端点调用。

不做什么
--------
- 不改 ``PluginManifest`` / ``CAPABILITY_REGISTRY`` / 既有加载路径
- 不新增插件框架
- 不在本模块里执行插件代码

安全前提
--------
``audit`` 默认**只报告不阻断**（``enforce=False``），保持既有加载行为不变。
要启用阻断，由调用方显式传 ``enforce=True`` —— 那属于策略决策，不是本模块默认。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from .plugin_security import audit_plugin

logger = logging.getLogger(__name__)

__all__ = [
    "list_plugins_with_envelopes",
    "get_plugin_detail",
    "install_plugin",
    "set_plugin_enabled",
    "remove_plugin",
    "update_plugin",
    "plugin_center_summary",
]


def _discover_all() -> List[Dict[str, Any]]:
    """复用既有发现逻辑，返回原始条目（bundled + user）。

    ``_discover_all_plugins()`` 返回 ``(name, version, description, source,
    path, key)`` 元组列表 —— 见 ``plugins_cmd.py``。
    """
    try:
        from ..clisupport.plugins_cmd import _discover_all_plugins

        entries: List[Dict[str, Any]] = []
        for row in _discover_all_plugins():
            name, version, description, source, path, key = (list(row) + [None] * 6)[:6]
            entries.append({
                "name": name,
                "version": version,
                "description": description,
                "source": source,
                "path": path,
                "key": key or name,
            })
        return entries
    except Exception as exc:  # noqa: BLE001 — 发现失败不致命
        logger.warning("plugin discovery failed: %s", exc)
        return []


def _enabled_state() -> tuple[set[str], set[str]]:
    try:
        from ..clisupport.plugins_cmd import _get_disabled_set, _get_enabled_set

        return set(_get_enabled_set()), set(_get_disabled_set())
    except Exception as exc:  # noqa: BLE001
        logger.warning("plugin enabled-state read failed: %s", exc)
        return set(), set()


def _manifest_for(path: Optional[str]) -> Any:
    """尽力取得 manifest 对象（用于信封声明）。失败返回 None。"""
    if not path:
        return None
    try:
        from ..clisupport.plugins import PluginManifest

        candidate = Path(str(path))
        yaml_path = candidate / "plugin.yaml" if candidate.is_dir() else candidate
        if not yaml_path.exists():
            return None
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — 无 pyyaml 时退化为空声明
            data = {}
        if not isinstance(data, dict):
            data = {}
        known = {f.name for f in PluginManifest.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return PluginManifest(**{k: v for k, v in data.items() if k in known})
    except Exception as exc:  # noqa: BLE001
        logger.debug("manifest load failed for %s: %s", path, exc)
        return None


def list_plugins_with_envelopes(*, include_audit: bool = True) -> List[Dict[str, Any]]:
    """插件清单 + 状态 + 安全信封。

    ``include_audit=False`` 时跳过静态扫描（大仓下更快，供列表轮询使用）。
    """
    enabled, disabled = _enabled_state()
    out: List[Dict[str, Any]] = []

    for entry in _discover_all():
        name = str(entry.get("name") or "")
        key = str(entry.get("key") or name)
        source = str(entry.get("source") or "")

        # 状态语义：被显式 disabled 覆盖 enabled；bundled 默认可用
        if name in disabled:
            state = "disabled"
        elif name in enabled:
            state = "enabled"
        else:
            state = "bundled" if source == "bundled" else "installed"

        record: Dict[str, Any] = {
            "name": name,
            "key": key,
            "version": entry.get("version") or "",
            "description": entry.get("description") or "",
            "source": source,
            "state": state,
            "enabled": state != "disabled",
            "removable": source != "bundled",
            "path": entry.get("path"),
        }

        if include_audit and entry.get("path"):
            try:
                manifest = _manifest_for(entry.get("path"))
                audit = audit_plugin(
                    manifest if manifest is not None else type("M", (), {"key": key, "name": name})(),
                    Path(str(entry["path"])),
                )
                record["security"] = audit.as_dict()
            except Exception as exc:  # noqa: BLE001 — 审计失败不拖垮列表
                logger.warning("plugin audit failed for %s: %s", name, exc)
                record["security"] = {
                    "severity": "UNKNOWN", "ok": False,
                    "notes": [f"audit failed: {exc}"], "scan_failed": True,
                }

        out.append(record)

    out.sort(key=lambda r: (r.get("security", {}).get("severity", "ZZ"), r["name"]))
    return out


def get_plugin_detail(name: str, *, include_audit: bool = True) -> Optional[Dict[str, Any]]:
    """单个插件详情。未找到返回 None。"""
    for record in list_plugins_with_envelopes(include_audit=include_audit):
        if record["name"] == name or record["key"] == name:
            return record
    return None


def plugin_center_summary() -> Dict[str, Any]:
    """Plugin Center 概览（给运维/设置页顶部用）。

    **风险信号要按来源区分**：bundled 插件随产品发布、随产品审计，
    把它们全列进 ``needs_review`` 只会制造噪音（实测 54 个里 43 个会中招）。
    真正需要运维关注的是**第三方（user 安装）**的插件 —— 那才是「不可信代码」。
    因此：

    - ``needs_review``：只列 **user** 来源且 severity 为 CRITICAL/HIGH 的插件
    - ``bundled_high_risk``：bundled 的高危项单独放，供安全审计参考
    - ``untrusted_total``：第三方插件总数（0 表示当前没有不可信代码）
    """
    plugins = list_plugins_with_envelopes(include_audit=True)
    by_severity: Dict[str, int] = {}
    by_state: Dict[str, int] = {}
    by_source: Dict[str, int] = {}
    needs_review: List[str] = []
    bundled_high_risk: List[str] = []

    for record in plugins:
        security = record.get("security") or {}
        severity = str(security.get("severity") or "UNKNOWN")
        by_severity[severity] = by_severity.get(severity, 0) + 1
        state = str(record.get("state") or "unknown")
        by_state[state] = by_state.get(state, 0) + 1
        source = str(record.get("source") or "unknown")
        by_source[source] = by_source.get(source, 0) + 1

        if severity not in ("CRITICAL", "HIGH"):
            continue
        if source == "bundled":
            bundled_high_risk.append(record["name"])
        else:
            needs_review.append(record["name"])

    untrusted = sum(
        count for source, count in by_source.items() if source != "bundled"
    )

    return {
        "total": len(plugins),
        "by_state": by_state,
        "by_source": by_source,
        "by_severity": by_severity,
        # 第三方插件里需要关注的具体名字（这才是可执行的运维信号）
        "needs_review": sorted(needs_review),
        # bundled 的高危项：随产品分发，供安全审计参考，不当作运维待办
        "bundled_high_risk": sorted(bundled_high_risk),
        "untrusted_total": untrusted,
        "enforce_enabled": False,  # 当前审计只报告；见 plugin_security.is_load_allowed
        # 隔离状态：静态扫描回答「代码里有什么」，这一项回答「它在哪里运行」。
        # 两者回答不同的问题，缺一不可 —— 一个权限干净但跑在主进程里的插件，
        # 一次崩溃仍能带走整个 OS。
        "isolation": _isolation_block(plugins),
    }


def _isolation_block(plugins: List[Dict[str, Any]]) -> Dict[str, Any]:
    """每插件的隔离判定 + 汇总。失败不致命：隔离报告出错不能拖垮插件列表。"""
    try:
        from .plugin_isolation import isolation_status_for_discovered, isolation_summary

        statuses = isolation_status_for_discovered(plugins)
        return {"summary": isolation_summary(statuses), "plugins": statuses}
    except Exception as exc:  # noqa: BLE001 — 与既有发现失败同样处理
        logger.warning("plugin isolation status failed: %s", exc)
        return {"summary": {"total": 0, "error": str(exc)}, "plugins": []}


# ---------------------------------------------------------------------------
# 生命周期操作：**全部委托**既有 dashboard API，不重复实现
# ---------------------------------------------------------------------------

def install_plugin(identifier: str, *, force: bool = False,
                   enable: bool = True) -> Dict[str, Any]:
    """安装插件（Git URL / owner/repo / 索引名）。

    委托 ``clisupport.plugins_cmd.dashboard_install_plugin``。
    **注意**：安装会写入 ``~/.roveagent/plugins/``，属用户级变更。
    """
    if not identifier or not str(identifier).strip():
        return {"ok": False, "error": "identifier is required"}
    try:
        from ..clisupport.plugins_cmd import dashboard_install_plugin

        return dashboard_install_plugin(str(identifier).strip(), force=force, enable=enable)
    except Exception as exc:  # noqa: BLE001
        logger.warning("plugin install failed for %s: %s", identifier, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def set_plugin_enabled(name: str, *, enabled: bool) -> Dict[str, Any]:
    """启用/禁用插件（写 config.yaml）。

    委托 ``dashboard_set_agent_plugin_enabled`` —— 它会同时调整
    ``platform_toolsets``，保证 agent 真的能看到该插件提供的工具。
    """
    if not name or not str(name).strip():
        return {"ok": False, "error": "name is required"}
    try:
        from ..clisupport.plugins_cmd import dashboard_set_agent_plugin_enabled

        return dashboard_set_agent_plugin_enabled(str(name).strip(), enabled=enabled)
    except Exception as exc:  # noqa: BLE001
        logger.warning("plugin toggle failed for %s: %s", name, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def remove_plugin(name: str) -> Dict[str, Any]:
    """移除**用户安装**的插件。

    委托 ``dashboard_remove_user_plugin`` —— 它显式拒绝删除 bundled 插件。
    """
    if not name or not str(name).strip():
        return {"ok": False, "error": "name is required"}
    try:
        from ..clisupport.plugins_cmd import dashboard_remove_user_plugin

        return dashboard_remove_user_plugin(str(name).strip())
    except Exception as exc:  # noqa: BLE001
        logger.warning("plugin remove failed for %s: %s", name, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def update_plugin(name: str) -> Dict[str, Any]:
    """更新用户安装的插件（git pull）。"""
    if not name or not str(name).strip():
        return {"ok": False, "error": "name is required"}
    try:
        from ..clisupport.plugins_cmd import dashboard_update_user_plugin

        return dashboard_update_user_plugin(str(name).strip())
    except Exception as exc:  # noqa: BLE001
        logger.warning("plugin update failed for %s: %s", name, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
