"""权限引擎：所有关键操作必须 Human Approval（产品级要求 #5）。"""

from .engine import PermissionEngine, PermissionDecision, ApprovalRequired  # noqa: F401
