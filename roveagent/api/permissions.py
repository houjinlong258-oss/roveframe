"""P0-11(c)：权限由服务端推导，客户端 JSON 只能裁剪不能放大。

与 RoveFrame TS 侧 ``src/lib/rbac.ts`` 的 ROLE_PERMISSIONS 保持同构；
角色允许集之外的一切请求权限一律丢弃（fail-closed 收缩）。
"""
from __future__ import annotations

from typing import Iterable

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "owner": frozenset({"*"}),
    "manager": frozenset({
        # TS 侧实体权限（与 src/lib/rbac.ts 同构）
        "orders:read", "orders:write",
        "products:read", "products:write",
        "customers:read", "customers:write",
        "reviews:read", "reviews:write",
        "reservations:read", "reservations:write",
        "channels:read", "channels:write",
        "marketing:read", "marketing:write",
        "emails:read", "emails:write",
        "knowledge:read", "knowledge:write",
        "staff:read", "staff:write",
        "inventory:read",
        "settings:read",
        "agent_actions:read",
        "notifications:read", "notifications:write",
        "agent:use",
        "approvals:decide", "approvals:read", "audit:read",
        "coding:propose",
        "customization:write",
        "healing:write",
        # Python 工具门控命名空间（DEFAULT_POLICIES 权限点）：
        # 经理可请求但受审批策略约束（send_*→经理审批、refund/支付→业主审批）
        "analytics:read", "inventory:read", "files:read", "files:write",
        "comms:draft", "comms:send", "payments:read",
    }),
    "staff": frozenset({"orders:read", "customers:read", "agent:use", "healing:write"}),
}


def derive_permissions(
    role: str,
    requested: Iterable[str],
    employee_permissions: Iterable[str] = (),
) -> frozenset[str]:
    """服务端推导工具上下文权限集。

    - 未知角色 → 空集（fail-closed）；
    - owner → 请求集合全量（服务端约定 owner 拥有 '*'）；
    - 其余角色 → 请求权限 ∩ 角色允许集（客户端只能裁剪，不能放大）；
    - 员工档案能力（服务端静态配置）作为额外固有权限并入。
    """
    requested_set = frozenset(str(p) for p in requested)
    allowed = ROLE_PERMISSIONS.get(role)
    if allowed is None:
        return frozenset()
    if "*" in allowed:
        granted = requested_set
    else:
        granted = requested_set & allowed
    return granted | frozenset(str(p) for p in employee_permissions)
