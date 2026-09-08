"""Clover POS Connector（第一阶段）。

真实 API：Clover v3 —— merchants/{mId}/orders|items|customers|inventory。
"""

from __future__ import annotations

from .base import Connector, SyncResult

SANDBOX_ORDERS = [
    {"id": "clv_ord_3001", "total": 2510, "createdTime": 1757007200000,
     "lineItems": {"elements": [{"name": "Kung Pao Chicken", "quantity": 1},
                                {"name": "Mapo Tofu", "quantity": 1}]}},
]
SANDBOX_ITEMS = [
    {"id": "clv_item_1", "name": "Kung Pao Chicken", "price": 1450, "category": "Sichuan Classics"},
]
SANDBOX_CUSTOMERS = [
    {"id": "clv_c_1", "firstName": "David", "lastName": "Lee", "email": "david@example.com"},
]
SANDBOX_STOCK = [
    {"item": {"id": "clv_item_1", "name": "Kung Pao Chicken"}, "quantity": 25},
]


class CloverConnector(Connector):
    provider = "clover"
    api_base = "https://api.clover.com/v3"

    @property
    def _merchant(self) -> str:
        return self.extra.get("merchant_id", "")

    def oauth_authorize_url(self, redirect_uri: str, state: str) -> str:
        client_id = self.extra.get("client_id", "")
        return (f"https://www.clover.com/oauth/v2/authorize"
                f"?client_id={client_id}&redirect_uri={redirect_uri}&state={state}")

    def oauth_exchange(self, code: str, redirect_uri: str) -> dict:
        import json
        import urllib.request
        url = (f"https://api.clover.com/oauth/v2/token"
               f"?client_id={self.extra.get('client_id', '')}"
               f"&client_secret={self.extra.get('client_secret', '')}&code={code}")
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    def handle_webhook(self, event: dict) -> SyncResult:
        r = SyncResult(provider=self.provider)
        for m in event.get("merchants", {}).get(self._merchant, []):
            if m.get("type") == "CREATE" and m.get("objectType") == "ORDER":
                self.sync_orders()
                r.orders += 1
        return r

    def sync_orders(self, since: float = 0) -> SyncResult:
        r = SyncResult(provider=self.provider)
        if self.sandbox:
            orders = SANDBOX_ORDERS
        else:
            resp = self._request("GET", f"/merchants/{self._merchant}/orders?expand=lineItems")
            orders = resp.get("elements", [])
        for o in orders:
            items = [{"name": li.get("name", "?"), "qty": int(li.get("quantity", 1))}
                     for li in o.get("lineItems", {}).get("elements", [])]
            self.dl.upsert_order(
                source="clover", external_id=o["id"], total=o.get("total", 0) / 100.0,
                items=items, created_at=(o.get("createdTime", 0) or 0) / 1000.0 or None,
            )
            r.orders += 1
        return r

    def sync_products(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        items = SANDBOX_ITEMS if self.sandbox else self._request(
            "GET", f"/merchants/{self._merchant}/items").get("elements", [])
        for it in items:
            self.dl.upsert_product("clover", it["id"], it.get("name", "?"),
                                   it.get("price", 0) / 100.0, it.get("category", ""))
            r.products += 1
        return r

    def sync_customers(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        customers = SANDBOX_CUSTOMERS if self.sandbox else self._request(
            "GET", f"/merchants/{self._merchant}/customers").get("elements", [])
        for c in customers:
            name = f"{c.get('firstName', '')} {c.get('lastName', '')}".strip()
            self.dl.upsert_customer("clover", c["id"], name, c.get("email", ""))
            r.customers += 1
        return r

    def sync_inventory(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        stock = SANDBOX_STOCK if self.sandbox else self._request(
            "GET", f"/merchants/{self._merchant}/inventory").get("elements", [])
        for s in stock:
            item = s.get("item", {})
            self.dl.set_inventory(item.get("name", item.get("id", "?")), float(s.get("quantity", 0)))
            r.inventory += 1
        return r
