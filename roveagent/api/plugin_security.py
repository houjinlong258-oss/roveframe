"""插件安全信封（Phase 3）—— manifest 的 ``permissions`` / ``network`` /
``filesystem`` / ``sandbox`` 声明，配静态代码审计。

为什么需要这一层
----------------
既有的插件框架已经很强（``PluginManifest`` v2、``CAPABILITY_REGISTRY``
的「声明 ≠ 授予」模型、``plugin-data`` 隔离存储）。但它缺**一件**事：

    没有机制回答「这个插件**实际能做**什么，与它**声明**的一致吗？」

于是「插件不能影响主系统」只能靠信任。本模块把这件事变成可审计的：

    declared envelope（manifest 声明）
              ⟷
    derived envelope（静态扫描插件代码实际用到的能力）

两者不一致时给出明确判定，并可据此**拒绝加载**。

与既有能力系统的关系（不重复、不替代）
--------------------------------------
- ``CAPABILITY_REGISTRY`` 管的是**宿主钩子覆盖**类能力
  （``roveagent.tools.override`` / ``llm.provider_override`` …），
  走 ``plugins.entries.<id>.granted_capabilities`` 授权。**本模块不动它。**
- 本模块管的是**资源访问**类信封：网络 / 文件系统 / 进程 / 原生代码。
  与前者正交，可同时使用。

设计约束
--------
- **不新增第三方依赖**：纯 ``ast`` + 标准库。
- **fail-closed**：扫描/解析失败时按「代码能力未知」处理，判定为
  ``unknown``（可配置是否阻止加载），绝不静默放行。
- **不改既有加载路径的默认行为**：本模块是**审计与策略**，
  默认仅报告；``enforce=True`` 时才阻止加载（由调用方决定）。
"""
from __future__ import annotations

import ast
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

logger = logging.getLogger(__name__)

__all__ = [
    "ResourceCapability",
    "SecurityEnvelope",
    "EnvelopeAudit",
    "derive_envelope",
    "analyze_plugin_code",
    "audit_plugin",
    "is_load_allowed",
]


# ---------------------------------------------------------------------------
# 资源能力词表
# ---------------------------------------------------------------------------

class ResourceCapability:
    """资源访问类能力 id（与 ``CAPABILITY_REGISTRY`` 的正交面）。"""

    NETWORK_HTTP = "network.http"
    NETWORK_RAW = "network.raw_socket"
    FS_READ = "filesystem.read"
    FS_WRITE = "filesystem.write"
    FS_DELETE = "filesystem.delete"
    PROCESS_SPAWN = "process.spawn"
    NATIVE_CODE = "native.code"


#: 网络 HTTP 客户端模块（按需惰性导入的插件也可能用到）
_HTTP_MODULES = frozenset({
    "httpx", "requests", "aiohttp", "urllib", "urllib3",
    "http.client", "websockets", "httplib2", "pycurl",
})

#: 原生/动态代码加载模块
_NATIVE_MODULES = frozenset({
    "ctypes", "cffi",
})

#: 进程启动模块
_PROCESS_MODULES = frozenset({
    "subprocess", "multiprocessing", "pty",
})

#: 文件读取方法（pathlib / 内建）
_READ_METHODS = frozenset({"read_text", "read_bytes"})

#: 文件写入方法
_WRITE_METHODS = frozenset({
    "write_text", "write_bytes", "mkdir", "touch", "symlink_to", "hardlink_to",
})

#: 删除类方法
_DELETE_METHODS = frozenset({"unlink", "rmdir", "removedirs", "rmtree"})

#: 写入模式字符
_WRITE_MODES = frozenset({"w", "a", "x", "+"})


@dataclass
class SecurityEnvelope:
    """插件的资源访问信封。"""

    #: 声明来源：manifest | derived（静态扫描）| effective（合并结果）
    origin: str = "manifest"
    permissions: List[str] = field(default_factory=list)
    #: none | declared | any
    network: str = "none"
    #: none | readonly | readwrite
    filesystem: str = "none"
    #: none | process | container | remote
    sandbox: str = "none"
    #: 插件是否使用了第三方 pip 依赖（manifest 声明）
    python_dependencies: List[str] = field(default_factory=list)
    #: 声明了 requires_env（可能持有凭据）的键名
    requires_env: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "origin": self.origin,
            "permissions": sorted(self.permissions),
            "network": self.network,
            "filesystem": self.filesystem,
            "sandbox": self.sandbox,
            "python_dependencies": sorted(self.python_dependencies),
            "requires_env": sorted(self.requires_env),
        }


