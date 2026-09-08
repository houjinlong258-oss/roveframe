"""RoveAgentKernel —— 企业级 AI 运行时主件。

将各企业层组装为单一内核，架在 RoveAgent Agent Loop 之上：
- 一句话开店：provision_business(...) → 本地 Agent 租户元数据 + 行业包 + AI 团队
- 每日简报：CEO Agent 经 RoveFrame Business Adapter 取真实数据生成日报
- 异常巡检：detect → 审计 → （需审批的动作进入批准队列）
- 自愈闭环 / 一键部署：分别委托 SelfHealingEngine / RoveAgentInstaller

所有动作：权限引擎门控 + 审计留痕。
"""

from __future__ import annotations

from pathlib import Path
from collections.abc import Callable
from typing import Any, Optional

from .agents.team import build_default_team
from .business.anomalies import Anomaly, detect_anomalies
from .business.data_layer import BusinessDataLayer
from .business.metrics import DailyMetrics, compute_daily_metrics
from .connectors import CONNECTORS
from .connectors.base import Connector, SyncResult
from .deployment.installer import DeployPlan, RoveAgentInstaller
from .enterprise.audit import AuditEvent, AuditLog
from .enterprise.registry import AgentRegistry
from .permissions.engine import PermissionEngine
from .repair.healing import SelfHealingEngine
from .skills.packs import IndustryPack, load_pack
from .tenant.manager import Tenant, TenantManager


class RoveAgentKernel:
    def __init__(self, root: Path, repo_path: Optional[Path] = None,
                 install_gate: bool = True,
                 business_adapter_factory: Optional[
                     Callable[[str, str], BusinessDataLayer]
                 ] = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.tenants = TenantManager(self.root)
        self.permissions = PermissionEngine()
        self.registry: AgentRegistry = build_default_team()
        self.installer = RoveAgentInstaller(self.root / "installer")
        self.healing = SelfHealingEngine(repo_path or self.root, self.root / "healing",
                                         self.permissions)
        self._layers: dict[tuple[str, str], BusinessDataLayer] = {}
        self._business_adapter_factory = business_adapter_factory or (
            lambda tenant_id, business_id: BusinessDataLayer(tenant_id, business_id)
        )
        # 企业工具门控：挂入 Agent Loop 的工具执行中间件链（幂等）。
        # 审计落到企业 AuditLog 目录之外的全局 JSONL；宿主可用
        # enterprise.gate_hook.install_enterprise_gate(audit_sink=...) 覆盖。
        self.gate = None
        if install_gate:
            from .enterprise.gate_hook import install_enterprise_gate
            self.gate = install_enterprise_gate()

    def close(self) -> None:
        """关闭所有打开的数据层连接（Windows 下释放文件锁）。"""
        for dl in self._layers.values():
            dl.close()
        self._layers.clear()

    def __enter__(self) -> "RoveAgentKernel":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---------- 基础设施 ----------

    def audit(self, tenant_id: str) -> AuditLog:
        return AuditLog(self.tenants.audit_path(tenant_id))

    def data_layer(self, tenant_id: str, business_id: str) -> BusinessDataLayer:
        if not tenant_id or not business_id:
            raise ValueError("tenant_id and business_id are required")
        scope = (tenant_id, business_id)
        if scope not in self._layers:
            self._layers[scope] = self._business_adapter_factory(tenant_id, business_id)
        return self._layers[scope]

    def _log(self, tenant_id: str, agent: str, action: str,
             detail: str, result: str = "ok") -> None:
        self.audit(tenant_id).record(AuditEvent(tenant_id, agent, action, detail, result))

    # ---------- 一句话开店（验收场景核心链路） ----------

    def provision_business(self, business_name: str, industry: str = "restaurant",
                           region: str = "", connectors: Optional[list[str]] = None,
                           *, business_id: str
                           ) -> dict[str, Any]:
        """"创建一家纽约餐厅AI管理系统" → 自动创建租户 + 行业包 + AI 团队。"""
        tenant = self.tenants.create(business_name, industry, region)
        pack = load_pack(industry)
        team = self.registry.for_industry(industry)

        sync_results: list[SyncResult] = []
        for name in (connectors or []):
            connector = self.connect(tenant.tenant_id, business_id, name, sandbox=True)
            sync_results.append(connector.sync_all())

        self._log(tenant.tenant_id, "kernel", "provision_business",
                  f"{business_name} ({industry}) — team: {[a.key for a in team]}", "ok")
        return {
            "tenant": tenant,
            "pack": pack,
            "team": team,
            "sync_results": sync_results,
        }

    # ---------- Connector 管理 ----------

    def connect(self, tenant_id: str, business_id: str, provider: str, *,
                access_token: Optional[str] = None,
                webhook_secret: Optional[str] = None,
                sandbox: bool = False, extra: Optional[dict] = None) -> Connector:
        cls = CONNECTORS.get(provider)
        if not cls:
            raise ValueError(f"unsupported connector: {provider} (have: {list(CONNECTORS)})")
        self.permissions.require("kernel", "connect_pos", f"connect {provider}") \
            if not sandbox else None
        connector = cls(self.data_layer(tenant_id, business_id), access_token=access_token,
                        webhook_secret=webhook_secret, sandbox=sandbox, extra=extra)
        self._log(tenant_id, "kernel", "connect", f"{provider} sandbox={sandbox}", "ok")
        return connector

    # ---------- Restaurant AI COO ----------

    def daily_report(self, tenant_id: str, business_id: str,
                     day_ts: Optional[float] = None) -> dict[str, Any]:
        """CEO Agent 每日经营报告：Revenue/Orders/Customers/Best Sellers/Problems。"""
        dl = self.data_layer(tenant_id, business_id)
        metrics = compute_daily_metrics(dl, day_ts)
        anomalies = detect_anomalies(dl, day_ts)
        report = {
            "date": metrics.date,
            "revenue": metrics.revenue,
            "revenue_delta_pct": metrics.revenue_delta_pct,
            "orders": metrics.orders,
            "customers": metrics.customers,
            "best_sellers": metrics.best_sellers,
            "problems": [{"kind": a.kind, "severity": a.severity, "message": a.message}
                         for a in anomalies],
            "recommendations": self._recommend(anomalies),
        }
        self._log(tenant_id, "ceo", "daily_report",
                  f"{metrics.date} revenue={metrics.revenue} orders={metrics.orders} "
                  f"problems={len(anomalies)}", "ok")
        return report

    def _recommend(self, anomalies: list[Anomaly]) -> list[str]:
        recs = []
        for a in anomalies:
            if a.kind == "sales_drop":
                recs.append("Marketing Campaign: launch a limited-time offer to recover traffic")
            elif a.kind == "inventory_risk":
                recs.append("Operation Improvement: reorder low-stock items before dinner peak")
            elif a.kind == "customer_churn":
                recs.append("Customer Retention: send personalized win-back emails (requires approval)")
        return recs

    # ---------- 审批驱动执行 ----------

    def execute_marketing_campaign(self, tenant_id: str, campaign: str) -> str:
        """营销活动发送必须人工批准。"""
        self.permissions.require("marketing", "send_campaign", campaign)
        self._log(tenant_id, "marketing", "send_campaign", campaign, "ok")
        return "sent"

    def approve(self, request_id: str) -> None:
        self.permissions.approve(request_id)

    def pending_approvals(self):
        return self.permissions.pending()
