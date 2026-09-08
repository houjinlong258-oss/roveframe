"""租户上下文与隔离异常。"""

from __future__ import annotations

from dataclasses import dataclass


class TenantIsolationError(PermissionError):
    """跨租户访问被拦截。"""


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    industry: str
    business_name: str

    def assert_same(self, other_tenant_id: str) -> None:
        if other_tenant_id != self.tenant_id:
            raise TenantIsolationError(
                f"tenant {self.tenant_id} cannot access data of {other_tenant_id}"
            )
