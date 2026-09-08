"""Toast POS Connector（第一阶段）。

真实 API：Toast Orders/Config/Stock API。沙箱数据用于无凭据全链路测试。
"""

from __future__ import annotations

from .base import Connector, SyncResult

SANDBOX_ORDERS = [
    {"guid": "toast_ord_2001", "total": 38.5, "businessDate": 1757000000.0,
     "checks": [{"selections": [
         {"item": {"name": "Boiled Fish"}, "quantity": 1},
         {"item": {"name": "Dan Dan Noodles"}, "quantity": 2}]}]},
]
SANDBOX_MENU = [
    {"guid": "toast_item_1", "name": "Boiled Fish", "price": 22.0, "menuGroup": "Chef Specials"},
]
SANDBOX_GUESTS = [
    {"guid": "toast_g_1", "firstName": "Carol", "lastName": "Wang", "email": "carol@example.com"},
]
SANDBOX_STOCK = [
    {"guid": "toast_item_1", "name": "Boiled Fish", "quantity": 18},
]


class ToastConnector(Connector):
    provider = "toast"
    api_base = "https://ws-api.toasttab.com"

    def oauth_authorize_url(self, redirect_uri: str, state: str) -> str:
        client_id = self.extra.get("client_id", "")
        return (f"https://ws-api.toasttab.com/oauth/authorize"
                f"?client_id={client_id}&response_type=code&state={state}&redirect_uri={redirect_uri}")

    def oauth_exchange(self, code: str, redirect_uri: str) -> dict:
        raise NotImplementedError("Toast partner token exchange — configure client credentials")

    def handle_webhook(self, event: dict) -> SyncResult:
        r = SyncResult(provider=self.provider)
        if event.get("eventType") in ("ORDER_CREATED", "ORDER_UPDATED"):
            order = event.get("order", {})
            self._write_order(order)
            r.orders = 1
        return r

    def _write_order(self, order: dict) -> str:
        items = []
        for check in order.get("checks", []):
            for sel in check.get("selections", []):
                items.append({"name": sel.get("item", {}).get("name", "?"),
                              "qty": int(sel.get("quantity", 1))})
        return self.dl.upsert_order(
            source="toast", external_id=order["guid"], total=float(order.get("total", 0)),
            items=items, created_at=float(order.get("businessDate", 0)) or None,
        )

    def sync_orders(self, since: float = 0) -> SyncResult:
        r = SyncResult(provider=self.provider)
        orders = SANDBOX_ORDERS if self.sandbox else self._request(
            "GET", f"/orders/v2/orders?businessDate={int(since)}").get("orders", [])
        for o in orders:
            self._write_order(o)
            r.orders += 1
        return r

    def sync_products(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        items = SANDBOX_MENU if self.sandbox else self._request("GET", "/config/v2/menuItems").get("items", [])
        for it in items:
            self.dl.upsert_product("toast", it["guid"], it.get("name", "?"),
                                   float(it.get("price", 0)), it.get("menuGroup", ""))
            r.products += 1
        return r

    def sync_customers(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        guests = SANDBOX_GUESTS if self.sandbox else self._request("GET", "/customers/v1/customers").get("customers", [])
        for g in guests:
            name = f"{g.get('firstName', '')} {g.get('lastName', '')}".strip()
            self.dl.upsert_customer("toast", g["guid"], name, g.get("email", ""))
            r.customers += 1
        return r

    def sync_inventory(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        stock = SANDBOX_STOCK if self.sandbox else self._request("GET", "/stock/v1/inventory").get("items", [])
        for s in stock:
            self.dl.set_inventory(s.get("name", s.get("guid", "?")), float(s.get("quantity", 0)))
            r.inventory += 1
        return r
