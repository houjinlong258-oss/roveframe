"""RoveAgent Enterprise Tool Framework — 所有工具执行的强制前置门控。

蓝图 Phase 7 落地：任何工具调用必须依次通过

    Schema 校验 → 可信上下文 → 权限检查 → 风险分级 → 审批策略 → 执行 → 审计事件

设计为轻量、零第三方依赖；由 runtime/gateway 在每次 tool dispatch 前调用
``EnterpriseToolGate.authorize()``。审批本身对接 RoveFrame Approval
Workflow（TS 侧），本模块产出结构化的审批请求并留痕。

用法::

    gate = EnterpriseToolGate(audit_sink=my_audit_fn)
    decision = gate.authorize(ctx, "refund_payment", {"amount": 25.0})
    if decision.requires_approval:
        ...enqueue approval...
    elif decision.allowed:
        result = execute(...)

``ctx`` 必须由可信服务边界创建，并包含完整租户、业务、用户与请求身份。
"""
from __future__ import annotations

import fnmatch
import time
import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable, Mapping, Optional


class RiskLevel(IntEnum):
    LOW = 0        # 只读、无副作用
    MEDIUM = 1     # 可逆写操作
    HIGH = 2       # 资金/对外通信/不可逆
    CRITICAL = 3   # 生产变更、部署、删除


class ApprovalPolicy(str):
    NONE = "none"                  # 直接执行
    MANAGER = "manager"            # 店长/经理审批
    OWNER = "owner"                # 业主审批
    ADMIN = "admin"                # RoveFrame 平台管理员审批


@dataclass(frozen=True)
class ToolPolicy:
    """单个工具的治理策略。"""
    pattern: str                    # 工具名或 glob，如 "refund_*"
    permission: str = ""            # 所需权限点，如 "analytics:read"
    risk: RiskLevel = RiskLevel.LOW
    approval: str = ApprovalPolicy.NONE
    audit: bool = True              # 是否强制审计留痕
    schema: Mapping[str, str] = field(default_factory=dict)  # 参数名 -> 类型名
    description: str = ""
    audit_category: str = "business_tool"


@dataclass(frozen=True, slots=True)
class ToolContext:
    tenant_id: str = ""
    business_id: str = ""
    user_id: str = ""
    role: str = ""
    permissions: frozenset[str] = frozenset()
    request_id: str = ""
    task_id: str = ""
    agent_id: str = ""


@dataclass
class GateDecision:
    allowed: bool
    requires_approval: bool
    approval_policy: str = ApprovalPolicy.NONE
    reason: str = ""
    risk: RiskLevel = RiskLevel.LOW
    audit_event_id: str = ""


