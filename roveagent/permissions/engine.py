"""PermissionEngine：操作分级与人工批准门控。

三级：
- auto        只读分析、报告生成 —— 直接执行
- approval    营销发送、退款、价格修改、生产部署 —— 必须人工批准
- forbidden   删除租户数据、关闭审计 —— 永远拒绝
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional


class ApprovalRequired(PermissionError):
    def __init__(self, request_id: str, action: str):
        super().__init__(f"action '{action}' requires human approval (request {request_id})")
        self.request_id = request_id
        self.action = action


AUTO_ACTIONS = {
    "read_metrics", "daily_report", "anomaly_scan", "draft_content",
    "draft_reply", "analyze_reviews", "sandbox_test", "diagnose_error",
}
APPROVAL_ACTIONS = {
    "send_campaign", "send_email", "refund", "change_price",
    "deploy_production", "apply_patch", "rollback", "connect_pos",
}
FORBIDDEN_ACTIONS = {"delete_tenant_data", "disable_audit", "exfiltrate_credentials"}


@dataclass
class ApprovalRequest:
    request_id: str
    action: str
    agent: str
    reason: str
    created_at: float = field(default_factory=time.time)
    status: str = "pending"  # pending | approved | rejected


@dataclass
class PermissionDecision:
    allowed: bool
    level: str  # auto | approval | forbidden
    request: Optional[ApprovalRequest] = None


class PermissionEngine:
    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}
        self._hooks: list[Callable[[ApprovalRequest], None]] = []

    def on_request(self, hook: Callable[[ApprovalRequest], None]) -> None:
        """审批请求通知钩子（推送老板手机/PWA）。"""
        self._hooks.append(hook)

    def check(self, agent: str, action: str, reason: str = "") -> PermissionDecision:
        if action in FORBIDDEN_ACTIONS:
            return PermissionDecision(allowed=False, level="forbidden")
        if action in AUTO_ACTIONS:
            return PermissionDecision(allowed=True, level="auto")
        # 同一 agent+action+reason 已有批准记录 → 幂等放行（不重复建审批单）
        for req in self._requests.values():
            if (req.agent, req.action, req.reason) == (agent, action, reason):
                if req.status == "approved":
                    return PermissionDecision(allowed=True, level="approval", request=req)
                return PermissionDecision(allowed=False, level="approval", request=req)
        reason = reason or ("unclassified action" if action not in APPROVAL_ACTIONS else "")
        req = ApprovalRequest(uuid.uuid4().hex[:12], action, agent, reason)
        self._requests[req.request_id] = req
        for h in self._hooks:
            h(req)
        return PermissionDecision(allowed=False, level="approval", request=req)

    def require(self, agent: str, action: str, reason: str = "") -> None:
        d = self.check(agent, action, reason)
        if d.level == "forbidden":
            raise PermissionError(f"action '{action}' is forbidden")
        if not d.allowed:
            raise ApprovalRequired(d.request.request_id, action)  # type: ignore[union-attr]

    def approve(self, request_id: str) -> ApprovalRequest:
        req = self._requests[request_id]
        req.status = "approved"
        return req

    def reject(self, request_id: str) -> ApprovalRequest:
        req = self._requests[request_id]
        req.status = "rejected"
        return req

    def is_approved(self, request_id: str) -> bool:
        req = self._requests.get(request_id)
        return bool(req and req.status == "approved")

    def pending(self) -> list[ApprovalRequest]:
        return [r for r in self._requests.values() if r.status == "pending"]
