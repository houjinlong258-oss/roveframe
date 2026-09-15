"""SSE 事件构造 —— RoveAgent Runtime → RoveFrame 前端的 wire format（Step 2）。

契约来源
--------
**唯一权威是 TS 侧** ``src/lib/agent/stream-events.ts`` 的 ``AgentSseEvent`` 联合类型。
本模块只负责把 Python 侧的回调负载翻译成那个类型。

为什么不在 Python 侧定义新事件名
--------------------------------
前端 ``src/hooks/use-sse.ts`` 的 ``KNOWN_EVENT_TYPES`` 是**白名单**，
未知 ``type`` 会被**静默丢弃**。因此：

- ``token`` 这种新名字传不过去 → 必须用既有的 ``delta``
- ``tool_call`` / ``tool_result`` → 必须用既有的 ``status`` + ``phase``
- ``completed`` → 必须用既有的 ``done``

已有的 Python 事件类型（``roveagent/gateway/stream_events.py``）属于
**进程内**契约，且其包 ``__init__.py`` 会拉入 config/session/delivery →
shutdown_watchdog / ``core.secret_scope`` / ``clisupport.config`` /
``whatsapp_identity``。**本模块刻意不 import 它**，保持 ``api`` 层轻量。

事件序列（正常一轮）
--------------------
    runtime_status{mode}         ← 本次请求由哪个 Runtime 执行
    status{phase: thinking|analyzing}
    delta{text} × N              ← 逐片正文
    status{phase: calling_tool, tool}
    status{phase: tool_done, tool}
    notice{level, message, code}  ← 工具被门控拒绝/待审批时
    delta{text} × N
    done{provider, model}
"""
from __future__ import annotations

import json
from typing import Any, Iterable, Mapping


def _event(payload: Mapping[str, Any]) -> str:
    """把事件 dict 序列化成一行 SSE。"""
    return f"data: {json.dumps(dict(payload), ensure_ascii=False)}\n\n"


def sse_done_sentinel() -> str:
    """流结束哨兵。与 ``src/hooks/use-sse.ts`` 的 ``[DONE]`` 处理对齐。"""
    return "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# 事件构造器 —— 每个都对应 stream-events.ts 中的一个 interface
# ---------------------------------------------------------------------------

def ev_runtime_status(mode: str, detail: str = "") -> str:
    """Runtime 状态。对应新增的 ``AgentRuntimeStatusEvent``。

    ``mode``: ``roveagent`` | ``fallback`` | ``unavailable``
    """
    return _event({"type": "runtime_status", "mode": mode, "detail": detail})


def ev_status(phase: str, tool: str | None = None, label: str | None = None) -> str:
    """阶段状态。``phase`` 必须落在 ``AgentStatusPhase`` 取值内。"""
    payload: dict[str, Any] = {"type": "status", "phase": phase}
    if tool:
        payload["tool"] = tool
    if label:
        payload["label"] = label
    return _event(payload)


def ev_delta(text: str) -> str:
    """正文增量。字段名必须是 ``text``（``use-sse.ts`` 读 ``parsed.text``）。"""
    return _event({"type": "delta", "text": text})


def ev_notice(level: str, message: str, code: str = "",
              technical: str = "") -> str:
    """提示（含门控拒绝/待审批）。``level``: ``info`` | ``warning``。"""
    payload: dict[str, Any] = {"type": "notice", "level": level, "message": message}
    if code:
        payload["code"] = code
    if technical:
        payload["technical"] = technical
    return _event(payload)


def ev_error(message: str, code: str = "") -> str:
    """错误。``use-sse.ts`` 见到 ``error`` 字段即视为错误事件。"""
    payload: dict[str, Any] = {"type": "error", "error": message}
    if code:
        payload["code"] = code
    return _event(payload)


def ev_done(provider: str = "", model: str = "") -> str:
    """一轮结束。"""
    payload: dict[str, Any] = {"type": "done"}
    if provider:
        payload["provider"] = provider
    if model:
        payload["model"] = model
    return _event(payload)


# ---------------------------------------------------------------------------
# 回调 → 事件 的翻译
# ---------------------------------------------------------------------------