# ---------------------------------------------------------------------------
# 默认策略表 —— 顺序匹配，先命中先生效；企业可在部署时追加/覆盖。
# ---------------------------------------------------------------------------
DEFAULT_POLICIES: list[ToolPolicy] = [
    # RoveFrame canonical business-data adapter (read-only, scope-bound)
    ToolPolicy("read_sales", "orders:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_orders", "orders:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_customers", "customers:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_products", "products:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_inventory", "inventory:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_reviews", "reviews:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_payments", "payments:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("read_business_profile", "settings:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    # 资金操作：业主审批
    ToolPolicy("refund_*", "payments:refund", RiskLevel.HIGH, ApprovalPolicy.OWNER),
    ToolPolicy("*payment*", "payments:write", RiskLevel.HIGH, ApprovalPolicy.OWNER),
    ToolPolicy("*payout*", "finance:write", RiskLevel.CRITICAL, ApprovalPolicy.OWNER),
    # 部署 / 生产变更：管理员审批
    ToolPolicy("deploy_*", "admin:deploy", RiskLevel.CRITICAL, ApprovalPolicy.ADMIN),
    ToolPolicy("process_kill", "admin:process", RiskLevel.HIGH, ApprovalPolicy.ADMIN),
    # 对外通信：经理审批
    ToolPolicy("send_*", "comms:send", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("*message*", "comms:send", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    # 写操作：可逆，记录即可
    ToolPolicy("write_file", "files:write", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("patch", "files:write", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    # 只读分析类
    ToolPolicy("read_*", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("*_sales", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    # 兜底
    ToolPolicy("*", "", RiskLevel.LOW, ApprovalPolicy.NONE),
]

_ROLE_RANK = {"viewer": 0, "staff": 1, "manager": 2, "owner": 3, "admin": 4}
_APPROVAL_ROLE = {
    ApprovalPolicy.NONE: None,
    ApprovalPolicy.MANAGER: "manager",
    ApprovalPolicy.OWNER: "owner",
    ApprovalPolicy.ADMIN: "admin",
}

_TYPE_CHECKERS: dict[str, Callable[[Any], bool]] = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "float": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "list": lambda v: isinstance(v, list),
    "dict": lambda v: isinstance(v, dict),
}


class EnterpriseToolGate:
    """工具门控：Schema → Context → Permission → Risk → Approval → Audit。"""

    def __init__(
        self,
        policies: Optional[list[ToolPolicy]] = None,
        audit_sink: Optional[Callable[[Mapping[str, Any]], None]] = None,
    ) -> None:
        # 追加式覆盖：自定义策略排在默认之前
        self.policies = list(policies or []) + DEFAULT_POLICIES
        self._audit_sink = audit_sink

    # -- 策略匹配 ------------------------------------------------------
    def policy_for(self, tool_name: str) -> ToolPolicy:
        for p in self.policies:
            if fnmatch.fnmatchcase(tool_name, p.pattern):
                return p
        return DEFAULT_POLICIES[-1]

    def metadata_for(self, tool_name: str) -> dict[str, Any]:
        """Return the complete governance metadata exposed for every tool."""
        policy = self.policy_for(tool_name)
        return {
            "name": tool_name,
            "description": policy.description,
            "input_schema": dict(policy.schema),
            "required_permissions": [policy.permission] if policy.permission else [],
            "risk_level": policy.risk.name.lower(),
            "approval_policy": policy.approval,
            "audit_category": policy.audit_category,
        }

    # -- 1. Schema 校验 -------------------------------------------------
    @staticmethod
    def validate_schema(policy: ToolPolicy, args: Mapping[str, Any]) -> Optional[str]:
        for name, type_name in policy.schema.items():
            if name not in args:
                return f"missing required argument: {name}"
            checker = _TYPE_CHECKERS.get(type_name)
            if checker and not checker(args[name]):
                return f"argument {name!r} must be {type_name}"
        return None

    # -- 2. 权限检查 -----------------------------------------------------
    @staticmethod
    def check_permission(policy: ToolPolicy, ctx: ToolContext) -> Optional[str]:
        if not policy.permission:
            return None
        if "*" in ctx.permissions or policy.permission in ctx.permissions:
            return None
        return f"permission denied: requires {policy.permission!r}"

    # -- 3. 审批策略 -----------------------------------------------------
    @staticmethod
    def check_approval(policy: ToolPolicy, ctx: ToolContext) -> bool:
        """返回 True 表示当前角色级别已足够、可免审批直执。"""
        required_role = _APPROVAL_ROLE.get(policy.approval)
        if required_role is None:
            return True
        return _ROLE_RANK.get(ctx.role, 0) >= _ROLE_RANK[required_role] + 1

    # -- 主入口 ----------------------------------------------------------
    def authorize(
        self,
        ctx: ToolContext,
        tool_name: str,
        args: Optional[Mapping[str, Any]] = None,
    ) -> GateDecision:
        args = args or {}
        policy = self.policy_for(tool_name)
        event_id = uuid.uuid4().hex

        schema_error = self.validate_schema(policy, args)
        required_context = {
            "tenant_id": ctx.tenant_id,
            "business_id": ctx.business_id,
            "user_id": ctx.user_id,
            "role": ctx.role,
            "request_id": ctx.request_id,
            "task_id": ctx.task_id,
        }
        missing = [name for name, value in required_context.items() if not value]
        if schema_error:
            decision = GateDecision(False, False, reason=f"schema: {schema_error}",
                                    risk=policy.risk, audit_event_id=event_id)
        elif missing:
            decision = GateDecision(
                False,
                False,
                reason=f"missing trusted tool context: {', '.join(missing)}",
                risk=policy.risk,
                audit_event_id=event_id,
            )
        else:
            permission_error = self.check_permission(policy, ctx)
            if permission_error:
                decision = GateDecision(False, False, reason=permission_error,
                                        risk=policy.risk, audit_event_id=event_id)
            elif not self.check_approval(policy, ctx):
                decision = GateDecision(False, True, policy.approval,
                                        reason=f"approval required: {policy.approval}",
                                        risk=policy.risk, audit_event_id=event_id)
            else:
                decision = GateDecision(True, False, risk=policy.risk,
                                        audit_event_id=event_id)

        # -- 4. 审计留痕（包括被拒绝的尝试） -----------------------------
        if policy.audit and self._audit_sink:
            self._audit_sink({
                "event_id": event_id,
                "ts": time.time(),
                "tenant_id": ctx.tenant_id,
                "business_id": ctx.business_id,
                "user_id": ctx.user_id,
                "agent_id": ctx.agent_id,
                "role": ctx.role,
                "request_id": ctx.request_id,
                "task_id": ctx.task_id,
                "tool": tool_name,
                "risk": policy.risk.name,
                "required_permissions": [policy.permission] if policy.permission else [],
                "approval_policy": policy.approval,
                "audit_category": policy.audit_category,
                "allowed": decision.allowed,
                "requires_approval": decision.requires_approval,
                "reason": decision.reason,
            })
        return decision
