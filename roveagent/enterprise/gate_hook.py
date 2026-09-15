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


def _plugin_policies() -> list:
    """Gate rows contributed by sandbox-loaded community plugins (R39 closure).

    Before Phase 8.1 these rows existed but nobody handed them to a gate, so a
    plugin tool call matched the catch-all row — which the policy table itself
    describes as "registered therefore allowed, without approval". Passing them
    through the constructor's documented ``policies`` argument is what makes the
    gate actually govern plugin tools; ``EnterpriseToolGate``'s own logic is
    untouched.

    Import failures yield no rows rather than an exception: a broken plugin
    module must not stop the gate from being constructed. Failing to ADD rows
    is safe here precisely because plugin tools are unreachable when their rows
    are missing only if they are not registered either — and registration and
    this publication happen together in ``register_plugin_tools``. A deployment
    that somehow got the tools without the rows is caught by the registration
    guard, which refuses to register a tool whose row would not be covered.
    """
    try:
        from ..api.plugin_tools import plugin_gate_policies

        return list(plugin_gate_policies())
    except Exception as exc:  # noqa: BLE001 — never block gate construction
        logger.debug("plugin gate policies unavailable: %s", exc)
        return []


def get_gate() -> EnterpriseToolGate:
    global _gate
    if _gate is None:
        _gate = EnterpriseToolGate(
            policies=_plugin_policies(),
            audit_sink=_default_audit_sink,
        )
    return _gate


def audit_root() -> Path:
    """审计根目录 —— 与内核数据根统一。

    Step 1.5 修正（缺陷 C）：此前用 ``ROVEAGENT_HOME``（默认 ``~/.roveagent``），
    而内核数据根用 ``ROVEAGENT_ROOT``（``api/app.py:138``）。两者不一致导致
    「按配置的 ROOT 找不到审计」。

    新的优先级：
      1. ``ROVEAGENT_ROOT``  —— 内核数据根的权威来源
      2. ``ROVEAGENT_HOME``  —— 旧变量，仅作兼容回落
      3. ``~/.roveagent``    —— 最终默认值
    """
    explicit_root = os.environ.get("ROVEAGENT_ROOT", "").strip()
    if explicit_root:
        return Path(explicit_root) / "audit"
    legacy_home = os.environ.get("ROVEAGENT_HOME", "").strip()
    if legacy_home:
        return Path(legacy_home) / "audit"
    return Path.home() / ".roveagent" / "audit"


def _default_audit_sink(event: dict) -> None:
    """默认审计落地；写入失败由门控按 fail-closed 处理。"""
    path = audit_root() / "tool_gate.jsonl"
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

    # 诊断开关（Phase 2b）：把门控实际收到的参数写到 stderr，用于定位
    # 「工具被放行但副作用没发生」类问题。默认关闭，零开销。
    # 用 sys.stderr 而不是 logger：uvicorn 的日志配置可能吞掉本模块的
    # logger.warning（实测 gate trace 为空），stderr 不受影响。
    if os.environ.get("ROVEAGENT_GATE_TRACE") == "1":
        try:
            import sys as _sys

            _sys.stderr.write(
                f"[gate-trace] tool={tool_name} args={json.dumps(args, default=str)[:600]}\n"
            )
            _sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass

    ctx = _resolve_context()

    # ------------------------------------------------------------------
    # Command Policy Layer（Phase 3.1 / R16）—— **在 gate 之前**做命令级判定。
    #
    # 为什么放在这里而不是 gate 内部：gate 的职责是「工具名 + 权限点」授权，
    # 命令语义不属于它的关注点（也不改它的核心逻辑）。本层是**前置**的
    # 更细粒度判定，两者是「与」关系：命令级通过之后仍要走 gate。
    #
    # 默认 `ROVEAGENT_COMMAND_POLICY` 未设 ⇒ 只分类 + 审计，不阻断 ——
    # 保持既有部署的放行结果不变（启用强制属于安全模型变更，需显式同意）。
    # ------------------------------------------------------------------
    if tool_name == "terminal":
        try:
            from ..api.command_policy import (
                classify_command,
                command_policy_enabled,
                extract_command,
            )

            _cmd = extract_command(args)
            if _cmd:
                _verdict = classify_command(_cmd)
                _enforced = command_policy_enabled()
                if _verdict.read_only:
                    logger.debug(
                        "command policy: READ tool=%s class=%s", tool_name,
                        _verdict.classification,
                    )
                else:
                    logger.warning(
                        "command policy: %s tool=%s agent=%s session=%s "
                        "class=%s reason=%s enforced=%s command=%s",
                        "BLOCKED" if _enforced else "NOTED",
                        tool_name, ctx.agent_id or "-", ctx.task_id or "-",
                        _verdict.classification, _verdict.reason, _enforced,
                        _cmd[:200],
                    )
                if _enforced and not _verdict.read_only:
                    return json.dumps({
                        "error": "command_policy_blocked",
                        "tool": tool_name,
                        "classification": _verdict.classification,
                        "reason": _verdict.reason,
                        "matched_rule": _verdict.matched_rule,
                        "detail": (
                            "This command is not read-only and command policy is "
                            "enforced (ROVEAGENT_COMMAND_POLICY=enforce). "
                            "Unset it to disable, or route the operation through "
                            "the approval flow."
                        ),
                    }, ensure_ascii=False)
        except Exception:  # noqa: BLE001 — 策略层异常绝不阻断既有链路
            logger.exception("command policy layer failed (continuing to gate)")

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
        logger.warning(
            # R14（Phase 2c）：安全拒绝从 info 提升到 warning，并补齐四元组
            # （tool / agent / reason / session）—— 否则「所有写操作都失败」
            # 这类严重故障在默认日志级别下没有任何可见线索（Phase 2b 的实际教训）。
            "enterprise gate BLOCKED tool=%s agent=%s role=%s session=%s "
            "approval=%s policy=%s reason=%s",
            tool_name, ctx.agent_id or "-", ctx.role or "-", ctx.task_id or "-",
            decision.requires_approval, decision.approval_policy, decision.reason,
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
    """把企业门控装进工具执行中间件链。幂等。返回 gate 实例。

    策略顺序：调用方策略在前（最具体的意图），插件工具策略随后，
    ``DEFAULT_POLICIES`` 垫底。三者都在 ``EnterpriseToolGate`` 内部前置，
    故都优先于内建行；插件行是按工具名的精确匹配，不会互相遮蔽。
    """
    global _gate, _installed
    _gate = EnterpriseToolGate(
        policies=list(policies or []) + _plugin_policies(),
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
