"""Industry Pack 加载器。

每个行业包包含：Skills / Agents / Connectors / Templates / Knowledge Base。
内置 Restaurant Pack；Hotel / Retail / Clinic 通过同一接口扩展。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

PACKS_DIR = Path(__file__).parent / "packs"


@dataclass
class IndustryPack:
    key: str
    name: str
    agents: list[str] = field(default_factory=list)
    connectors: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    templates: dict[str, str] = field(default_factory=dict)
    knowledge_base: list[str] = field(default_factory=list)


def list_packs() -> list[str]:
    if not PACKS_DIR.exists():
        return []
    return sorted(p.stem for p in PACKS_DIR.glob("*.json"))


def load_pack(key: str) -> Optional[IndustryPack]:
    path = PACKS_DIR / f"{key}.json"
    if not path.exists():
        return None
    return IndustryPack(**json.loads(path.read_text(encoding="utf-8")))


def load_pack_knowledge(key: str) -> dict[str, str]:
    """读取行业包知识库实际内容：{文件名: Markdown 正文}。

    知识文件位于 ``packs/knowledge/<pack>/``，文件名以 pack JSON 的
    ``knowledge_base`` 清单为准（清单外的文件不加载，防止漂移）。
    """
    pack = load_pack(key)
    if pack is None:
        return {}
    base = PACKS_DIR / "knowledge" / key
    out: dict[str, str] = {}
    for name in pack.knowledge_base:
        p = base / name
        if p.exists():
            out[name] = p.read_text(encoding="utf-8")
    return out


def sync_pack_knowledge(memory: Any, key: str) -> int:
    """把行业包知识写入企业记忆 L1_INDUSTRY（幂等）。

    幂等依据：L1 层已存在该行业 kind='pack_knowledge' 的记录则跳过。
    返回新写入的条数。
    """
    knowledge = load_pack_knowledge(key)
    if not knowledge:
        return 0
    from ..state.enterprise_memory import MemoryLayer

    cur = memory.db.execute(
        "SELECT COUNT(*) FROM memory WHERE layer=? AND industry=? AND kind='pack_knowledge'",
        (int(MemoryLayer.L1_INDUSTRY), key),
    )
    if cur.fetchone()[0] >= len(knowledge):
        return 0
    # 存在部分残留时先清后写，保证内容一致
    memory.db.execute(
        "DELETE FROM memory WHERE layer=? AND industry=? AND kind='pack_knowledge'",
        (int(MemoryLayer.L1_INDUSTRY), key),
    )
    memory.db.commit()
    for fname, content in knowledge.items():
        memory.add(f"[{key}/{fname}]\n{content}", MemoryLayer.L1_INDUSTRY,
                   industry=key, kind="pack_knowledge", importance=0.6)
    return len(knowledge)
