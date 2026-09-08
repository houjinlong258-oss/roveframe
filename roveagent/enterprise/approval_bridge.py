"""requires_approval 事件推送桥：RoveAgent 门控 → RoveFrame 审批 UI。

当 EnterpriseToolGate 判定某次工具调用需要审批（或目标引擎产出
awaiting_approval 的任务步骤）时，本模块把结构化事件推送到 RoveFrame：

    POST {ROVEFRAME_INTERNAL_API_URL}/api/agent/approvals/events
    Header: X-RoveAgent-Key（与 TS 侧共享密钥校验一致）

配置::

    ROVEFRAME_INTERNAL_API_URL   RoveFrame 服务地址（默认 http://127.0.0.1:5000）
    ROVEAGENT_API_KEY        共享密钥（复用服务间既有密钥）

契约：审批记录必须成功持久化，否则高风险调用以可见错误失败关闭。
审批结果经 RoveFrame 的 HMAC 签名回调恢复原始冻结调用；不等待模型重试，
也不允许模型重新生成参数。
"""
from __future__ import annotations

import json
import hashlib
import hmac
import logging
import os
import time
import urllib.request
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

_DEFAULT_CALLBACK_URL = "http://127.0.0.1:5000"
_TIMEOUT_S = 5.0

# 进程内统计（可观测性：推送失败不应无声）
stats = {"pushed": 0, "failed": 0, "disabled": 0}


def _callback_url() -> str:
    return os.environ.get("ROVEFRAME_INTERNAL_API_URL", _DEFAULT_CALLBACK_URL).rstrip("/")


def push_requires_approval(event: Mapping[str, Any]) -> bool:
    """把 requires_approval 事件推送给 RoveFrame 审批中心。

    event 至少包含: kind（tool_call|task_step）、tenant_id、business_id、title、payload。
    返回 True 表示 RoveFrame 已受理；未配置或网络失败直接抛错，调用方
    必须向 Agent Loop 返回 enterprise_gate_unavailable，禁止静默丢单。
    """
    key = os.environ.get("ROVEAGENT_API_KEY", "")
    if not key:
        stats["disabled"] += 1
        raise RuntimeError("approval bridge unavailable: signing key is not configured")

    body = json.dumps(dict(event), ensure_ascii=False).encode("utf-8")
    timestamp = str(int(time.time()))
    signing_key = os.environ.get("ROVEAGENT_APPROVAL_SECRET", key)
    signature = hmac.new(
        signing_key.encode("utf-8"), timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    req = urllib.request.Request(
        f"{_callback_url()}/api/agent/approvals/events",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-RoveAgent-Key": key,
            "X-RoveAgent-Timestamp": timestamp,
            "X-RoveAgent-Signature": signature,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            ok = 200 <= resp.status < 300
    except Exception as e:
        stats["failed"] += 1
        raise RuntimeError(f"approval bridge push failed: {e}") from e
    if ok:
        stats["pushed"] += 1
    else:
        stats["failed"] += 1
        raise RuntimeError(f"approval bridge push rejected: HTTP {resp.status}")
    return True


def tool_call_event(
    *,
    tenant_id: str,
    business_id: str,
    user_id: str,
    agent_id: str,
    role: str,
    permissions: list[str],
    request_id: str,
    task_id: str,
    tool: str,
    args: Mapping[str, Any],
    approval_policy: str,
    risk: str,
    reason: str,
    audit_event_id: str,
) -> dict[str, Any]:
    """构造工具调用审批事件（推送与测试共用的标准形状）。"""
    return {
        "kind": "tool_call",
        "tenant_id": tenant_id,
        "business_id": business_id,
        "title": f"AI 员工请求执行 {tool}",
        "description": f"工具 {tool} 命中审批策略 {approval_policy}（风险 {risk}）：{reason}",
        "payload": {
            "source": "roveagent",
            "tool": tool,
            "args": dict(args),
            "agent_id": agent_id,
            "role": role,
            "permissions": list(permissions),
            "user_id": user_id,
            "request_id": request_id,
            "task_id": task_id,
            "approval_policy": approval_policy,
            "risk": risk.lower(),
            "reason": reason,
            "audit_event_id": audit_event_id,
            "invocation_id": audit_event_id,
        },
    }


def task_step_event(
    *,
    tenant_id: str,
    business_id: str,
    task_id: str,
    objective: str,
    steps: list[Mapping[str, Any]],
    requester: str = "user",
) -> dict[str, Any]:
    """构造目标引擎任务审批事件（整单审批：批准后执行全部待审步骤）。"""
    titles = [str(s.get("title", "")) for s in steps]
    return {
        "kind": "task_step",
        "tenant_id": tenant_id,
        "business_id": business_id,
        "title": f"经营任务待审批：{objective[:60]}",
        "description": "待审批步骤：" + "；".join(titles[:5]),
        "payload": {
            "source": "roveagent",
            "user_id": requester,
            "agent_id": "goal-engine",
            "task_id": task_id,
            "invocation_id": f"task:{task_id}",
            "approval_policy": "manager",
            "risk": "high",
            "objective": objective,
            "steps": [dict(s) for s in steps],
        },
    }
