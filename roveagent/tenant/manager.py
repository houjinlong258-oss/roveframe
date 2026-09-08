"""TenantManager：创建企业环境（对应愿景第 2 步"创建企业环境"）。

每个租户获得：
- 独立目录 <root>/tenants/<tenant_id>/
- 独立 Agent state 目录（不得保存订单、客户、库存、评论或支付事实）
- 独立审计日志 audit.jsonl
- 租户元数据 tenant.json
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

from .context import TenantContext, TenantIsolationError


@dataclass
class Tenant:
    tenant_id: str
    business_name: str
    industry: str  # restaurant | hotel | retail | clinic ...
    region: str = ""
    created_at: float = 0.0
    status: str = "active"  # active | suspended

    def context(self) -> TenantContext:
        return TenantContext(self.tenant_id, self.industry, self.business_name)


class TenantManager:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.tenants_dir = self.root / "tenants"
        self.tenants_dir.mkdir(parents=True, exist_ok=True)

    def _dir(self, tenant_id: str) -> Path:
        return self.tenants_dir / tenant_id

    def create(self, business_name: str, industry: str = "restaurant", region: str = "") -> Tenant:
        tenant = Tenant(
            tenant_id=f"t_{uuid.uuid4().hex[:10]}",
            business_name=business_name,
            industry=industry,
            region=region,
            created_at=time.time(),
        )
        d = self._dir(tenant.tenant_id)
        (d / "data").mkdir(parents=True, exist_ok=False)
        (d / "audit").mkdir(exist_ok=True)
        (d / "deployments").mkdir(exist_ok=True)
        (d / "tenant.json").write_text(
            json.dumps(asdict(tenant), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return tenant

    def get(self, tenant_id: str) -> Optional[Tenant]:
        meta = self._dir(tenant_id) / "tenant.json"
        if not meta.exists():
            return None
        return Tenant(**json.loads(meta.read_text(encoding="utf-8")))

    def list(self) -> list[Tenant]:
        out = []
        for d in sorted(self.tenants_dir.iterdir()):
            t = self.get(d.name)
            if t:
                out.append(t)
        return out

    def data_dir(self, tenant_id: str) -> Path:
        if not (self._dir(tenant_id) / "tenant.json").exists():
            raise TenantIsolationError(f"unknown tenant: {tenant_id}")
        return self._dir(tenant_id) / "data"

    def audit_path(self, tenant_id: str) -> Path:
        if not (self._dir(tenant_id) / "tenant.json").exists():
            raise TenantIsolationError(f"unknown tenant: {tenant_id}")
        return self._dir(tenant_id) / "audit" / "audit.jsonl"
