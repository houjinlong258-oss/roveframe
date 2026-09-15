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
    invocation_id: str = ""


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
    # 知识库检索（租户自有文档，只读且受运行上下文作用域约束）。
    # 必须显式登记：末尾 `*` 兜底 = 已注册即放行且免审批，等于没有策略。
    # 已核对本行之前的所有模式均不会匹配 search_knowledge
    # （send_* 需前缀 send；search_files 是精确匹配），故不会成为死行。
    ToolPolicy("search_knowledge", "knowledge:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    # 资金操作：业主审批
    ToolPolicy("refund_*", "payments:refund", RiskLevel.HIGH, ApprovalPolicy.OWNER),
    ToolPolicy("*payment*", "payments:write", RiskLevel.HIGH, ApprovalPolicy.OWNER),
    ToolPolicy("*payout*", "finance:write", RiskLevel.CRITICAL, ApprovalPolicy.OWNER),
    # 部署 / 生产变更：管理员审批
    ToolPolicy("deploy_*", "admin:deploy", RiskLevel.CRITICAL, ApprovalPolicy.ADMIN),
    ToolPolicy("process_kill", "admin:process", RiskLevel.HIGH, ApprovalPolicy.ADMIN),
    # RoveFrame 客户召回活动（真实外发）：业主审批 —— CMO 起草、老板批准后真实发送
    ToolPolicy("send_customer_recovery_campaign", "comms:send",
               RiskLevel.HIGH, ApprovalPolicy.OWNER),
    # 对外通信：经理审批
    ToolPolicy("send_*", "comms:send", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("*message*", "comms:send", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    # 写文件：HIGH 风险 —— 任何角色都不得自动跳过审批（Phase 9）。
    # 原为 MEDIUM：owner/admin 凭 `rank >= required + 1` 可免审批直接改文件。
    ToolPolicy("write_file", "files:write", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("patch", "files:write", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    # 文件读取：必须排在下面 `read_*` 之前 —— policy_for() 顺序匹配、先命中先生效。
    # 在 Step 1.5 之前 read_file 会命中 `read_*` 被要求 analytics:read（业务分析权限），
    # 语义错误（见 docs/stage1-step1-runtime-connection-report.md 缺陷 A）。
    # 文件工具与业务查询工具严格分离：文件 → files:read，业务 → analytics:read。
    ToolPolicy("read_file", "files:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("search_files", "files:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    # 进程/终端：显式登记，禁止落到兜底策略。
    # 在 Step 1.5 之前二者命中 `*`（已注册 → 放行且免审批），属安全缺口（缺陷 B）。
    ToolPolicy("terminal", "admin:process", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("process", "admin:process", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    # 注意：process_kill / deploy_* / refund_* / send_* 等在策略表更靠前的位置
    # 已有显式行（顺序匹配先命中），因此这里不需要再补 `process_*` 之类的宽模式 ——
    # 加了也会被前面的行抢先匹配，成为死行。
    # 只读分析类（业务数据查询；文件工具不在此列）
    ToolPolicy("read_*", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("*_sales", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),

    # =======================================================================
    # Phase 9 —— Tool Policy Closure（default deny 前置：把工具全部显式登记）
    #
    # 背景：本次扫描发现 101 个已注册工具中 **82 个**只能命中末尾兜底行
    # （permission=""、approval=NONE），即「已注册 = 免权限、免审批直执」，
    # 其中包含 execute_code / computer_use / browser_exec / browser_cdp /
    # setup_mcp 等最高危工具。兜底行本身必须变成 DENY，但**不能**在工具没有
    # 显式策略时直接翻转 —— 那会让 82 个工具一次性失效。
    # 因此本段先把它们逐类显式登记，再在 authorize() 中把兜底改为拒绝。
    #
    # 顺序敏感：policy_for() 顺序匹配、先命中先生效，具体模式必须排在宽模式之前。
    # 权限保持为空串是有意为之：这些工具当前以空权限运行，赋一个调用方并不持有
    # 的新权限会造成「静默锁死」（manager/staff 立即失去今日可用的工具）。
    # 收紧的是**审批与风险**，权限收敛留待角色权限模型统一后再做。
    # =======================================================================

    # 1) 代码执行 / 桌面控制 / 浏览器调试 / MCP 装配 —— 最高危
    ToolPolicy("execute_code", "", RiskLevel.CRITICAL, ApprovalPolicy.MANAGER),
    ToolPolicy("computer_use", "", RiskLevel.CRITICAL, ApprovalPolicy.MANAGER),
    ToolPolicy("browser_exec", "", RiskLevel.CRITICAL, ApprovalPolicy.MANAGER),
    ToolPolicy("browser_cdp", "", RiskLevel.CRITICAL, ApprovalPolicy.MANAGER),
    ToolPolicy("setup_mcp", "", RiskLevel.HIGH, ApprovalPolicy.OWNER),
    ToolPolicy("close_terminal", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),

    # 2) 外部副作用 / 有成本 / 对外发布
    ToolPolicy("delegate_task", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("cronjob", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("skill_manage", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("discord_admin", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("ha_call_service", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("image_generate", "", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    ToolPolicy("video_generate", "", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    ToolPolicy("xai_video_edit", "", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    ToolPolicy("discord", "", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
    ToolPolicy("text_to_speech", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 3) 浏览器交互（会改变外部页面状态）
    ToolPolicy("browser_navigate", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("browser_click", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("browser_type", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("browser_press", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("browser_dialog", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("browser_scroll", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("browser_back", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("browser_snapshot", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("browser_get_images", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("browser_vision", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("browser_console", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 4) 协作看板（状态变更）
    ToolPolicy("kanban_attach_url", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_attach", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_request_changes", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_request_review", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_comment", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_complete", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_create", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_block", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_unblock", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_link", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("kanban_attachments", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("kanban_heartbeat", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("kanban_list", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("kanban_show", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 5) 只读检索 / 分析
    ToolPolicy("web_search", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("web_extract", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("x_search", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("vision_analyze", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("video_analyze", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("session_search", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("skills_list", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("skill_view", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("analyze_churn_customers", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("memory", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),

    # 6) 飞书文档 / 智能家居
    ToolPolicy("feishu_doc_read", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("feishu_drive_list_*", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("feishu_drive_add_comment", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("feishu_drive_reply_comment", "", RiskLevel.MEDIUM, ApprovalPolicy.NONE),
    ToolPolicy("ha_get_state", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("ha_list_*", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 7) 媒体/桌面预览与布局（本地视图状态）
    ToolPolicy("desktop_preview", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("desktop_project", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("drive_preview", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("annotate_preview", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("apply_layout", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("focus_pane", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 8) Spotify（外部账号：查询与播放控制）
    ToolPolicy("spotify_*", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 9) 交互辅助
    ToolPolicy("clarify", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("todo", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("tip", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("tour", "", RiskLevel.LOW, ApprovalPolicy.NONE),

    # 10) 元宝（YB）IM 通道：群查询只读；私信/贴纸属对外通信
    ToolPolicy("yb_query_group_info", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("yb_query_group_members", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("yb_search_sticker", "", RiskLevel.LOW, ApprovalPolicy.NONE),
    ToolPolicy("yb_send_dm", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
    ToolPolicy("yb_send_sticker", "", RiskLevel.HIGH, ApprovalPolicy.MANAGER),

    # 11) xAI 视频编辑（外部有成本）
    ToolPolicy("xai_video_extend", "", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),

    # =======================================================================
    # 兜底：DENY（Phase 9）。本行不再授予任何访问权 —— authorize() 只要检测到
    # 命中兜底行就拒绝，无论该工具是否已注册。保留此行的唯一目的是给
    # `_is_fallback()` 一个可识别的标记。
    # 新增工具时必须补显式策略行，否则该工具不可用 —— 这是刻意的 fail-closed。
    # =======================================================================
    ToolPolicy("*", "", RiskLevel.HIGH, ApprovalPolicy.ADMIN),
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

    @staticmethod
    def _is_fallback(policy: ToolPolicy) -> bool:
        """是否命中「兜底策略」（未在策略表中显式登记）。"""
        return policy.pattern == "*" and not policy.permission

    @staticmethod
    def _tool_is_registered(tool_name: str) -> bool:
        """延迟导入避免 framework ↔ registry 的模块级循环依赖。"""
        from ..tools.registry import registry

        return registry.get_entry(tool_name) is not None

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
    def decide_approval(role: str, required_role: Optional[str], risk: str) -> dict:
        """统一审批判定 —— 与 TS 侧 `approvals.decideApproval` 同契约（Phase 9 / Task 2）。

        两侧由同一份样例集校验：
        `tests/fixtures/approval_decision_contract.json`。
        在此之前两侧语义分叉：Python 用 `rank >= required + 1` 且完全不看 risk；
        TS 用 `rank >= required` 且对 admin 恒 false。同一个 (role, required_role)
        在两个平面上可能得出相反结论。

        规则（按顺序）：
          1. required_role 为 None            → 不需要审批
          2. risk ∈ {HIGH, CRITICAL}          → **必须审批，任何角色都不得自动跳过**
          3. required_role == 'admin'         → 必须审批；商户域无人可批（平台控制面动作）
          4. 其余（MEDIUM / LOW）             → 保留上级免审：rank(role) >= rank(required)+1
        """
        risk_name = risk.name if isinstance(risk, RiskLevel) else str(risk).upper()
        if required_role is None:
            return {
                "role": role, "required_role": None, "risk": risk_name,
                "approval_required": False, "reason": "no approval policy",
            }
        if risk_name in ("HIGH", "CRITICAL"):
            return {
                "role": role, "required_role": required_role, "risk": risk_name,
                "approval_required": True,
                "reason": f"{risk_name} risk requires approval; no role may auto-skip",
            }
        if required_role == "admin":
            return {
                "role": role, "required_role": required_role, "risk": risk_name,
                "approval_required": True,
                "reason": "platform-admin approval is outside the merchant RBAC domain",
            }
        sufficient = _ROLE_RANK.get(role, 0) >= _ROLE_RANK[required_role] + 1
        return {
            "role": role, "required_role": required_role, "risk": risk_name,
            "approval_required": not sufficient,
            "reason": (
                f"role {role} is senior to required role {required_role}"
                if sufficient else f"approval required: {required_role}"
            ),
        }

    @staticmethod
    def check_approval(policy: ToolPolicy, ctx: ToolContext) -> bool:
        """返回 True 表示当前角色级别已足够、可免审批直执。

        判定逻辑全部委托给 `decide_approval` —— 保证 Python gate 与 TS approvals
        不会各自演化出第二套语义。
        """
        decision = EnterpriseToolGate.decide_approval(
            ctx.role,
            _APPROVAL_ROLE.get(policy.approval),
            policy.risk,
        )
        return not decision["approval_required"]

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

        # Phase 9：default deny。只要命中兜底策略就拒绝，**不再区分工具是否已注册**。
        #
        # 原实现只拒绝「未注册」的工具，而本次扫描发现 101 个已注册工具中 82 个
        # 只能命中兜底行 —— 于是绝大多数工具在无权限、无审批的情况下直接执行
        # （含 execute_code / computer_use / browser_exec / browser_cdp / setup_mcp）。
        # 现在两条路径都拒绝：未注册 = unknown tool；已注册但无显式策略行 =
        # default deny。新增工具必须补策略行才能使用。
        if self._is_fallback(policy):
            registered = self._tool_is_registered(tool_name)
            reason = (
                f"unknown tool: {tool_name!r} is not registered"
                if not registered
                else f"tool {tool_name!r} has no explicit policy row (default deny)"
            )
            decision = GateDecision(
                False, False,
                reason=reason,
                risk=RiskLevel.HIGH, audit_event_id=event_id,
            )
            if policy.audit and self._audit_sink:
                self._audit_sink({
                    "event_id": event_id, "ts": time.time(),
                    "tenant_id": ctx.tenant_id, "business_id": ctx.business_id,
                    "user_id": ctx.user_id, "agent_id": ctx.agent_id,
                    "role": ctx.role, "request_id": ctx.request_id,
                    "task_id": ctx.task_id, "tool": tool_name,
                    "risk": RiskLevel.HIGH.name,
                    "required_permissions": [],
                    "approval_policy": ApprovalPolicy.ADMIN,
                    "audit_category": policy.audit_category,
                    "allowed": False, "requires_approval": False,
                    "reason": decision.reason,
                })
            return decision

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
