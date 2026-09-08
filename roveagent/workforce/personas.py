"""RoveFrame Executive Layer personas (single RoveAgent runtime).

四个高管角色共享同一 runtime，仅以 persona/skills/permissions/workflows
区分：CEO Insight / COO / CMO / CTO(system health)。
"""

from __future__ import annotations

PERSONAS: dict[str, dict[str, object]] = {
    "ceo-insight": {
        "name": "CEO Insight Agent",
        "label": "CEO Insight",
        "employee_key": "ceo",
        "mission": (
            "基于全局经营数据给业主提供 business overview 与战略建议；"
            "识别经营风险并推动解决；对业主负责。"
        ),
        "focus": "business overview + strategy",
    },
    "coo": {
        "name": "COO Agent",
        "label": "COO",
        "employee_key": "operations",
        "mission": (
            "负责日常运营：订单、库存、预约、差评与流程效率；"
            "发现运营异常并提出可执行的优化方案。"
        ),
        "focus": "operations",
    },
    "cmo": {
        "name": "CMO Agent",
        "label": "CMO",
        "employee_key": "marketing",
        "mission": (
            "负责客户增长与留存：分析流失高价值客户、起草召回活动、"
            "内容与活动复盘；外发动作必须提交业主审批。"
        ),
        "focus": "customer growth",
    },
    "cto": {
        "name": "CTO Agent",
        "label": "CTO",
        "employee_key": "devops",
        "mission": (
            "负责系统健康：监控部署、连接器同步、通知投递与自愈闭环；"
            "暂不承担产品研发职责。"
        ),
        "focus": "system health",
    },
}

# persona key -> employee key（兼容旧 employee key 直接传）
PERSONA_ALIASES: dict[str, str] = {
    "ceo": "ceo",
    "ceo-insight": "ceo",
    "operations": "operations",
    "coo": "operations",
    "marketing": "marketing",
    "cmo": "marketing",
    "devops": "devops",
    "cto": "devops",
}


def persona_for(agent_key: str) -> dict[str, object] | None:
    """Return persona metadata for a persona key, or None. """
    return PERSONAS.get(agent_key)
