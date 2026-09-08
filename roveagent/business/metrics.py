"""每日经营指标：Revenue / Orders / Customers / Best Sellers（Restaurant AI COO 日报底座）。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .data_layer import BusinessDataLayer


@dataclass
class DailyMetrics:
    date: str
    revenue: float
    orders: int
    customers: int
    best_sellers: list[tuple[str, int]] = field(default_factory=list)
    prev_revenue: float = 0.0

    @property
    def revenue_delta_pct(self) -> float:
        if self.prev_revenue <= 0:
            return 0.0
        return round((self.revenue - self.prev_revenue) / self.prev_revenue * 100, 1)


def _day_start(ts: float) -> float:
    return time.mktime(time.localtime(ts)[:3] + (0, 0, 0, 0, 0, -1))


def compute_daily_metrics(dl: BusinessDataLayer, day_ts: float | None = None) -> DailyMetrics:
    ts = day_ts or time.time()
    start = _day_start(ts)
    end = start + 86400
    orders = dl.orders_between(start, end)
    prev = dl.orders_between(start - 86400, start)

    dish: dict[str, int] = {}
    customers: set[str] = set()
    for o in orders:
        for item in o["items"]:
            dish[item.get("name", "?")] = dish.get(item.get("name", "?"), 0) + int(item.get("qty", 1))
        if o.get("customer_id"):
            customers.add(o["customer_id"])

    return DailyMetrics(
        date=time.strftime("%Y-%m-%d", time.localtime(ts)),
        revenue=round(sum(o["total"] for o in orders), 2),
        orders=len(orders),
        customers=len(customers),
        best_sellers=sorted(dish.items(), key=lambda kv: -kv[1])[:5],
        prev_revenue=round(sum(o["total"] for o in prev), 2),
    )