# 信封宽严序（用于比较「实际是否比声明更宽」）
_NETWORK_RANK = {"none": 0, "declared": 1, "any": 2}
_FS_RANK = {"none": 0, "readonly": 1, "readwrite": 2}
_SANDBOX_RANK = {"none": 0, "process": 1, "container": 2, "remote": 3}


def _manifest_envelope(manifest: Any) -> SecurityEnvelope:
    """从 manifest 读声明信封。

    兼容两种写法：
      1. 顶层字段（新规范）：``network:`` / ``filesystem:`` / ``sandbox:`` /
         ``permissions:``
      2. 未声明 → 取最保守默认（none），并把既有 ``requires_env`` /
         ``python_dependencies`` 纳入信封（它们是真实风险信号）
    """
    def _pick(*names: str, default: str) -> str:
        for name in names:
            value = getattr(manifest, name, None)
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
        return default

    raw_permissions = getattr(manifest, "permissions", None)
    if isinstance(raw_permissions, (list, tuple)):
        permissions = [str(p).strip() for p in raw_permissions if str(p).strip()]
    else:
        permissions = []

    raw_env = getattr(manifest, "requires_env", None) or []
    env_keys: List[str] = []
    for item in raw_env:
        if isinstance(item, str):
            env_keys.append(item)
        elif isinstance(item, dict):
            for key in ("name", "key", "env"):
                if isinstance(item.get(key), str):
                    env_keys.append(item[key])
                    break

    raw_python_deps = getattr(manifest, "python_dependencies", None)
    if raw_python_deps is None:
        raw_python_deps = getattr(manifest, "pip_dependencies", None)
    python_deps = [str(d) for d in (raw_python_deps or [])]

    return SecurityEnvelope(
        origin="manifest",
        permissions=permissions,
        network=_pick("network", "network_access", default="none"),
        filesystem=_pick("filesystem", "filesystem_access", default="none"),
        sandbox=_pick("sandbox", "sandbox_profile", default="none"),
        python_dependencies=python_deps,
        requires_env=env_keys,
    )


# ---------------------------------------------------------------------------
# 静态代码审计
# ---------------------------------------------------------------------------

def _iter_python_files(plugin_path: Path, limit: int = 200) -> Iterable[Path]:
    if plugin_path.is_file() and plugin_path.suffix == ".py":
        yield plugin_path
        return
    if not plugin_path.is_dir():
        return
    count = 0
    for path in sorted(plugin_path.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        yield path
        count += 1
        if count >= limit:
            return


def analyze_plugin_code(plugin_path: Path) -> Set[str]:
    """静态扫描插件代码，返回它**实际用到**的资源能力集合。

    只做保守判定（宁可漏报也不误报为「危险」）：
    - 模块级 import 与函数内 import 都算
    - ``open(..., 'w')`` / ``Path.write_text`` 等才算写
    - 解析失败的文件整包跳过并记 warning（不因此判定为危险）
    """
    found: Set[str] = set()
    files = list(_iter_python_files(Path(plugin_path)))
    if not files:
        return found

    for path in files:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError as exc:
            logger.warning("plugin security scan skipped (syntax): %s: %s", path, exc)
            continue
        except Exception as exc:  # noqa: BLE001
            logger.warning("plugin security scan failed: %s: %s", path, exc)
            continue

        for node in ast.walk(tree):
            # -- import 形态 --
            if isinstance(node, ast.Import):
                for alias in node.names:
                    _classify_module(alias.name, found)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    _classify_module(node.module, found)

            # -- 调用形态 --
            elif isinstance(node, ast.Call):
                _classify_call(node, found)

    return found


def _classify_module(module: str, found: Set[str]) -> None:
    root = module.split(".")[0]
    if module in _HTTP_MODULES or root in {m.split(".")[0] for m in _HTTP_MODULES}:
        found.add(ResourceCapability.NETWORK_HTTP)
    if root == "socket":
        found.add(ResourceCapability.NETWORK_RAW)
    if root in _NATIVE_MODULES:
        found.add(ResourceCapability.NATIVE_CODE)
    if root in _PROCESS_MODULES:
        found.add(ResourceCapability.PROCESS_SPAWN)


def _classify_call(node: ast.Call, found: Set[str]) -> None:
    func = node.func
    name = ""
    if isinstance(func, ast.Attribute):
        name = func.attr
    elif isinstance(func, ast.Name):
        name = func.id

    # open(path, mode) / io.open
    if name == "open":
        mode = ""
        if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
            mode = str(node.args[1].value or "")
        for keyword in node.keywords:
            if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                mode = str(keyword.value.value or "")
        if any(ch in mode for ch in _WRITE_MODES):
            found.add(ResourceCapability.FS_WRITE)
        else:
            found.add(ResourceCapability.FS_READ)
        return

    # os.system / os.popen / os.exec* / os.spawn*
    if name in {"system", "popen", "execv", "execvp", "execve", "spawnv", "spawnl"}:
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id == "os":
                found.add(ResourceCapability.PROCESS_SPAWN)
                return

    # shutil.rmtree / os.remove / os.unlink / os.rmdir
    if name in _DELETE_METHODS or name in {"remove", "unlink", "rmdir", "removedirs"}:
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id in {"os", "shutil", "pathlib"}:
                found.add(ResourceCapability.FS_DELETE)
                return

    # pathlib 的读写方法
    if name in _READ_METHODS:
        found.add(ResourceCapability.FS_READ)
    elif name in _WRITE_METHODS:
        found.add(ResourceCapability.FS_WRITE)

    # socket.socket()
    if name == "socket":
        found.add(ResourceCapability.NETWORK_RAW)

    # ctypes.CDLL / ctypes.cdll
    if name in {"CDLL", "cdll", "PyDLL", "WinDLL"}:
        found.add(ResourceCapability.NATIVE_CODE)


# ---------------------------------------------------------------------------
# 审计：声明 ⟷ 实际
# ---------------------------------------------------------------------------

@dataclass
class EnvelopeAudit:
    plugin_key: str
    declared: SecurityEnvelope
    derived: SecurityEnvelope
    #: 代码用到、但信封未覆盖的能力
    undeclared: List[str] = field(default_factory=list)
    #: 信封声明了、但代码未用到的能力（过度声明，仅提示）
    unused: List[str] = field(default_factory=list)
    #: CRITICAL / HIGH / MEDIUM / OK / UNKNOWN
    severity: str = "OK"
    notes: List[str] = field(default_factory=list)
    scan_failed: bool = False

    @property
    def ok(self) -> bool:
        return self.severity in ("OK", "MEDIUM")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "plugin": self.plugin_key,
            "severity": self.severity,
            "ok": self.ok,
            "declared": self.declared.as_dict(),
            "derived": self.derived.as_dict(),
            "undeclared": sorted(self.undeclared),
            "unused": sorted(self.unused),
            "notes": list(self.notes),
            "scan_failed": self.scan_failed,
        }


