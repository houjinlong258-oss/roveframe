"""异常检测：Sales Drop / Negative Reviews / Inventory Risk / Customer Churn。"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .data_layer import BusinessDataLayer
from .metrics import compute_daily_metrics


@dataclass
class Anomaly:
    kind: str  # sales_drop | negative_reviews | inventory_risk | customer_churn
    severity: str  # info | warning | critical
    message: str
    evidence: dict


def detect_anomalies(dl: BusinessDataLayer, now: float | None = None) -> list[Anomaly]:
    ts = now or time.time()
    out: list[Anomaly] = []

    # 1. 销售下滑：今日营收较昨日下降超过 25%
    today = compute_daily_metrics(dl, ts)
    if today.prev_revenue > 0 and today.revenue_delta_pct <= -25:
        out.append(Anomaly(
            kind="sales_drop", severity="critical",
            message=f"Revenue dropped {abs(today.revenue_delta_pct)}% vs yesterday",
            evidence={"today": today.revenue, "yesterday": today.prev_revenue},
        ))

    # 2. 库存风险：低于阈值的物料
    low = dl.low_stock()
    if low:
        out.append(Anomaly(
            kind="inventory_risk",
            severity="warning" if len(low) < 3 else "critical",
            message=f"{len(low)} inventory items at or below threshold",
            evidence={"items": [{"name": i["name"], "quantity": i["quantity"]} for i in low]},
        ))

    # 3. 客户流失：超过 21 天未到店的活跃客户
    churn_days = 21
    cutoff = ts - churn_days * 86400
    customers = [c for c in dl.customers()
                 if c.get("last_visit") and c["last_visit"] < cutoff and c.get("visit_count", 0) >= 2]
    if customers:
        out.append(Anomaly(
            kind="customer_churn",
            severity="warning",
            message=f"{len(customers)} repeat customers inactive for {churn_days}+ days",
            evidence={"count": len(customers)},
        ))

    return out
