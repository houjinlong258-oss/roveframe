"""Business Goal Engine — 业务目标引擎（蓝图 Phase 5）。

用户说："月营收提升 20%" →

    Understand（解析目标）
    → Analyze（读取经营数据层）
    → Strategize（生成策略步骤模板）
    → Assign（分配到 AI 员工）
    → Tasks（生成可执行任务）
    → Approval（高风险步骤进审批队列）
    → Execute（经 EnterpriseToolGate 执行）
    → Measure（对照 KPI 度量）

策略模板是确定性的骨架；LLM 生成的细案通过 kernel dispatch 注入到
任务 description 中，骨架保证企业流程不跑偏。
"""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class GoalTask:
    id: str
    title: str
    assignee: str               # employee key
    kind: str                   # analyze | propose | execute | measure
    status: str = "pending"     # pending | awaiting_approval | done | failed
    detail: str = ""
    result: str = ""


@dataclass
class Goal:
    id: str
    tenant_id: str
    objective: str
    metric: str = ""
    target_value: str = ""
    status: str = "planning"    # planning | active | completed | failed
    strategy: list[str] = field(default_factory=list)
    tasks: list[GoalTask] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)


# 目标关键词 → (metric, 建议策略骨架, 涉及员工)
_OBJECTIVE_PATTERNS: list[tuple[re.Pattern, str, list[str], list[str]]] = [
    (re.compile(r"(营收|销售|revenue|sales).{0,12}(提升|增加|增长|increase|grow|boost)|increase.{0,20}revenue", re.I),
     "revenue",
     ["分析近 90 天营收趋势与品类结构，定位下滑/机会点",
      "客户分群：找出高价值与流失风险客群",
      "生成营销唤回/提客单价方案并测算折扣影响",
      "业主审批活动方案",
      "执行获批活动并追踪每日营收变化"],
     ["operations", "customer", "marketing", "ceo", "marketing"]),
    (re.compile(r"(成本|cost|expense).{0,12}(降|减|reduce|cut)|(降|减).{0,8}(成本|cost)|reduce.{0,20}cost", re.I),
     "cost",
     ["拆解成本结构（食材/人力/能耗）",
      "识别异常支出与浪费点",
      "生成降本方案（采购/排班/库存）",
      "业主审批高风险变更",
      "执行并每周对照毛利"],
     ["finance", "operations", "finance", "ceo", "operations"]),
    (re.compile(r"(评价|评分|review|rating|口碑)", re.I),
     "reputation",
     ["拉取近 30 天差评趋势与关键词",
      "定位主要投诉类别并给出整改建议",
      "生成差评回复与补偿策略",
      "经理审批对外回复",
      "执行回复并追踪评分变化"],
     ["customer", "operations", "customer", "ceo", "customer"]),
    (re.compile(r"(库存|inventory|缺货|stock)", re.I),
     "inventory",
     ["盘点当前库存周转与缺货记录",
      "建立需求预测（节假日/天气因子）",
      "生成采购与备货建议",
      "业主审批采购单",
      "执行采购并监控缺货率"],
     ["operations", "operations", "operations", "ceo", "operations"]),
]

_KIND_BY_INDEX = ["analyze", "analyze", "propose", "execute", "measure"]


class BusinessGoalEngine:
    """目标引擎：不依赖 LLM 即可产出可审批、可执行、可度量的任务骨架。"""

    def understand(self, objective: str) -> tuple[str, str]:
        """从自然语言目标中提取指标与目标值。"""
        m = re.search(r"(\d+)\s*%", objective)
        target = f"{m.group(1)}%" if m else ""
        for pat, metric, _, _ in _OBJECTIVE_PATTERNS:
            if pat.search(objective):
                return metric, target
        return "general", target

    def strategize(self, objective: str) -> tuple[list[str], list[str]]:
        for pat, _, strategy, owners in _OBJECTIVE_PATTERNS:
            if pat.search(objective):
                return list(strategy), list(owners)
        return (["分析现状与基线数据", "形成改进假设", "生成行动方案",
                 "业主审批", "执行并度量结果"],
                ["operations", "finance", "marketing", "ceo", "operations"])

    def create_goal(self, tenant_id: str, objective: str) -> Goal:
        metric, target = self.understand(objective)
        strategy, owners = self.strategize(objective)
        goal = Goal(id=uuid.uuid4().hex[:12], tenant_id=tenant_id,
                    objective=objective, metric=metric, target_value=target)
        goal.strategy = strategy
        for i, (step, owner) in enumerate(zip(strategy, owners)):
            kind = _KIND_BY_INDEX[i] if i < len(_KIND_BY_INDEX) else "execute"
            status = "awaiting_approval" if ("审批" in step or "approve" in step.lower()) else "pending"
            goal.tasks.append(GoalTask(
                id=uuid.uuid4().hex[:8], title=step, assignee=owner,
                kind=kind, status=status,
                detail=f"objective={objective} metric={metric} target={target}",
            ))
        return goal


