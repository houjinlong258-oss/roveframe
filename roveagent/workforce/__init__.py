"""RoveAgent Workforce — 企业 AI 员工系统。

- ``employees``: AI 员工档案（Identity/Role/Department/Mission/Skills/
  Permissions/Tools/KPIs）与标准 7 岗编制。
- ``goals``: Business Goal Engine —— 业务目标 → 策略 → 任务 → 审批 → 执行 → 度量。
"""
from .employees import AIEmployee, KPI, build_workforce, find_employee, workforce_registry
from .goals import BusinessGoalEngine, Goal, GoalTask, refine_goal_with_llm

__all__ = [
    "AIEmployee", "KPI", "build_workforce", "find_employee", "workforce_registry",
    "BusinessGoalEngine", "Goal", "GoalTask", "refine_goal_with_llm",
]
