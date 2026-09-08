"""RoveAgent Workforce System — 企业 AI 员工体系（蓝图 Phase 4）。

每位 AI 员工 = Identity + Role + Department + Mission + Skills + Memory
+ Permissions + Tools + KPIs。与 ``agents/team.py`` 的 AgentRegistry
兼容（employee.to_spec()），并补充企业级字段：部门、使命、KPI、
工具白名单（对接 EnterpriseToolGate 权限点）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from ..enterprise.registry import AgentRegistry, AgentSpec


@dataclass
class KPI:
    name: str
    target: str
    metric: str           # business data layer 指标键


@dataclass
class AIEmployee:
    """一位 AI 员工的完整档案。"""
    key: str
    name: str
    role: str
    department: str
    mission: str
    responsibilities: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    permissions: list[str] = field(default_factory=list)   # EnterpriseToolGate 权限点
    tools: list[str] = field(default_factory=list)         # 允许的工具 glob
    forbidden: list[str] = field(default_factory=list)
    kpis: list[KPI] = field(default_factory=list)
    escalation: str = "ceo"   # 升级上报对象

    def to_spec(self) -> AgentSpec:
        return AgentSpec(
            key=self.key, name=self.name, role=self.role,
            responsibilities=list(self.responsibilities),
            capabilities=["agent"],
        )


def build_workforce() -> list[AIEmployee]:
    """RoveFrame 标准 AI 员工编制（7 岗）。"""
    return [
        AIEmployee(
            key="ceo", name="CEO Agent", role="经营战略与决策支持",
            department="executive",
            mission="基于全局经营数据制定战略、仲裁跨部门决策、对业主负责。",
            responsibilities=["经营分析", "战略建议", "审批高风险动作", "每日经营总结"],
            skills=["daily-briefing", "business-analysis"],
            permissions=["analytics:read"],
            tools=["read_*", "*_sales", "memory", "session_search"],
            kpis=[KPI("月营收增长率", ">=15%", "revenue_growth"),
                  KPI("审批响应时长", "<=2h", "approval_latency")],
            escalation="owner",
        ),
        AIEmployee(
            key="operations", name="Operations Agent", role="日常经营优化",
            department="operations",
            mission="监控销售/库存/评价，发现异常并提出可执行的优化方案。",
            responsibilities=["订单监控", "库存管理", "流程优化", "采购建议"],
            skills=["inventory-forecast", "daily-briefing", "menu-optimization"],
            permissions=["analytics:read", "inventory:read"],
            tools=["read_*", "*_sales", "inventory_*", "todo", "memory"],
            forbidden=["refund_payment", "change_pricing"],
            kpis=[KPI("缺货率", "<=3%", "stockout_rate"),
                  KPI("异常检测提前量", ">=24h", "anomaly_lead_time")],
        ),
        AIEmployee(
            key="marketing", name="Marketing Agent", role="客户增长与留存",
            department="marketing",
            mission="设计并执行获客/唤回活动，对活动 ROI 负责。",
            responsibilities=["营销活动", "客户增长", "社交内容", "活动复盘"],
            skills=["win-back-campaign", "content-calendar"],
            permissions=["analytics:read", "comms:draft"],
            tools=["read_*", "customers_*", "memory"],
            forbidden=["send_*"],   # 外发需经理审批（门控强制）
            kpis=[KPI("活动 ROI", ">=3x", "campaign_roi"),
                  KPI("流失唤回率", ">=8%", "winback_rate")],
        ),
        AIEmployee(
            key="customer", name="Customer Agent", role="客户沟通与口碑",
            department="customer_success",
            mission="24h 内响应每一条差评，维护客户关系与复购。",
            responsibilities=["客户关系", "差评处理", "流失预测"],
            skills=["review-response", "reservation-triage"],
            permissions=["analytics:read", "customers:read"],
            tools=["read_*", "customers_*", "reviews_*", "memory"],
            kpis=[KPI("差评响应时长", "<=24h", "review_response_time"),
                  KPI("评分", ">=4.5", "avg_rating")],
        ),
        AIEmployee(
            key="finance", name="Finance Agent", role="营收与成本分析",
            department="finance",
            mission="算清每一笔活动的账：折扣影响、成本结构、现金流预警。",
            responsibilities=["营收分析", "成本分析", "折扣影响测算", "对账"],
            skills=["margin-analysis", "cost-watchdog"],
            permissions=["analytics:read", "finance:read"],
            tools=["read_*", "*_sales", "memory"],
            forbidden=["*payment*", "*payout*"],
            kpis=[KPI("毛利率偏差", "<=2pp", "gross_margin_dev"),
                  KPI("现金流预警提前量", ">=7d", "cashflow_lead")],
        ),
        AIEmployee(
            key="developer", name="Developer Agent", role="系统改进",
            department="engineering",
            mission="分析与改进 RoveFrame 系统本身，修复缺陷、交付功能。",
            responsibilities=["代码分析", "Bug 修复", "功能升级"],
            skills=["code-review", "repo-search"],
            permissions=["files:read", "analytics:read"],
            tools=["read_*", "search_files", "todo"],
            forbidden=["deploy_*", "write_file"],
            kpis=[KPI("缺陷关闭周期", "<=3d", "bug_cycle_time")],
        ),
        AIEmployee(
            key="devops", name="DevOps Agent", role="基础设施与自愈",
            department="engineering",
            mission="保障部署、监控与服务器健康，驱动自愈闭环。",
            responsibilities=["部署", "监控", "服务器维护", "自愈闭环执行"],
            skills=["self-healing", "deploy-checklist"],
            permissions=["admin:process"],
            tools=["read_*", "process", "terminal"],
            forbidden=["deploy_*"],   # 部署需 admin 审批（门控强制）
            kpis=[KPI("可用性", ">=99.9%", "uptime"),
                  KPI("自愈成功率", ">=90%", "healing_rate")],
        ),
    ]


def workforce_registry() -> AgentRegistry:
    """转为与既有内核兼容的 AgentRegistry。"""
    reg = AgentRegistry()
    for emp in build_workforce():
        reg.register(emp.to_spec())
    return reg


def find_employee(key: str) -> Optional[AIEmployee]:
    for emp in build_workforce():
        if emp.key == key:
            return emp
    # Executive persona aliases（ceo-insight/coo/cmo/cto → 统一 runtime 员工）
    from .personas import PERSONA_ALIASES
    mapped = PERSONA_ALIASES.get(key)
    if mapped:
        for emp in build_workforce():
            if emp.key == mapped:
                return emp
    return None