# ---------------------------------------------------------------------------
# LLM 细化：骨架 → 具体文案/预算（蓝图路线图项）
# ---------------------------------------------------------------------------
_REFINE_PROMPT = """你是连锁门店经营顾问。基于下面的经营目标与策略骨架，把每个步骤细化为可直接执行的具体方案。

经营目标：{objective}
指标：{metric}　目标值：{target}
企业记忆（可能为空）：
{memory}

策略骨架：
{skeleton}

要求：
1. 分析类步骤：给出要拉取的具体数据口径、对比维度、判断阈值。
2. 提案类步骤：给出具体营销/运营文案（含标题与正文要点）、预算拆分（金额与占比）、预估效果区间。
3. 审批类步骤：列出审批人需要核查的关键数字与风险点。
4. 执行/度量类步骤：给出执行节奏（天/周）、KPI 口径与达标线。
5. 所有金额用 USD；文案用目标客户的语言（默认跟随目标原文语言）。

只输出 JSON（不要输出其他内容）：
{{"steps": [{{"id": "<步骤id>", "detail": "<细化方案，200字内>", "budget": "<预算说明，无预算填 '-'>", "kpi": "<度量口径，无则填 '-'>"}}]}}"""


def refine_goal_with_llm(
    goal: Goal,
    chat_fn,
    memory_block: str = "(no memory)",
) -> str:
    """用 LLM 把策略骨架细化为具体文案/预算，写回各 task.detail。

    ``chat_fn(system, user) -> str`` 由宿主注入（RoveAgent Service 走
    runtime.AIAgent；测试可注入假函数）。LLM 失败/输出无法解析时保留
    骨架原样，返回状态串："ok" | "failed" —— 骨架保证流程不跑偏，
    LLM 只负责增强，绝不允许细化失败拖垮目标创建。
    """
    import json
    import logging

    logger = logging.getLogger(__name__)
    skeleton = "\n".join(
        f"- id={t.id} [{t.kind}] {t.title}（负责：{t.assignee}）"
        for t in goal.tasks
    )
    prompt = _REFINE_PROMPT.format(
        objective=goal.objective, metric=goal.metric,
        target=goal.target_value or "（未指定）",
        memory=memory_block, skeleton=skeleton,
    )
    try:
        raw = chat_fn(
            "你是 RoveFrame AI Business OS 的经营策略细化器，只输出合法 JSON。",
            prompt,
        )
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            raise ValueError("no JSON in LLM output")
        data = json.loads(m.group(0))
        by_id = {str(s.get("id", "")): s for s in data.get("steps", [])}
        refined = 0
        for task in goal.tasks:
            s = by_id.get(task.id)
            if not s or not s.get("detail"):
                continue
            parts = [str(s["detail"])]
            if s.get("budget") and s["budget"] != "-":
                parts.append(f"预算：{s['budget']}")
            if s.get("kpi") and s["kpi"] != "-":
                parts.append(f"KPI：{s['kpi']}")
            task.detail = "\n".join(parts)
            refined += 1
        if refined == 0:
            raise ValueError("LLM output matched no task ids")
        logger.info("goal %s refined by LLM (%d/%d steps)",
                    goal.id, refined, len(goal.tasks))
        return "ok"
    except Exception as e:
        logger.warning("goal %s LLM refine failed, skeleton kept: %s", goal.id, e)
        return "failed"
