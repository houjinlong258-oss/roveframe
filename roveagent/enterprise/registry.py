"""Agent 注册表：企业 AI 员工团队的声明式注册与查找。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AgentSpec:
    key: str
    name: str
    role: str
    responsibilities: list[str]
    capabilities: list[str] = field(default_factory=list)  # 映射 kernel capability: agent/content/rag/light
    industry_packs: list[str] = field(default_factory=list)


class AgentRegistry:
    def __init__(self) -> None:
        self._agents: dict[str, AgentSpec] = {}

    def register(self, spec: AgentSpec) -> AgentSpec:
        self._agents[spec.key] = spec
        return spec

    def get(self, key: str) -> Optional[AgentSpec]:
        return self._agents.get(key)

    def all(self) -> list[AgentSpec]:
        return list(self._agents.values())

    def for_industry(self, pack: str) -> list[AgentSpec]:
        return [a for a in self._agents.values() if not a.industry_packs or pack in a.industry_packs]
