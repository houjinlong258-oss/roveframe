"""Skill Marketplace — 技能市场（蓝图路线图项）。

聚合三个来源的技能，供租户浏览与安装：

    builtin  行业包自带技能（skills/packs/*.json 的 skills 清单）
    library  内置技能库（skills_library/<category>/<skill>/SKILL.md）
    tenant   租户自建技能（<root>/skills/tenant-<id>/<name>/SKILL.md）

安装 = 把技能定义复制进租户技能目录（与 /api/agent/skill/create
同一约定），并写入 L2 租户记忆 + 审计。重名安装为幂等覆盖。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .packs import list_packs, load_pack

_SKILLS_LIBRARY = Path(__file__).parent.parent / "skills_library"


@dataclass
class MarketSkill:
    name: str
    description: str = ""
    industry: str = ""          # 行业包来源标记；通用技能为空
    category: str = ""          # library 来源的分类目录名
    source: str = "builtin"     # builtin | library | tenant
    workflow: str = ""          # SKILL.md 正文（library/tenant 来源可读）
    installed_for: list[str] = field(default_factory=list)  # 已安装租户


def _read_skill_md(path: Path) -> tuple[str, str]:
    """从 SKILL.md 提取 (description, workflow)。"""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return "", ""
    desc = ""
    m = re.search(r"^description:\s*(.+)$", text, re.M)
    if m:
        desc = m.group(1).strip()
    body = re.sub(r"\A---.*?---\s*", "", text, flags=re.S)
    return desc, body.strip()


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
            desc, body = _read_skill_md(md)
            items[md.parent.name] = MarketSkill(
                name=md.parent.name, description=desc,
                category=md.parent.parent.name, source="library",
                workflow=body,
            )

    # 3. 租户自建（标记 installed_for）
    if root:
        tdir = Path(root) / "skills"
        if tdir.exists():
            for tenant_dir in sorted(tdir.glob("tenant-*")):
                tenant_id = tenant_dir.name[len("tenant-"):]
                for md in sorted(tenant_dir.glob("*/SKILL.md")):
                    desc, body = _read_skill_md(md)
                    name = md.parent.name
                    if name in items:
                        items[name].installed_for.append(tenant_id)
                    else:
                        items[name] = MarketSkill(
                            name=name, description=desc, source="tenant",
                            workflow=body, installed_for=[tenant_id],
                        )
    return sorted(items.values(), key=lambda s: (s.source != "builtin", s.name))


def install(root: Path, tenant_id: str, name: str,
            industry: str = "") -> Optional[Path]:
    """把技能安装进租户目录，返回 SKILL.md 路径；技能不存在返回 None。"""
    safe = "".join(c for c in name if c.isalnum() or c in "-_").lower()
    if not safe:
        return None
    entry = next((s for s in catalog(None) if s.name == safe), None)
    if entry is None:
        return None
    dest = Path(root) / "skills" / f"tenant-{tenant_id}" / safe
    dest.mkdir(parents=True, exist_ok=True)
    md = dest / "SKILL.md"
    md.write_text(
        f"---\nname: {safe}\ndescription: {entry.description}\n"
        f"industry: {industry or entry.industry}\n"
        f"source: {entry.source}\n---\n\n{entry.workflow}\n",
        encoding="utf-8")
    return md