#: `tool_progress_callback` 的 kind → 前端 status phase
_TOOL_PROGRESS_PHASE = {
    "tool.started": "calling_tool",
    "tool.completed": "tool_done",
}


def tool_progress_to_phase(kind: str) -> str | None:
    """把 ``tool_progress_callback(kind, ...)`` 的 kind 映射为 phase。

    实测 kind 取值：``tool.started`` / ``tool.completed``（另有
    ``_thinking`` / ``reasoning.available`` 等非工具事件，返回 None 表示忽略）。
    """
    return _TOOL_PROGRESS_PHASE.get(kind)


def gate_denied_notice(result: Any) -> str | None:
    """工具结果若是门控拒绝/待审批的 JSON，翻成一条 notice。

    ``enterprise/gate_hook.py:_block_result`` 在工具被拦时不执行工具，
    而是把 JSON 当工具结果返回，形如：

        {"error": "enterprise_gate_blocked", "tool": "...",
         "requires_approval": true, "approval_policy": "manager", "reason": "..."}

    这里把它变成用户能看懂的一条提示。非门控结果返回 None。
    """
    if not isinstance(result, str) or "enterprise_gate" not in result:
        return None
    try:
        payload = json.loads(result)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("error") not in ("enterprise_gate_blocked",
                                    "enterprise_gate_unavailable"):
        return None

    tool = str(payload.get("tool") or "tool")
    reason = str(payload.get("reason") or "")
    if payload.get("requires_approval"):
        message = f"{tool} 需要审批后才能执行"
        level = "info"
        code = "tool_requires_approval"
    else:
        message = f"{tool} 被企业门控拒绝"
        level = "warning"
        code = "tool_blocked"
    return ev_notice(level, message, code=code, technical=reason)


def approval_events_from_gate_audit(rows: Iterable[Mapping[str, Any]]) -> list[str]:
    """从门控审计行里挑出「待审批」的记录，翻成 notice 事件。

    本轮 turn 内新建的审批单由 TS 侧 ``/api/agent/chat`` 的既有逻辑负责
    渲染成卡片；SSE 这里只做**期间提示**，避免一条流里出现两种审批表示。
    """
    out: list[str] = []
    for row in rows:
        if not row.get("requires_approval"):
            continue
        tool = str(row.get("tool") or "tool")
        policy = str(row.get("approval_policy") or "")
        out.append(ev_notice(
            "info",
            f"{tool} 正在等待审批",
            code="approval_required",
            technical=f"approval_policy={policy}",
        ))
    return out


def events_for_callback(payload: Mapping[str, Any]) -> list[str]:
    """把 ``ServiceContext.stream_agent_chat`` 的回调负载翻成 0..n 条 SSE 行。

    ``payload`` 的 ``kind`` 由 ``api/app.py`` 的 ``_build_agent`` 决定：

    - ``delta``：``stream_delta_callback(text)`` → ``delta{text}``
    - ``tool``：``tool_progress_callback(kind, name, a, b, **kw)``
      → ``status{calling_tool|tool_done}``；若结果是被门控拦下的 JSON，
      额外补一条 ``notice``
    - ``status``：``status_callback(*args)`` → ``status{analyzing, label}``

    **无对应前端契约的回调一律返回空列表**（不猜、不造事件名）——
    前端 ``use-sse.ts`` 的白名单会丢弃未知类型。
    """
    kind = payload.get("kind")

    if kind == "delta":
        text = payload.get("text")
        return [ev_delta(text)] if isinstance(text, str) and text else []

    if kind == "tool":
        phase = tool_progress_to_phase(str(payload.get("event") or ""))
        if phase is None:
            return []
        out = [ev_status(phase, tool=str(payload.get("tool") or ""))]
        notice = gate_denied_notice(payload.get("result"))
        if notice:
            out.append(notice)
        return out

    if kind == "status":
        args = payload.get("args") or []
        # status_callback 的签名是 (kind, message)；只把第一条作为 label
        return [ev_status("analyzing", label=str(args[0]))] if args else []

    return []
