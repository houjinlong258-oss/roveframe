"""Skill Marketplace — 技能市场（蓝图路线图项）。

聚合三个来源的技能，供租户浏览与安装：

    builtin  行业包自带技能（skills/packs/*.json 的 skills 清单）
    library  内置技能库（skills_library/<category>/<skill>/SKILL.md）
    tenant   租户自建技能（<root>/skills/tenant-<id>/<name>/SKILL.md）

安装 = 把技能定义复制进租户技能目录（与 /api/agent/skill/create
同一约定），并写入 L2 租户记忆 + 审计。重名安装为幂等覆盖。

Phase 11 / Task 4 —— Plan A（方案 A）
------------------------------------
本模块是技能系统的**唯一公开入口**。此前只存在于
``roveagent/skills_market/`` 且**零生产引用**的安全能力，现已吸收到本模块的
安装路径上：

    scanner.py      写入前对制品做启发式安全扫描（注入/隐藏字符/危险命令/
                    外联/凭据访问/路径逃逸 + AST 代码分析）
    permissions.py  从清单与扫描结果**推导**能力请求，再与授权集**判定**
                    （声明永远不会被自动当作授权）
    versions.py     读取制品真实版本号并在报告中暴露
    sandbox.py      作为「技能代码执行隔离可用性」对外发布（执行期契约，
                    不是安装期闸门 —— 见下）

设计约束（必须保持）：

1. **不改动、不搬迁、不删除 ``roveagent/skills_market/`` 的任何文件。**
   它的 127 个测试以绝对路径导入 ``roveagent.skills_market.*``。
2. **默认不改变现有安装行为**。扫描与权限判定**始终执行并记录**，
   但「据此拒绝安装」是显式开关（``ROVEAGENT_SKILL_ENFORCE``，默认关闭）。
   理由：``install_from_directory(granted=())`` 会拒绝一切，若默认强制，
   ``/api/agent/skills/install`` 会对所有请求返回 404 —— 这是产品决策，
   不是实现细节，因此改为可观测 + 可开启，而不是静默翻转。
3. **``sandbox.py`` 没有安装期闸门**。它定义 ``SandboxRuntime`` 契约，
   ``default_registry()`` 按设计返回**空注册表**（本机不能执行任何技能代码）。
   诚实的吸收方式是把 ``describe()`` 发布出去，让运维看得见隔离现状。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .packs import list_packs, load_pack

_SKILLS_LIBRARY = Path(__file__).parent.parent / "skills_library"

#: 开启后，扫描的 HIGH/CRITICAL 发现与未满足的能力授权会**阻止安装**
#: （``install`` 返回 ``None``）。默认关闭 = 保持既有行为，扫描仅记录。
SKILL_ENFORCE_ENV = "ROVEAGENT_SKILL_ENFORCE"

_TRUTHY = {"1", "true", "yes", "on"}


def enforcement_enabled(explicit: Optional[bool] = None) -> bool:
    """是否强制安全判定。显式参数优先于环境变量；默认 False。"""
    if explicit is not None:
        return bool(explicit)
    return os.environ.get(SKILL_ENFORCE_ENV, "").strip().lower() in _TRUTHY


@dataclass
class MarketSkill:
    name: str
    description: str = ""
    industry: str = ""          # 行业包来源标记；通用技能为空
    category: str = ""          # library 来源的分类目录名
    source: str = "builtin"     # builtin | library | tenant
    workflow: str = ""          # SKILL.md 正文（library/tenant 来源可读）
    installed_for: list[str] = field(default_factory=list)  # 已安装租户
    # Phase 11 / Task 4：制品在磁盘上的真实位置与版本。
    # 扫描器必须读**原始**制品目录（而不是重新合成的 SKILL.md），
    # 否则 prerequisites/metadata 会丢失，能力推导被静默削弱。
    path: Optional[Path] = None
    version: str = ""


def _read_skill_md(path: Path) -> tuple[str, str, str]:
    """从 SKILL.md 提取 (description, workflow, version)。"""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return "", "", ""
    desc = ""
    m = re.search(r"^description:\s*(.+)$", text, re.M)
    if m:
        desc = m.group(1).strip()
    version = ""
    v = re.search(r"^version:\s*(.+)$", text, re.M)
    if v:
        version = v.group(1).strip().strip("\"'")
    body = re.sub(r"\A---.*?---\s*", "", text, flags=re.S)
    return desc, body.strip(), version


def catalog(root: Optional[Path] = None) -> list[MarketSkill]:
    """汇总全部可安装技能（去重：tenant 覆盖 library 覆盖 builtin）。"""
    items: dict[str, MarketSkill] = {}

    # 1. 行业包技能（描述来自包 JSON 的 templates/skills 清单，无正文）
    pack_industries: dict[str, set[str]] = {}
    for key in list_packs():
        pack = load_pack(key)
        if not pack:
            continue
        for name in pack.skills:
            pack_industries.setdefault(name, set()).add(key)
            items.setdefault(name, MarketSkill(
                name=name, industry=key, source="builtin",
                description=f"{pack.name} 内置技能",
            ))
    # 多行业共享的技能标记为通用（industry 为空），避免错误归属
    for name, inds in pack_industries.items():
        if len(inds) > 1 and name in items:
            items[name].industry = ""

    # 2. 内置技能库（读 SKILL.md 拿到真实描述与正文）
    if _SKILLS_LIBRARY.exists():
        for md in sorted(_SKILLS_LIBRARY.glob("*/*/SKILL.md")):
            desc, body, version = _read_skill_md(md)
            items[md.parent.name] = MarketSkill(
                name=md.parent.name, description=desc,
                category=md.parent.parent.name, source="library",
                workflow=body, path=md.parent, version=version,
            )

    # 3. 租户自建（标记 installed_for）
    if root:
        tdir = Path(root) / "skills"
        if tdir.exists():
            for tenant_dir in sorted(tdir.glob("tenant-*")):
                tenant_id = tenant_dir.name[len("tenant-"):]
                for md in sorted(tenant_dir.glob("*/SKILL.md")):
                    desc, body, version = _read_skill_md(md)
                    name = md.parent.name
                    if name in items:
                        items[name].installed_for.append(tenant_id)
                    else:
                        items[name] = MarketSkill(
                            name=name, description=desc, source="tenant",
                            workflow=body, installed_for=[tenant_id],
                            path=md.parent, version=version,
                        )
    return sorted(items.values(), key=lambda s: (s.source != "builtin", s.name))


def _sandbox_report() -> dict[str, Any]:
    """发布技能代码执行的隔离现状（执行期契约，非安装期闸门）。"""
    try:
        from ..skills_market.sandbox import default_registry

        registry = default_registry()
        return {
            "available": [r.get("name") or r.get("trust_level")
                          for r in registry.describe()],
            "runtimes": registry.describe(),
        }
    except Exception as exc:  # 安全能力不可用时必须显式可见，不能静默
        return {"available": [], "runtimes": [], "error": str(exc)}


def evaluate_install(entry: "MarketSkill", *,
                     granted: Optional[frozenset] = None,
                     enforce: Optional[bool] = None) -> dict[str, Any]:
    """对一个目录中的技能条目跑完整安全流水线。**只读，永不抛异常。**

    返回报告 dict，字段：

        scanned         扫描是否真的完成（``scanner_error`` 非空时为 False）
        allowed         当前策略下是否允许安装
        enforced        是否处于强制模式
        findings        全部发现（``Finding.as_dict()``）
        blocking        HIGH/CRITICAL 发现
        requested       从清单+扫描推导出的能力请求
        granted         实际授权集
        missing         requested - granted
        version         制品声明的真实版本
        sandbox         技能代码执行隔离现状

    任何内部异常都转化为 ``allowed=False`` + ``scanner_error``：
    「扫描失败」必须表现为拒绝，而不是表现为「干净」。
    """
    report: dict[str, Any] = {
        "skill": entry.name,
        "source": entry.source,
        "version": entry.version or "",
        "scanned": False,
        "allowed": True,
        "enforced": enforcement_enabled(enforce),
        "findings": [],
        "blocking": [],
        "requested": [],
        "granted": [],
        "missing": [],
        "scanner_error": "",
        "sandbox": {},
    }

    source_dir = Path(entry.path) if entry.path else None
    if source_dir is None or not source_dir.is_dir():
        # builtin 行业包条目在磁盘上没有制品，无物可扫。
        report["sandbox"] = _sandbox_report()
        return report

    try:
        from ..skills_market.manifest import load_manifest
        from ..skills_market.permissions import (
            capabilities_from_content,
            decide,
            grant_all,
        )
        from ..skills_market.scanner import is_install_allowed, scan_skill
    except Exception as exc:
        report["scanner_error"] = f"security pipeline unavailable: {exc}"
        report["allowed"] = False
        return report

    try:
        manifest = load_manifest(source_dir)
    except Exception as exc:
        report["scanner_error"] = f"manifest invalid: {exc}"
        report["allowed"] = False
        return report

    if getattr(manifest, "version", ""):
        report["version"] = str(manifest.version)

    try:
        scan = scan_skill(source_dir, manifest)
    except Exception as exc:
        report["scanner_error"] = f"scan raised: {exc}"
        report["allowed"] = False
        return report

    report["scanned"] = not scan.scanner_error
    report["scanner_error"] = scan.scanner_error
    report["findings"] = [f.as_dict() for f in scan.findings]
    report["blocking"] = [f.as_dict() for f in scan.blocking]

    requested = capabilities_from_content(
        required_commands=tuple(getattr(manifest, "required_commands", ()) or ()),
        required_env=tuple(getattr(manifest, "required_env", ()) or ()),
        detected=tuple(scan.detected_capabilities or ()),
    )
    # granted=None 表示运维未配置授权策略 —— 保持既有「可安装一切」语义，
    # 但把该事实显式写进报告，便于审计与后续切换到强制模式。
    if granted is None:
        effective_grant = grant_all()
        report["grant_policy"] = "implicit-all"
    else:
        effective_grant = frozenset(granted)
        report["grant_policy"] = "explicit"

    decision = decide(requested, effective_grant)
    report["requested"] = sorted(c.value for c in requested)
    report["granted"] = sorted(c.value for c in effective_grant)
    report["missing"] = sorted(c.value for c in decision.missing)

    allowed = is_install_allowed(scan, enforce=report["enforced"])
    if report["enforced"] and not decision.ok:
        allowed = False
    report["allowed"] = bool(allowed)
    report["sandbox"] = _sandbox_report()
    return report


def install_ex(root: Path, tenant_id: str, name: str,
               industry: str = "",
               *,
               granted: Optional[frozenset] = None,
               enforce: Optional[bool] = None) -> tuple[Optional[Path], dict[str, Any]]:
    """同 :func:`install`，但额外返回安全流水线报告（供审计落库）。

    返回 ``(path, report)``。``path`` 为 ``None`` 表示未安装。
    """
    # P0-10：tenant_id 白名单校验（防止 ../../ 路径穿越写入任意目录）
    from ..api.security import require_safe_id, sanitize_skill_name
    try:
        tenant_id = require_safe_id(tenant_id, label="tenant_id")
    except ValueError:
        return None, {"skill": name, "allowed": False, "reason": "unsafe tenant_id"}
    safe = sanitize_skill_name(name)
    entry = next((s for s in catalog(None) if s.name == safe), None)
    if entry is None:
        return None, {"skill": safe, "allowed": False, "reason": "not in catalog"}

    # --- Plan A seam -----------------------------------------------------
    # 位置至关重要：必须在这两个 return None 之后，否则
    # roveagent/api/path_safety_test.py 的两个用例会从 assertIsNone 变成异常。
    report = evaluate_install(entry, granted=granted, enforce=enforce)
    if not report["allowed"]:
        return None, report
    # ---------------------------------------------------------------------

    dest = Path(root) / "skills" / f"tenant-{tenant_id}" / safe
    dest.mkdir(parents=True, exist_ok=True)
    md = dest / "SKILL.md"
    md.write_text(
        f"---\nname: {safe}\ndescription: {entry.description}\n"
        f"industry: {industry or entry.industry}\n"
        f"source: {entry.source}\n---\n\n{entry.workflow}\n",
        encoding="utf-8")
    report["installed_path"] = str(md)
    return md, report


def install(root: Path, tenant_id: str, name: str,
            industry: str = "") -> Optional[Path]:
    """把技能安装进租户目录，返回 SKILL.md 路径；技能不存在返回 None。

    Phase 11 / Task 4：签名与返回类型**保持不变**；安全流水线在其内部执行
    （见 :func:`install_ex` 与 :func:`evaluate_install`）。
    """
    path, _report = install_ex(root, tenant_id, name, industry)
    return path