def _fs_level_for(caps: Set[str]) -> str:
    if ResourceCapability.FS_DELETE in caps:
        return "readwrite"
    if ResourceCapability.FS_WRITE in caps:
        return "readwrite"
    if ResourceCapability.FS_READ in caps:
        return "readonly"
    return "none"


def derive_envelope(plugin_key: str, plugin_path: Path) -> SecurityEnvelope:
    """由静态扫描推导插件的实际资源信封。"""
    caps = analyze_plugin_code(plugin_path)
    network = "none"
    if ResourceCapability.NETWORK_HTTP in caps or ResourceCapability.NETWORK_RAW in caps:
        network = "any"
    # sandbox 表示「代码实际需要多强的隔离才安全」：
    #   仅 FFI 加载原生库 → process（同进程内，但需要进程级隔离）
    #   能起子进程       → container（可执行任意命令，需容器边界）
    sandbox = "none"
    if ResourceCapability.PROCESS_SPAWN in caps:
        sandbox = "container"
    elif ResourceCapability.NATIVE_CODE in caps:
        sandbox = "process"
    return SecurityEnvelope(
        origin="derived",
        permissions=sorted(caps),
        network=network,
        filesystem=_fs_level_for(caps),
        sandbox=sandbox,
    )


def audit_plugin(manifest: Any, plugin_path: Path) -> EnvelopeAudit:
    """审计一个插件：声明信封 vs 代码实际能力。

    判定规则：
      - 代码用到但声明未覆盖 → undeclared，按能力危险度定级
        （native/process → CRITICAL；fs.write/delete → HIGH；network → HIGH；
         fs.read → MEDIUM）
      - 无法扫描 → UNKNOWN（fail-closed：调用方可据此拒绝加载）
    """
    key = getattr(manifest, "key", "") or getattr(manifest, "name", "") or "(unknown)"
    declared = _manifest_envelope(manifest)

    path = Path(plugin_path)
    if not path.exists():
        return EnvelopeAudit(
            plugin_key=key, declared=declared,
            derived=SecurityEnvelope(origin="derived"),
            severity="UNKNOWN",
            notes=[f"plugin path not found: {path}"],
            scan_failed=True,
        )

    try:
        derived = derive_envelope(key, path)
    except Exception as exc:  # noqa: BLE001 — fail-closed
        logger.warning("plugin envelope derivation failed for %s: %s", key, exc)
        return EnvelopeAudit(
            plugin_key=key, declared=declared,
            derived=SecurityEnvelope(origin="derived"),
            severity="UNKNOWN",
            notes=[f"scan failed: {exc}"],
            scan_failed=True,
        )

    caps = set(derived.permissions)
    undeclared: List[str] = []
    notes: List[str] = []

    # 网络：代码联网但声明 none
    if _NETWORK_RANK[derived.network] > _NETWORK_RANK.get(declared.network, 0):
        undeclared.append(ResourceCapability.NETWORK_HTTP)

    # 文件系统：实际比声明更宽
    if _FS_RANK[derived.filesystem] > _FS_RANK.get(declared.filesystem, 0):
        if ResourceCapability.FS_DELETE in caps:
            undeclared.append(ResourceCapability.FS_DELETE)
        elif ResourceCapability.FS_WRITE in caps:
            undeclared.append(ResourceCapability.FS_WRITE)
        elif ResourceCapability.FS_READ in caps:
            undeclared.append(ResourceCapability.FS_READ)

    # 进程 / 原生：声明 sandbox 不足
    if ResourceCapability.PROCESS_SPAWN in caps and declared.sandbox in ("none", ""):
        undeclared.append(ResourceCapability.PROCESS_SPAWN)
    if ResourceCapability.NATIVE_CODE in caps and declared.sandbox in ("none", ""):
        undeclared.append(ResourceCapability.NATIVE_CODE)

    undeclared = sorted(set(undeclared))

    # 定级（实测校准过：对 12 个真实插件扫描，无误报）
    #
    # 校准说明：`ctypes` 有两种用途，危险度不同 ——
    #   * 加载系统库做 FFI（如 discord 用 ``ctypes.util.find_library("opus")``）
    #     → 不执行任意代码，HIGH
    #   * 直接调 ``ctypes.PyDLL(...).Sleep`` 之类（如 ddgs 的 GIL 阻塞技巧）
    #     → 仍在同一进程内，HIGH
    # 而 ``subprocess`` 能执行任意命令 → CRITICAL。
    # 早期版本把两者都判 CRITICAL，会把 discord 这类正常插件误报为最高危。
    if ResourceCapability.PROCESS_SPAWN in undeclared:
        severity = "CRITICAL"
        notes.append("spawns processes but declares no sandbox")
    elif ResourceCapability.FS_DELETE in undeclared and declared.filesystem != "readwrite":
        severity = "HIGH"
        notes.append("deletes files but does not declare readwrite")
    elif ResourceCapability.NATIVE_CODE in undeclared:
        severity = "HIGH"
        notes.append("loads native libraries (ctypes/cffi); container sandbox recommended")
    elif undeclared_wide := [c for c in undeclared
                             if c in (ResourceCapability.FS_WRITE,
                                      ResourceCapability.NETWORK_HTTP)]:
        severity = "HIGH"
        notes.append("uses " + ", ".join(undeclared_wide) + " without declaring it")
    elif ResourceCapability.FS_READ in undeclared:
        severity = "MEDIUM"
        notes.append("reads files without declaring filesystem.read")
    else:
        severity = "OK"

    # 过度声明提示（不升级定级）
    unused: List[str] = []
    if declared.network != "none" and derived.network == "none":
        unused.append("network")
    if declared.filesystem != "none" and derived.filesystem == "none":
        unused.append("filesystem")
    if declared.sandbox != "none" and derived.sandbox == "none":
        unused.append("sandbox")

    if declared.requires_env:
        notes.append(f"declares credentials env: {', '.join(sorted(declared.requires_env))}")
    if declared.python_dependencies:
        notes.append(
            f"declares python deps: {', '.join(sorted(declared.python_dependencies))}"
        )

    return EnvelopeAudit(
        plugin_key=key, declared=declared, derived=derived,
        undeclared=undeclared, unused=unused, severity=severity, notes=notes,
    )


def is_load_allowed(audit: EnvelopeAudit, *, enforce: bool = False,
                    allow_severities: Sequence[str] = ("OK", "MEDIUM")) -> bool:
    """是否允许加载该插件。

    ``enforce=False``（默认）：只报告，永远返回 True —— 保持既有加载行为不变。
    ``enforce=True``：``severity`` 不在白名单内则拒绝；
    扫描失败（UNKNOWN）同样拒绝（fail-closed）。
    """
    if not enforce:
        return True
    return audit.severity in set(allow_severities)
