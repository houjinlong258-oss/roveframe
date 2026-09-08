"""企业门控 → Agent Loop 工具分发链路的接线模块。

把 ``tools.framework.EnterpriseToolGate`` 注册为 RoveAgent 插件系统的
``tool_execution`` 中间件，使每一次工具调用都强制经过：

    Schema → Context → Permission → Risk → Approval → Execute → Audit

集成点（上游自带，无需改动核心循环）：

    core/tool_executor.py::_run_agent_tool_execution_middleware
        → clisupport.middleware.run_tool_execution_middleware
        → clisupport.plugins 中间件注册表
        → 【本模块注册的 gate】→ 真正的工具实现

宿主（RoveFrame TS 桥 / 网关会话）通过 ``bind_tool_context`` 把不可变身份
绑定到当前请求；未绑定或身份字段不完整时一律阻断。
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Optional

from ..tools.framework import (
    DEFAULT_POLICIES,
    EnterpriseToolGate,
    ToolContext,
    ToolPolicy,
)
from .run_context import current_tool_context

logger = logging.getLogger(__name__)

_MIDDLEWARE_KIND = "tool_execution"

_gate: Optional[EnterpriseToolGate] = None
_installed = False


def get_gate() -> EnterpriseToolGate:
    global _gate
    if _gate is None:
        _gate = EnterpriseToolGate(audit_sink=_default_audit_sink)
    return _gate


def _default_audit_sink(event: dict) -> None:
    """默认审计落地；写入失败由门控按 fail-closed 处理。"""
    root = Path(os.environ.get("ROVEAGENT_HOME", Path.home() / ".roveagent"))
    path = root / "audit" / "tool_gate.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def _resolve_context() -> ToolContext:
    return current_tool_context() or ToolContext()


def _block_result(decision, tool_name: str) -> str:
    """以工具结果的形式把拒绝/待审批反馈给 Agent Loop（不执行工具）。"""
    return json.dumps({
        "error": "enterprise_gate_blocked",
        "tool": tool_name,
        "allowed": decision.allowed,
        "requires_approval": decision.requires_approval,
        "approval_policy": decision.approval_policy,
        "reason": decision.reason,
        "risk": decision.risk.name,
        "audit_event_id": decision.audit_event_id,
    }, ensure_ascii=False)


def enterprise_gate_middleware(**kwargs: Any) -> Any:
    """tool_execution 中间件：先过企业门控，再决定是否放行执行。"""
    tool_name = str(kwargs.get("tool_name") or "")
    args = kwargs.get("args") or {}
    next_call = kwargs["next_call"]

    ctx = _resolve_context()
    try:
        decision = get_gate().authorize(ctx, tool_name, args)
    except Exception:
        logger.exception("enterprise gate failed closed tool=%s", tool_name)
        return json.dumps({
            "error": "enterprise_gate_unavailable",
            "tool": tool_name,
            "allowed": False,
            "requires_approval": False,
            "reason": "enterprise gate or audit unavailable",
        }, ensure_ascii=False)
    if not decision.allowed:
        # 审批回放：RoveFrame 已批准过同租户同工具同参数的调用 → 放行
        if decision.requires_approval:
            from .approval_grants import consume_grant

            grant = consume_grant(
                ctx.tenant_id, ctx.business_id, tool_name, args,
                request_id=ctx.request_id,
            )
            if grant is not None:
                logger.info(
                    "enterprise gate approved_replay tool=%s tenant=%s approver=%s",
                    tool_name, ctx.tenant_id, grant.get("approver", ""),
                )
                get_gate()._audit_sink and get_gate()._audit_sink({
                    "event_id": f"replay-{decision.audit_event_id}",
                    "ts": time.time(),
                    "tenant_id": ctx.tenant_id,
                    "business_id": ctx.business_id,
                    "user_id": ctx.user_id,
                    "agent_id": ctx.agent_id,
                    "role": ctx.role,
                    "request_id": ctx.request_id,
                    "task_id": ctx.task_id,
                    "tool": tool_name,
                    "risk": decision.risk.name,
                    "allowed": True,
                    "requires_approval": False,
                    "reason": f"approved_replay by {grant.get('approver', '')}",
                })
                return next_call(args)
            # 未批准：推送 requires_approval 事件到 RoveFrame 审批 UI
            try:
                from .approval_bridge import push_requires_approval, tool_call_event

                pushed = push_requires_approval(tool_call_event(
                    tenant_id=ctx.tenant_id,
                    business_id=ctx.business_id,
                    user_id=ctx.user_id,
                    agent_id=ctx.agent_id,
                    role=ctx.role,
                    permissions=sorted(ctx.permissions),
                    request_id=ctx.request_id,
                    task_id=ctx.task_id,
                    tool=tool_name,
                    args=args,
                    approval_policy=decision.approval_policy,
                    risk=decision.risk.name,
                    reason=decision.reason,
                    audit_event_id=decision.audit_event_id,
                ))
                if not pushed:
                    raise RuntimeError("approval bridge did not accept the frozen invocation")
            except Exception:
                logger.exception("approval bridge push raised")
                return json.dumps({
                    "error": "enterprise_gate_unavailable",
                    "tool": tool_name,
                    "allowed": False,
                    "requires_approval": True,
                    "reason": "approval record could not be persisted",
                    "audit_event_id": decision.audit_event_id,
                }, ensure_ascii=False)
        logger.info(
            "enterprise gate blocked tool=%s tenant=%s approval=%s reason=%s",
            tool_name, ctx.tenant_id, decision.requires_approval, decision.reason,
        )
        return _block_result(decision, tool_name)
    return next_call(args)


# P0-11：安全中间件标记 —— 执行链中本中间件异常时 fail-closed 终止链，
# 绝不跳过门控直执真实工具（见 clisupport.middleware._run_execution_chain）。
enterprise_gate_middleware.fail_closed = True


def install_enterprise_gate(
    *,
    policies: Optional[list[ToolPolicy]] = None,
    audit_sink: Optional[Callable[[dict], None]] = None,
) -> EnterpriseToolGate:
    """把企业门控装进工具执行中间件链。幂等。返回 gate 实例。"""
    global _gate, _installed
    _gate = EnterpriseToolGate(
        policies=policies,
        audit_sink=audit_sink or _default_audit_sink,
    )
    if not _installed:
        from ..clisupport.plugins import get_plugin_manager

        manager = get_plugin_manager()
        manager._middleware.setdefault(_MIDDLEWARE_KIND, []).append(
            enterprise_gate_middleware
        )
        _installed = True
        logger.info(
            "enterprise tool gate installed (%d base policies)",
            len(DEFAULT_POLICIES),
        )
    return _gate


def uninstall_enterprise_gate() -> None:
    """测试/热更新用：从中间件链移除门控。"""
    global _installed
    from ..clisupport.plugins import get_plugin_manager

    callbacks = get_plugin_manager()._middleware.get(_MIDDLEWARE_KIND, [])
    while enterprise_gate_middleware in callbacks:
        callbacks.remove(enterprise_gate_middleware)
    _installed = False
