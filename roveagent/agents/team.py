"""AI 员工团队定义：每位 Agent 绑定职责、能力与可执行动作。

Agent 通过 kernel.dispatch(agent_key, task) 执行，所有动作经权限引擎门控并写审计日志。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..enterprise.registry import AgentRegistry, AgentSpec


@dataclass
class AgentMember:
    spec: AgentSpec
    # 可执行动作表：action -> handler(kernel_ctx, **kwargs)
    actions: dict[str, Callable[..., Any]] = field(default_factory=dict)

    def can(self, action: str) -> bool:
        return action in self.actions


def build_default_team() -> AgentRegistry:
    """一句话部署时自动生成的 AI 员工团队（愿景第 6 步）。"""
    reg = AgentRegistry()
    reg.register(AgentSpec(
        key="ceo", name="CEO Agent", role="企业经营分析与战略建议",
        responsibilities=["企业经营分析", "战略建议", "每日经营总结"],
        capabilities=["agent", "rag"],
    ))
    reg.register(AgentSpec(
        key="operations", name="Operations Agent", role="订单、库存与流程优化",
        responsibilities=["订单监控", "库存管理", "流程优化", "采购建议"],
        capabilities=["agent"],
    ))
    reg.register(AgentSpec(
        key="marketing", name="Marketing Agent", role="营销活动与客户增长",
        responsibilities=["营销活动", "客户增长", "社交内容"],
        capabilities=["content", "agent"],
    ))
    reg.register(AgentSpec(
        key="customer", name="Customer Agent", role="客户关系与留存",
        responsibilities=["客户关系", "差评处理", "流失预测"],
        capabilities=["rag", "content"],
    ))
    reg.register(AgentSpec(
        key="developer", name="Developer Agent", role="代码分析与功能升级",
        responsibilities=["代码分析", "Bug 修复", "功能升级"],
        capabilities=["agent"],
    ))
    reg.register(AgentSpec(
        key="devops", name="DevOps Agent", role="部署、监控与服务器维护",
        responsibilities=["部署", "监控", "服务器维护", "自愈闭环执行"],
        capabilities=["agent"],
    ))
    return reg
