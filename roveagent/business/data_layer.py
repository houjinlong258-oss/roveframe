"""RoveFrame business-data adapter for RoveAgent Core.

RoveFrame's Supabase database is the only source of operating facts.  This
module deliberately owns no orders, customers, inventory, reviews, or payment
tables.  Every read and connector upsert crosses the authenticated RoveFrame
internal API with an explicit tenant and business scope.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Optional


class BusinessDataError(RuntimeError):
    """Raised when the canonical RoveFrame business-data service is unavailable."""


Transport = Callable[[str, Mapping[str, Any]], Mapping[str, Any]]


class BusinessDataLayer:
    """Tenant-and-business-bound adapter to RoveFrame's canonical data service."""

    def __init__(
        self,
        tenant_id: str,
        business_id: str,
        *,
        base_url: str = "",
        api_key: str = "",
        transport: Optional[Transport] = None,
    ) -> None:
        if not tenant_id or not business_id:
            raise ValueError("tenant_id and business_id are required")
        self.tenant_id = tenant_id
        self.business_id = business_id
        self.base_url = (base_url or os.environ.get("ROVEFRAME_INTERNAL_API_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("ROVEAGENT_API_KEY", "")
        self._transport = transport
        if self._transport is None and (not self.base_url or not self.api_key):
            raise BusinessDataError(
                "RoveFrame business adapter is not configured: set "
                "ROVEFRAME_INTERNAL_API_URL and ROVEAGENT_API_KEY"
            )

    def close(self) -> None:
        """Compatibility no-op; the HTTP adapter holds no database connection."""

    def _call(self, operation: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        payload = {
            "tenant_id": self.tenant_id,
            "business_id": self.business_id,
            "operation": operation,
            "params": dict(params or {}),
        }
        if self._transport is not None:
            response = self._transport(operation, payload)
        else:
            request = urllib.request.Request(
                f"{self.base_url}/api/internal/agent/business-data",
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-RoveAgent-Key": self.api_key,
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=20) as raw:
                    decoded = json.loads(raw.read().decode("utf-8"))
            except (urllib.error.URLError, TimeoutError, ValueError) as error:
                raise BusinessDataError(
                    f"RoveFrame business-data request failed for {operation}"
                ) from error
            if not isinstance(decoded, Mapping):
                raise BusinessDataError("RoveFrame business-data response must be an object")
            response = decoded

        if not isinstance(response, Mapping) or response.get("ok") is not True:
            raise BusinessDataError(f"RoveFrame business-data operation failed: {operation}")
        scope = response.get("scope")
        if not isinstance(scope, Mapping) or (
            scope.get("tenant_id") != self.tenant_id
            or scope.get("business_id") != self.business_id
        ):
            raise BusinessDataError("RoveFrame business-data scope mismatch")
        return response.get("data")

    # Canonical reads -------------------------------------------------
    def read_sales(self, period: str = "week") -> dict[str, Any]:
        data = self._call("read_sales", {"period": period})
        return dict(data) if isinstance(data, Mapping) else {}

    def read_orders(self, *, start: Optional[float] = None,
                    end: Optional[float] = None, limit: int = 100) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        data = self._call("read_orders", params)
        rows = [dict(row) for row in data] if isinstance(data, list) else []
        for row in rows:
            row["total"] = float(row.get("total") or 0)
        return rows

    def read_customers(self, limit: int = 100) -> list[dict[str, Any]]:
        data = self._call("read_customers", {"limit": limit})
        rows = [dict(row) for row in data] if isinstance(data, list) else []
        for row in rows:
            row["visit_count"] = int(row.get("visit_count") or 0)
            row["last_visit"] = self._epoch(row.get("last_visit_at"))
        return rows

    def read_products(self, active_only: bool = True, limit: int = 100) -> list[dict[str, Any]]:
        data = self._call("read_products", {"active_only": active_only, "limit": limit})
        rows = [dict(row) for row in data] if isinstance(data, list) else []
        for row in rows:
            row["price"] = float(row.get("price") or 0)
            row["cost"] = float(row.get("cost") or 0)
        return rows

    def read_inventory(self, low_only: bool = False, limit: int = 100) -> list[dict[str, Any]]:
        data = self._call("read_inventory", {"low_only": low_only, "limit": limit})
        rows = [dict(row) for row in data] if isinstance(data, list) else []
        for row in rows:
            row["quantity"] = float(row.get("current_stock") or 0)
            row["low_threshold"] = float(row.get("safety_stock") or 0)
        return rows

    def read_reviews(self, limit: int = 50) -> list[dict[str, Any]]:
        data = self._call("read_reviews", {"limit": limit})
        return [dict(row) for row in data] if isinstance(data, list) else []

    def read_payments(self, limit: int = 50) -> list[dict[str, Any]]:
        data = self._call("read_payments", {"limit": limit})
        rows = [dict(row) for row in data] if isinstance(data, list) else []
        for row in rows:
            row["amount"] = float(row.get("amount") or 0)
        return rows

    def read_business_profile(self) -> dict[str, Any]:
        data = self._call("read_business_profile")
        return dict(data) if isinstance(data, Mapping) else {}

    def read_snapshot(self) -> dict[str, Any]:
        data = self._call("read_snapshot")
        return dict(data) if isinstance(data, Mapping) else {}

    @staticmethod
    def _epoch(value: Any) -> float:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str) and value:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
        return 0.0

    # Connector writes ------------------------------------------------
    def upsert_order(self, source: str, external_id: str, total: float,
                     items: list[dict], status: str = "completed",
                     customer_id: Optional[str] = None, currency: str = "USD",
                     created_at: Optional[float] = None) -> str:
        data = self._call("upsert_order", {
            "source": source, "external_id": external_id, "total": total,
            "items": items, "status": status, "customer_id": customer_id,
            "currency": currency, "created_at": created_at,
        })
        return str(data.get("id", "")) if isinstance(data, Mapping) else ""

    def upsert_product(self, source: str, external_id: str, name: str,
                       price: float, category: str = "", active: bool = True) -> str:
        data = self._call("upsert_product", {
            "source": source, "external_id": external_id, "name": name,
            "price": price, "category": category, "active": active,
        })
        return str(data.get("id", "")) if isinstance(data, Mapping) else ""

    def upsert_customer(self, source: str, external_id: str, name: str = "",
                        email: str = "", phone: str = "") -> str:
        data = self._call("upsert_customer", {
            "source": source, "external_id": external_id, "name": name,
            "email": email, "phone": phone,
        })
        return str(data.get("id", "")) if isinstance(data, Mapping) else ""

    def set_inventory(self, name: str, quantity: float, unit: str = "unit",
                      low_threshold: float = 5, product_id: Optional[str] = None) -> str:
        data = self._call("set_inventory", {
            "name": name, "quantity": quantity, "unit": unit,
            "low_threshold": low_threshold, "product_id": product_id,
        })
        return str(data.get("id", "")) if isinstance(data, Mapping) else ""

    # Existing metrics/anomaly API, now backed by canonical reads -------
    def orders_between(self, start: float, end: float) -> list[dict[str, Any]]:
        return self.read_orders(start=start, end=end)

    def low_stock(self) -> list[dict[str, Any]]:
        return self.read_inventory(low_only=True)

    def products(self, active_only: bool = True) -> list[dict[str, Any]]:
        return self.read_products(active_only=active_only)

    def customers(self) -> list[dict[str, Any]]:
        return self.read_customers()

    def count(self, resource: str) -> int:
        readers = {
            "orders": self.read_orders,
            "products": self.read_products,
            "customers": self.read_customers,
            "inventory": self.read_inventory,
            "reviews": self.read_reviews,
            "payments": self.read_payments,
        }
        reader = readers.get(resource)
        if reader is None:
            raise ValueError(f"unsupported business resource: {resource}")
        return len(reader())
